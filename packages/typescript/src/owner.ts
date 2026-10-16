import {
  bytesToHex,
  encodeFunctionData,
  getAbiItem,
  isAddress,
  isAddressEqual,
  parseEventLogs,
  toEventSelector,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';

import {
  agentAccountAbi,
  agentAccountFactoryAbi,
  agentPolicyRegistryAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from './abi/index.js';
import type { ApiPosting } from './api/types.js';
import type { MercurifiClient } from './client.js';
import {
  InvalidInputError,
  MercurifiError,
  NetworkMismatchError,
  NotOwnerError,
} from './errors.js';
import type { AgentBook } from './networks.js';
import {
  DEFAULT_AGENT_PERMISSIONS,
  encodePermissions,
  SELL_RISK_WARNING,
  type Permission,
} from './permissions.js';
import {
  DEFAULT_AGENT_DAYS,
  DEFAULT_INCREASE_DELAY,
  MAX_AGENTS,
  DEFAULT_PERIOD_SECONDS,
  DEFAULT_POLICY,
  MAX_AGENT_DAYS,
  MAX_INCREASE_DELAY,
  MAX_PERIOD_SECONDS,
  MIN_PERIOD_SECONDS,
  QUEUE_TTL_SECONDS,
  mergePolicy,
  previewPolicyChange,
  validatePolicy,
  type ChainPolicy,
  type PolicyInput,
  type PolicyPreview,
} from './policy.js';
import { effectiveEta, listQueued, QUEUE_EVENTS, scanLogs, type QueuedChange } from './queue.js';
import {
  isAgentAccount,
  latestTimestamp,
  readAccountState,
  readAgent,
  readCeilings,
  readRegistry,
  type AccountState,
} from './reads.js';
import type { Signer } from './signers.js';
import { SocialSession } from './social.js';
import { resolveTokenAmount, resolveUsdc6, usdc6ToWei } from './units.js';

const DAY = 86_400;
const WITHDRAW_CHUNK = 100;
/** Pages of API actions read before falling back to the chain. */
const MAX_ACTION_PAGES = 50;
/** Slack on top of the delay: an agent whose expiry is not clearly after the ETA could never execute. */
const EXPIRY_MARGIN = 60;
const AGENT_ACTION_TOPIC = toEventSelector(
  getAbiItem({ abi: agentAccountAbi, name: 'AgentAction' }) as AbiEvent,
);

export interface CreateAccountParams {
  referrer?: Address;
  policy?: PolicyInput;
  periodSeconds?: number;
  increaseDelay?: number;
  firstAgent?: { address: Address; expiresInDays?: number; permissions?: readonly Permission[] };
  salt?: Hex;
}
export interface CreatedAccount {
  account: Address;
  salt: Hex;
  txHash: Hex;
  block: bigint;
}
/**
 * `cancelled`: executeQueued found the item voided by a pause or ownership change and only cleared it (nothing applied).
 * `eta` and `queuedId` come from the mined `*Queued` event. `summary` is one plain sentence; `warnings` list what the
 * caller should know (they are also sent to `onWarning`).
 */
export interface ChangeResult {
  outcome: 'none' | 'immediate' | 'queued' | 'mixed' | 'cancelled';
  queuedId: bigint | null;
  eta: number | null;
  txHash: Hex | null;
  block: bigint | null;
  summary: string;
  warnings: string[];
}
/** A policy preview plus the timing of its queued part. `etaIfQueued` and `expiresIfQueued` are null when nothing is queued. */
export interface PolicyPreviewFull extends PolicyPreview {
  ceilings: ChainPolicy;
  etaIfQueued: number | null;
  expiresIfQueued: number | null;
  /** One line per changed field: applies immediately, or queued with its executable window. */
  summary: string[];
}
export interface AgentGrant {
  expiresInDays?: number;
  permissions?: readonly Permission[];
}
export interface WithdrawParams {
  token?: Address;
  usdc?: string;
  usdc6?: bigint;
  all?: boolean;
  amount?: string;
  amountWei?: bigint;
}

const WITHDRAW_KEYS = new Set(['token', 'usdc', 'usdc6', 'all', 'amount', 'amountWei']);
/** Withdrawals always go to the owner; a recipient-like field from an untyped caller is refused, never ignored. */
const rejectUnknownKeys = (p: object): void => {
  for (const key of Object.keys(p)) {
    if (!WITHDRAW_KEYS.has(key)) {
      throw new InvalidInputError(
        key,
        `Unknown withdraw field ${key}. Withdrawals always go to the account owner; there is no recipient parameter.`,
      );
    }
  }
};

const none = (summary: string): ChangeResult => ({
  outcome: 'none',
  queuedId: null,
  eta: null,
  txHash: null,
  block: null,
  summary,
  warnings: [],
});
const randomSalt = (): Hex => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const expiryFrom = (now: bigint, days: number | undefined): number => {
  const d = days ?? DEFAULT_AGENT_DAYS;
  if (!Number.isInteger(d) || d < 1 || d > MAX_AGENT_DAYS)
    throw new InvalidInputError(
      'expiresInDays',
      `expiresInDays must be an integer in 1..${MAX_AGENT_DAYS}`,
    );
  return Number(now) + d * DAY;
};

const intIn = (field: string, v: number, min: number, max: number): number => {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new InvalidInputError(field, `${field} must be an integer in ${min}..${max}`);
  return v;
};

const notOwnerKey = (agent: Address, signer: Signer): void => {
  if (isAddressEqual(agent, signer.address)) {
    throw new InvalidInputError(
      'agent',
      'Use a separate agent key, not the owner wallet: the owner key must never sit on a trading server.',
    );
  }
};

const at = (t: number): string => new Date(t * 1000).toISOString();

interface ChangeCall {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** The function always queues; a receipt without a `*Queued` event is an error, not "immediate". */
  mustQueue?: boolean;
}

/**
 * Sends one call and builds the result from the mined receipt: the queue id and ETA come from the registry's `*Queued`
 * event, and executeQueued / acceptOwnership are judged by `QueuedExecuted` vs `QueuedCancelled` for that id.
 */
const sendChange = async (
  mf: MercurifiClient,
  signer: Signer,
  registry: Address,
  account: Address,
  call: ChangeCall,
  expected: Exclude<ChangeResult['outcome'], 'none' | 'cancelled'>,
  describe: (r: ChangeResult) => string,
  warnings: string[] = [],
): Promise<ChangeResult> => {
  const data = encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never);
  const sent = await mf.sender.send(signer, { to: call.to, data, label: call.functionName });
  const events = (
    parseEventLogs({
      abi: agentPolicyRegistryAbi,
      strict: false,
      logs: sent.receipt.logs.filter((l) => isAddressEqual(l.address, registry)),
    } as never) as unknown as { eventName: string; args: Record<string, unknown> }[]
  ).filter(
    (e) =>
      typeof e.args?.account === 'string' && isAddressEqual(e.args.account as Address, account),
  );
  const queuedEv = events.find((e) => (QUEUE_EVENTS as readonly string[]).includes(e.eventName));
  const targetId =
    call.functionName === 'executeQueued' || call.functionName === 'acceptOwnership'
      ? (call.args[1] as bigint)
      : null;
  const done = (outcome: ChangeResult['outcome']): ChangeResult => {
    const r: ChangeResult = {
      outcome,
      queuedId: null,
      eta: null,
      txHash: sent.hash,
      block: sent.receipt.blockNumber,
      summary: '',
      warnings,
    };
    if (queuedEv !== undefined && outcome !== 'cancelled') {
      r.queuedId = BigInt(queuedEv.args.id as bigint);
      r.eta = Number(queuedEv.args.eta);
    }
    r.summary = describe(r);
    for (const w of warnings) mf.warn(w);
    return r;
  };
  if (targetId !== null) {
    const cancelled = events.some(
      (e) => e.eventName === 'QueuedCancelled' && e.args.id === targetId,
    );
    const executed = events.some((e) => e.eventName === 'QueuedExecuted' && e.args.id === targetId);
    if (cancelled && call.functionName === 'executeQueued') return done('cancelled');
    if (!executed)
      throw new MercurifiError(
        'MISSING_EVENT',
        `The receipt of ${sent.hash} has no QueuedExecuted event for item ${targetId}; check the queue before retrying.`,
      );
    return done('immediate');
  }
  if (call.mustQueue === true && queuedEv === undefined) {
    throw new MercurifiError(
      'MISSING_EVENT',
      `The receipt of ${sent.hash} has no *Queued event, so the queue id is unknown; list the queue to find it.`,
    );
  }
  // Decided as queued before sending, but nothing was queued: the chain state moved since the check. Report it as
  // applied only when the receipt shows the account changing (e.g. PolicyApplied, IncreaseDelaySet); otherwise the
  // outcome is unknown and is never reported as a queue item without an id.
  if (expected === 'queued' && queuedEv === undefined) {
    if (events.length > 0) return done('immediate');
    throw new MercurifiError(
      'MISSING_EVENT',
      `The receipt of ${sent.hash} has no *Queued event and no event showing the change applied; the account changed since it was checked, so read its state or list the queue before retrying.`,
    );
  }
  return done(queuedEv === undefined && expected === 'mixed' ? 'immediate' : expected);
};

/** Owner-side actions, signed by the main wallet. */
export class OwnerClient {
  constructor(
    private readonly mf: MercurifiClient,
    readonly signer: Signer,
  ) {}

  /** One owner session per agent account (the sign-in names the account), built on first use. */
  #social = new Map<string, SocialSession>();

  #owner(account: Address): SocialSession {
    const api = this.mf.requireApi('social');
    if (!isAddress(account, { strict: false }))
      throw new InvalidInputError('account', 'account is not an address');
    const key = account.toLowerCase();
    let s = this.#social.get(key);
    if (s === undefined) {
      s = new SocialSession(
        api,
        {
          kind: 'owner',
          account,
          signer: this.signer.address,
          chainId: api.chainId,
          service: 'launch',
        },
        this.signer,
      );
      this.#social.set(key, s);
    }
    return s;
  }

  /** Whether the account's agents may write signals and notes. Public; needs no session. */
  async agentPosting(account: Address): Promise<ApiPosting> {
    return this.mf.requireApi('social').getPosting(account);
  }

  /** Turns posting on or off for the account's agents, signed in as the account's owner. */
  async setAgentPosting(account: Address, enabled: boolean): Promise<ApiPosting> {
    const api = this.mf.requireApi('social');
    return this.#owner(account).run((b) => api.setPosting(account, enabled, b));
  }

  /** Deletes one note the account's agents wrote, signed in as the account's owner. */
  async deleteAgentNote(account: Address, id: number): Promise<void> {
    const api = this.mf.requireApi('social');
    await this.#owner(account).run((b) => api.deleteNote(id, b));
  }

  /** Deletes every note the account's agents wrote; returns how many. Signed in as the account's owner. */
  async deleteAgentNotes(account: Address): Promise<{ deleted: number }> {
    const api = this.mf.requireApi('social');
    return this.#owner(account).run((b) => api.deleteAgentNotes(account, b));
  }

  /** Ends every owner session this client opened (best effort). */
  async signOut(): Promise<void> {
    const sessions = [...this.#social.values()];
    this.#social.clear();
    await Promise.all(sessions.map((s) => s.signOut()));
  }

  async createAccount(p: CreateAccountParams = {}): Promise<CreatedAccount> {
    const agents = this.mf.requireAgents();
    const client = this.mf.publicClient;
    const policy = mergePolicy(DEFAULT_POLICY, p.policy ?? {});
    validatePolicy(policy, await readCeilings(client, agents));
    const periodSeconds = intIn(
      'periodSeconds',
      p.periodSeconds ?? DEFAULT_PERIOD_SECONDS,
      MIN_PERIOD_SECONDS,
      MAX_PERIOD_SECONDS,
    );
    const increaseDelay = intIn(
      'increaseDelay',
      p.increaseDelay ?? DEFAULT_INCREASE_DELAY,
      0,
      MAX_INCREASE_DELAY,
    );
    const salt = p.salt ?? randomSalt();
    const predicted = (await client.readContract({
      address: agents.factory,
      abi: agentAccountFactoryAbi,
      functionName: 'predictAccount',
      args: [this.signer.address, salt],
    } as never)) as Address;
    const referrer = p.referrer ?? zeroAddress;
    if (isAddressEqual(referrer, predicted))
      throw new InvalidInputError('referrer', 'The referrer cannot be the account itself.');
    const code = await client.getCode({ address: predicted });
    if (code !== undefined && code !== '0x')
      throw new InvalidInputError(
        'salt',
        'An account already exists for this owner and salt; use another salt.',
      );

    let firstAgent: Address = zeroAddress;
    let firstAgentExpiresAt = 0;
    let firstAgentPermissions = 0;
    if (p.firstAgent !== undefined) {
      notOwnerKey(p.firstAgent.address, this.signer);
      if (isAddressEqual(p.firstAgent.address, predicted))
        throw new InvalidInputError('agent', 'The agent key cannot be the account itself.');
      const perms = p.firstAgent.permissions ?? DEFAULT_AGENT_PERMISSIONS;
      firstAgentPermissions = encodePermissions(perms);
      if (perms.includes('sell')) this.mf.warn(SELL_RISK_WARNING);
      firstAgent = p.firstAgent.address;
      firstAgentExpiresAt = expiryFrom(await latestTimestamp(client), p.firstAgent.expiresInDays);
    }

    const data = encodeFunctionData({
      abi: agentAccountFactoryAbi,
      functionName: 'createAccount',
      args: [
        salt,
        {
          referrer,
          policy,
          periodSeconds,
          increaseDelay,
          firstAgent,
          firstAgentExpiresAt,
          firstAgentPermissions,
        },
      ],
    } as never);
    const sent = await this.mf.sender.send(this.signer, {
      to: agents.factory,
      data,
      label: 'createAccount',
    });
    const created = parseEventLogs({
      abi: agentAccountFactoryAbi,
      eventName: 'AccountCreated',
      logs: sent.receipt.logs.filter((l) => isAddressEqual(l.address, agents.factory)),
    } as never) as unknown as { args: { account: Address } }[];
    if (created[0] === undefined)
      throw new MercurifiError(
        'MISSING_EVENT',
        `The receipt of ${sent.hash} has no AccountCreated event from the factory; do not assume the account exists.`,
      );
    const account = created[0].args.account;
    if (!isAddressEqual(account, predicted))
      throw new NetworkMismatchError(
        `The factory created ${account}, not the predicted ${predicted}.`,
      );
    return { account: predicted, salt, txHash: sent.hash, block: sent.receipt.blockNumber };
  }

  async manage(account: Address): Promise<AccountManager> {
    const agents = this.mf.requireAgents();
    if (!(await isAgentAccount(this.mf.publicClient, agents, account))) {
      throw new InvalidInputError(
        'account',
        `${account} is not a Mercurifi agent account on ${this.mf.network.name}`,
      );
    }
    const owner = await readRegistry<Address>(this.mf.publicClient, agents.registry, 'owner', [
      account,
    ]);
    if (!isAddressEqual(owner, this.signer.address))
      throw new NotOwnerError(`${this.signer.address} is not the owner of ${account}`);
    return new AccountManager(this.mf, this.signer, account, agents);
  }

  /** Sends native USDC to the account (its receive() has no logic). */
  async deposit(
    account: Address,
    amount: { usdc?: string; usdc6?: bigint },
  ): Promise<{ txHash: Hex }> {
    const agents = this.mf.requireAgents();
    if (!(await isAgentAccount(this.mf.publicClient, agents, account))) {
      throw new InvalidInputError(
        'account',
        `${account} is not a Mercurifi agent account on ${this.mf.network.name}`,
      );
    }
    const sent = await this.mf.sender.send(this.signer, {
      to: account,
      data: '0x',
      value: usdc6ToWei(resolveUsdc6(amount)),
      label: 'deposit',
    });
    return { txHash: sent.hash };
  }

  /** Sends native USDC to an agent key for gas; the agent pays its own gas. */
  async fundGas(
    agent: Address,
    amount: { usdc?: string; usdc6?: bigint },
  ): Promise<{ txHash: Hex }> {
    const sent = await this.mf.sender.send(this.signer, {
      to: agent,
      data: '0x',
      value: usdc6ToWei(resolveUsdc6(amount)),
      label: 'fundGas',
    });
    return { txHash: sent.hash };
  }

  /**
   * Called by the NEW owner from the queued transfer's ETA to 7 days after it: registry.acceptOwnership(account, id).
   * If the new owner is an active agent of the account, accepting revokes (and permanently retires) that agent entry.
   */
  async acceptOwnership(account: Address, id: bigint): Promise<ChangeResult> {
    const agents = this.mf.requireAgents();
    const warnings: string[] = [];
    const me = await readRegistry<{ active: boolean }>(
      this.mf.publicClient,
      agents.registry,
      'agent',
      [account, this.signer.address],
    );
    if (me.active)
      warnings.push(
        'This address is an active agent of the account: accepting ownership revokes and permanently retires it as an agent.',
      );
    return sendChange(
      this.mf,
      this.signer,
      agents.registry,
      account,
      {
        to: agents.registry,
        abi: agentPolicyRegistryAbi,
        functionName: 'acceptOwnership',
        args: [account, id],
      },
      'immediate',
      () => `Ownership of ${account} moved to ${this.signer.address} (queue item ${id}).`,
      warnings,
    );
  }

  /**
   * Ownership transfers queued TO the signer for `account`, with live status. Works for the incoming owner, who is not
   * yet the owner and so cannot `manage` the account. Complete one with `acceptOwnership(account, item.id)`.
   */
  async pendingOwnership(account: Address): Promise<QueuedChange[]> {
    const agents = this.mf.requireAgents();
    if (!(await isAgentAccount(this.mf.publicClient, agents, account))) {
      throw new InvalidInputError(
        'account',
        `${account} is not a Mercurifi agent account on ${this.mf.network.name}`,
      );
    }
    const all = await listQueued(this.mf.publicClient, agents, account, {
      api: !this.mf.settings.hasApiKey ? null : this.mf.api,
    });
    return all.filter(
      (q) => 'newOwner' in q.detail && isAddressEqual(q.detail.newOwner, this.signer.address),
    );
  }
}

/**
 * Management of one account by its owner. Narrowing is immediate, widening is queued. Configuration lives
 * in the policy registry (account passed first); funds stay in the account. Withdrawals always go to the owner.
 */
export class AccountManager {
  constructor(
    private readonly mf: MercurifiClient,
    private readonly signer: Signer,
    readonly account: Address,
    private readonly agents: AgentBook,
  ) {}

  state(): Promise<AccountState> {
    return readAccountState(this.mf.publicClient, this.agents, this.account);
  }

  /**
   * What `setPolicy(next)` would do, without sending anything: which fields apply immediately (narrowing), which are
   * queued (widening) and when the queued part becomes executable. A queued item runs from its effective ETA,
   * `queuedAt + max(delayAtQueue, current delay)`, for 7 days; raising the delay later postpones it.
   */
  async previewPolicy(next: PolicyInput): Promise<PolicyPreviewFull> {
    const [state, ceilings, now] = await Promise.all([
      this.state(),
      readCeilings(this.mf.publicClient, this.agents),
      latestTimestamp(this.mf.publicClient),
    ]);
    const target = mergePolicy(state.policy, next);
    validatePolicy(target, ceilings);
    const base = previewPolicyChange(state.policy, target);
    const etaIfQueued = effectiveEta(Number(now), state.increaseDelay, state.increaseDelay);
    const expiresIfQueued = etaIfQueued + QUEUE_TTL_SECONDS;
    const at = (t: number): string => new Date(t * 1000).toISOString();
    const summary = base.changes.map((c) =>
      c.direction === 'narrow'
        ? `${c.field}: ${c.current} -> ${c.next} applies immediately`
        : `${c.field}: ${c.current} -> ${c.next} is queued; executable from ${at(etaIfQueued)} until ${at(expiresIfQueued)}`,
    );
    return {
      ...base,
      ceilings,
      etaIfQueued: base.queued.length > 0 ? etaIfQueued : null,
      expiresIfQueued: base.queued.length > 0 ? expiresIfQueued : null,
      summary,
    };
  }

  async setPolicy(next: PolicyInput): Promise<ChangeResult & { preview: PolicyPreviewFull }> {
    const preview = await this.previewPolicy(next);
    if (preview.outcome === 'none')
      return { ...none('The policy already matches; nothing to change.'), preview };
    const warnings =
      preview.queued.length > 0
        ? [
            `Widened fields (${preview.queued.join(', ')}) are queued, not applied: they can be executed from ${at(preview.etaIfQueued!)} and for 7 days after.`,
          ]
        : [];
    const r = await this.registryWrite(
      'setPolicy',
      [preview.target],
      preview.outcome,
      (x) =>
        x.outcome === 'immediate'
          ? `Policy tightened now (${preview.immediate.join(', ')}).`
          : `${preview.immediate.length > 0 ? `Tightened now: ${preview.immediate.join(', ')}. ` : ''}Queued as item ${x.queuedId}: ${preview.queued.join(', ')}, executable from ${at(x.eta ?? 0)}.`,
      warnings,
    );
    return { ...r, preview };
  }

  /** Reads the chain time and delay a queued agent change is judged against. */
  private async timeAndDelay(): Promise<{ now: number; delay: number }> {
    const [now, delay] = await Promise.all([
      latestTimestamp(this.mf.publicClient),
      readRegistry<number>(this.mf.publicClient, this.agents.registry, 'increaseDelay', [
        this.account,
      ]),
    ]);
    return { now: Number(now), delay: Number(delay) };
  }

  /** Adds the active-agent count (for the agent-limit warning) to timeAndDelay. */
  private async agentContext(): Promise<{ now: number; delay: number; count: number }> {
    const [ctx, count] = await Promise.all([
      this.timeAndDelay(),
      readRegistry<number>(this.mf.publicClient, this.agents.registry, 'activeAgentCount', [
        this.account,
      ]),
    ]);
    return { ...ctx, count: Number(count) };
  }

  /** A queued agent item with `expiresAt` not after its ETA reverts AgentExpiryOutOfRange for its whole window. */
  private checkExpiryReachable(expiresAt: number, ctx: { now: number; delay: number }): void {
    if (expiresAt <= ctx.now + ctx.delay + EXPIRY_MARGIN) {
      throw new InvalidInputError(
        'expiresInDays',
        `This change is queued for ${ctx.delay} s (until ${at(ctx.now + ctx.delay)}) but the agent would expire at ${at(expiresAt)}, so it could never be executed. Choose a longer expiry.`,
      );
    }
  }

  async addAgent(agent: Address, grant: AgentGrant = {}): Promise<ChangeResult> {
    notOwnerKey(agent, this.signer);
    const perms = grant.permissions ?? DEFAULT_AGENT_PERMISSIONS;
    const bits = encodePermissions(perms);
    const ctx = await this.agentContext();
    const expiresAt = expiryFrom(BigInt(ctx.now), grant.expiresInDays);
    this.checkExpiryReachable(expiresAt, ctx);
    const warnings = this.agentWarnings(perms, ctx.count);
    return this.registryWrite(
      'addAgent',
      [agent, expiresAt, bits],
      'queued',
      (r) =>
        `Agent ${agent} is queued as item ${r.queuedId}; it can be activated from ${at(r.eta ?? 0)} (executeQueued), then runs until ${at(expiresAt)}.`,
      warnings,
      true,
    );
  }

  private agentWarnings(
    perms: readonly Permission[],
    activeCount: number,
    hadSell = false,
  ): string[] {
    const w: string[] = [];
    if (perms.includes('sell') && !hadSell) w.push(SELL_RISK_WARNING);
    if (activeCount >= MAX_AGENTS) {
      w.push(
        `The account already has ${activeCount} active agents (the limit is ${MAX_AGENTS}); executing this add reverts TooManyAgents unless one is revoked first.`,
      );
    }
    return w;
  }

  async setAgent(agent: Address, grant: AgentGrant): Promise<ChangeResult> {
    const ctx = await this.timeAndDelay();
    const current = await readAgent(
      this.mf.publicClient,
      this.agents,
      this.account,
      agent,
      BigInt(ctx.now),
    );
    if (!current.active)
      throw new InvalidInputError('agent', `${agent} is not an active agent; use addAgent`);
    const perms = grant.permissions ?? current.permissions;
    const bits = encodePermissions(perms);
    const expiresAt =
      grant.expiresInDays === undefined
        ? current.expiresAt
        : expiryFrom(BigInt(ctx.now), grant.expiresInDays);
    const widening = expiresAt > current.expiresAt || (bits & ~current.permissionBits) !== 0;
    if (widening) this.checkExpiryReachable(expiresAt, ctx);
    const warnings = widening
      ? [
          ...this.agentWarnings(perms, 0, current.permissions.includes('sell')),
          `Widening an agent (longer expiry or more permissions) is queued for ${ctx.delay} s; the old terms stay in force until it is executed.`,
        ]
      : [];
    return this.registryWrite(
      'setAgent',
      [agent, expiresAt, bits],
      widening ? 'queued' : 'immediate',
      (r) =>
        r.outcome === 'queued'
          ? `Wider terms for ${agent} are queued as item ${r.queuedId}; executable from ${at(r.eta ?? 0)}.`
          : `Narrower terms for ${agent} applied now.`,
      warnings,
    );
  }

  /** Retires `oldAgent` now and queues `newAgent` under the delay rule. */
  async rotateAgent(
    oldAgent: Address,
    newAgent: Address,
    grant: AgentGrant = {},
  ): Promise<ChangeResult> {
    notOwnerKey(newAgent, this.signer);
    const perms = grant.permissions ?? DEFAULT_AGENT_PERMISSIONS;
    const bits = encodePermissions(perms);
    const ctx = await this.agentContext();
    const expiresAt = expiryFrom(BigInt(ctx.now), grant.expiresInDays);
    this.checkExpiryReachable(expiresAt, ctx);
    const oldActive = (
      await readAgent(this.mf.publicClient, this.agents, this.account, oldAgent, BigInt(ctx.now))
    ).active;
    const warnings = [
      ...this.agentWarnings(perms, ctx.count - (oldActive ? 1 : 0)),
      `${oldAgent} is retired at once and can never be an agent of this account again; ${newAgent} starts only when its queued item is executed.`,
    ];
    return this.registryWrite(
      'rotateAgent',
      [oldAgent, newAgent, expiresAt, bits],
      'mixed',
      (r) =>
        `${oldAgent} was revoked now; ${newAgent} is queued as item ${r.queuedId}, executable from ${at(r.eta ?? 0)}.`,
      warnings,
      true,
    );
  }

  /** Retires the address forever (revoking it if active); its queued items can no longer execute. */
  revokeAgent(agent: Address): Promise<ChangeResult> {
    return this.registryWrite(
      'revokeAgent',
      [agent],
      'immediate',
      () => `${agent} is revoked now and retired for good.`,
    );
  }

  /** Adding is queued (and skipped when already allowed); removing is immediate and makes pending additions stale. */
  async setTokenAllowed(token: Address, allowed: boolean): Promise<ChangeResult> {
    if (allowed) {
      if (!(await this.isLaunchToken(token)))
        throw new InvalidInputError(
          'token',
          `${token} is not a Mercurifi Launch token on ${this.mf.network.name}`,
        );
      if (
        await readRegistry<boolean>(this.mf.publicClient, this.agents.registry, 'tokenAllowed', [
          this.account,
          token,
        ])
      )
        return none(`${token} is already on the allowlist.`);
    }
    const warnings = allowed
      ? [
          'Allowing a token is queued; with allowlistOnly set, agents cannot trade it until the item is executed.',
        ]
      : [];
    return this.registryWrite(
      'setTokenAllowed',
      [token, allowed],
      allowed ? 'queued' : 'immediate',
      (r) =>
        allowed
          ? `Allowing ${token} is queued as item ${r.queuedId}, executable from ${at(r.eta ?? 0)}.`
          : `${token} removed from the allowlist now.`,
      warnings,
    );
  }

  async setIncreaseDelay(seconds: number): Promise<ChangeResult> {
    intIn('increaseDelay', seconds, 0, MAX_INCREASE_DELAY);
    const { increaseDelay } = await this.state();
    if (seconds === increaseDelay) return none(`The increase delay is already ${seconds} s.`);
    const raising = seconds > increaseDelay;
    const warnings = raising
      ? [
          'Raising the delay also postpones every item already queued: its ETA becomes queuedAt + the new delay. That can push a queued agent item past its own expiry, so it can never be executed; check the queue and requeue such items.',
        ]
      : [
          `Lowering the delay is itself queued for the current ${increaseDelay} s and weakens the protection against a compromised owner key; it applies only when executed.`,
        ];
    return this.registryWrite(
      'setIncreaseDelay',
      [seconds],
      raising ? 'immediate' : 'queued',
      (r) =>
        raising
          ? `The increase delay is now ${seconds} s.`
          : `Lowering the delay to ${seconds} s is queued as item ${r.queuedId}, executable from ${at(r.eta ?? 0)}.`,
      warnings,
    );
  }

  /** Queues the transfer; the new owner completes it with OwnerClient.acceptOwnership after the delay. */
  transferOwnership(newOwner: Address): Promise<ChangeResult> {
    const warnings = [
      `Ownership moves only when ${newOwner} calls acceptOwnership (between the ETA and 7 days after it); you stay owner until then and can cancelQueued.`,
      'Accepting revokes and permanently retires the new owner as an agent of this account, if it is one. Check the address: ownership controls all funds.',
    ];
    return this.registryWrite(
      'transferOwnership',
      [newOwner],
      'queued',
      (r) =>
        `Transfer to ${newOwner} is queued as item ${r.queuedId}; ${newOwner} can accept from ${at(r.eta ?? 0)}.`,
      warnings,
      true,
    );
  }

  /** Queued changes, from the API when a key is configured (verified on chain), else from bounded log scans. */
  listQueued(opts: { fromBlock?: bigint } = {}): Promise<QueuedChange[]> {
    return listQueued(this.mf.publicClient, this.agents, this.account, {
      ...opts,
      api: !this.mf.settings.hasApiKey ? null : this.mf.api,
    });
  }

  /**
   * Runs a queued item once its ETA has passed. The outcome is `cancelled` when the registry only cleared an item voided
   * by a pause or ownership change. Ownership items are completed by the new owner (`acceptOwnership`), never here.
   */
  async executeQueued(id: bigint): Promise<ChangeResult> {
    const [kind] = await readRegistry<readonly [number, number, bigint, bigint, Hex]>(
      this.mf.publicClient,
      this.agents.registry,
      'queued',
      [this.account, id],
    );
    if (Number(kind) === 0)
      throw new InvalidInputError(
        'id',
        `There is no queued item ${id} for this account (already executed, cancelled or never queued).`,
      );
    if (Number(kind) === 6) {
      throw new InvalidInputError(
        'id',
        `Item ${id} is an ownership transfer: executeQueued reverts AcceptRequired. The new owner completes it with acceptOwnership; you can only cancelQueued it.`,
      );
    }
    return this.registryWrite('executeQueued', [id], 'immediate', (r) =>
      r.outcome === 'cancelled'
        ? `Item ${id} was voided by a pause or ownership change; it was cleared and nothing was applied.`
        : `Queued item ${id} executed.`,
    );
  }

  cancelQueued(id: bigint): Promise<ChangeResult> {
    return this.registryWrite(
      'cancelQueued',
      [id],
      'immediate',
      () => `Queued item ${id} cancelled.`,
    );
  }

  /** Immediate both ways; pausing also voids every queued item. */
  pauseAgents(paused: boolean): Promise<ChangeResult> {
    return this.registryWrite(
      'pauseAgents',
      [paused],
      'immediate',
      () => (paused ? 'Agents paused; every queued item is voided.' : 'Agents resumed.'),
      paused
        ? [
            'Pausing voids every queued item (including pending ownership transfers); executing them only clears them.',
          ]
        : [],
    );
  }

  /**
   * To the owner only, from the account (there is no recipient parameter). Native USDC: exactly one of `usdc`, `usdc6`
   * or `all`. A token (Launch or any other ERC-20 that ended up in the account): `token` with exactly one of `amountWei`,
   * `all`, or (Launch tokens only, 18 decimals) `amount`. Other tokens never get a guessed decimal scale.
   */
  async withdraw(p: WithdrawParams): Promise<ChangeResult> {
    rejectUnknownKeys(p);
    const native = p.token === undefined || isAddressEqual(p.token, zeroAddress);
    if (!native && isAddressEqual(p.token!, this.mf.network.launch.usdc)) {
      throw new InvalidInputError(
        'token',
        'Withdraw USDC as native (omit token): the ERC-20 view at 0x3600…0000 is the same balance.',
      );
    }
    const given = (['usdc', 'usdc6', 'amount', 'amountWei'] as const).filter(
      (k) => p[k] !== undefined,
    ) as string[];
    if (p.all === true) given.push('all');
    if (given.length !== 1) {
      throw new InvalidInputError(
        'amount',
        given.length === 0
          ? 'Say how much to withdraw: usdc, usdc6 or all (native), or amountWei, amount or all (token).'
          : `Use exactly one amount field; got ${given.join(', ')}.`,
      );
    }
    const field = given[0]!;
    if (native && (field === 'amount' || field === 'amountWei'))
      throw new InvalidInputError(
        field,
        `${field} is for a token; for native USDC use usdc, usdc6 or all.`,
      );
    if (!native && (field === 'usdc' || field === 'usdc6'))
      throw new InvalidInputError(
        field,
        `${field} is for native USDC; for a token use amountWei, amount (Launch tokens) or all.`,
      );
    let token: Address = zeroAddress;
    let amount: bigint;
    if (native) {
      amount =
        field === 'all'
          ? await this.mf.publicClient.getBalance({ address: this.account })
          : usdc6ToWei(resolveUsdc6(p));
    } else {
      token = p.token!;
      if (field === 'amount' && !(await this.isLaunchToken(token))) {
        throw new InvalidInputError(
          'amount',
          "amount assumes 18 decimals, which only Launch tokens are known to have. For other tokens pass amountWei in the token's base units, or all.",
        );
      }
      const r = field === 'all' ? 'all' : resolveTokenAmount(p);
      amount = r === 'all' ? await this.balanceOf(token) : r;
    }
    if (amount === 0n) throw new InvalidInputError('amount', 'Nothing to withdraw.');
    return this.accountWrite(
      'withdraw',
      [token, amount],
      () =>
        `Withdrew ${field === 'all' ? 'the full balance' : 'the amount'} of ${native ? 'native USDC' : token} to the owner.`,
    );
  }

  /**
   * Full balances of the listed tokens (any ERC-20; zero balances are skipped), then native USDC, to the owner. Native
   * goes in its own transaction, sent first, so a token that fails cannot block the USDC exit; tokens go in chunks of
   * 100. Without `tokens`, Launch tokens are discovered from the account's own AgentAction logs, merged with the API's
   * action history when there is an API (the API alone is never trusted to list them). Nothing
   * is sent when there is nothing to move.
   */
  async withdrawMany(
    tokens?: readonly Address[],
    opts: { fromBlock?: bigint } = {},
  ): Promise<{ txHashes: Hex[]; tokens: Address[] }> {
    const candidates =
      tokens ?? (await this.launchTokensOnly(await this.tokensTouched(opts.fromBlock)));
    const seen = new Set<string>();
    const held: Address[] = [];
    for (const t of candidates) {
      const key = t.toLowerCase();
      if (
        seen.has(key) ||
        isAddressEqual(t, zeroAddress) ||
        isAddressEqual(t, this.mf.network.launch.usdc)
      )
        continue;
      seen.add(key);
      if ((await this.balanceOf(t)) > 0n) held.push(t);
    }
    const txHashes: Hex[] = [];
    if ((await this.mf.publicClient.getBalance({ address: this.account })) > 0n) {
      const r = await this.accountWrite(
        'withdrawMany',
        [[zeroAddress]],
        () => 'Withdrew native USDC to the owner.',
      );
      if (r.txHash !== null) txHashes.push(r.txHash);
    }
    for (let i = 0; i < held.length; i += WITHDRAW_CHUNK) {
      const r = await this.accountWrite(
        'withdrawMany',
        [held.slice(i, i + WITHDRAW_CHUNK)],
        () => 'Withdrew tokens to the owner.',
      );
      if (r.txHash !== null) txHashes.push(r.txHash);
    }
    return { txHashes, tokens: held };
  }

  /**
   * Every token the account traded: the API's action history (when there is an API; a hint only) merged with the
   * account's own AgentAction logs, which are always scanned, so an API that omits a token cannot hide it.
   */
  private async tokensTouched(fromBlock?: bigint): Promise<Address[]> {
    const out: Address[] = [];
    const api = this.mf.api;
    if (api !== null) {
      try {
        let cursor: string | undefined;
        let pages = 0;
        do {
          if (pages++ >= MAX_ACTION_PAGES) break;
          const page = await api.listActions(this.account, cursor);
          out.push(
            ...page.items.map((a) => a.token).filter((t): t is Address => typeof t === 'string'),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } catch {
        // the chain scan below still finds every token
      }
    }
    const logs = await scanLogs(
      this.mf.publicClient,
      { address: this.account, topics: [AGENT_ACTION_TOPIC] },
      fromBlock ?? this.agents.deployBlock,
    );
    out.push(
      ...(
        parseEventLogs({
          abi: agentAccountAbi,
          eventName: 'AgentAction',
          logs,
        } as never) as unknown as { args: { token: Address } }[]
      ).map((l) => l.args.token),
    );
    return out;
  }

  private async isLaunchToken(token: Address): Promise<boolean> {
    const curve = (await this.mf.publicClient.readContract({
      address: this.mf.network.launch.factory,
      abi: launchFactoryAbi,
      functionName: 'curveOf',
      args: [token],
    } as never)) as Address;
    return !isAddressEqual(curve, zeroAddress);
  }

  /** Discovered tokens come from an API or logs; only Launch tokens (known to the Launch factory) are ever asked to transfer. */
  private async launchTokensOnly(tokens: readonly Address[]): Promise<Address[]> {
    const out: Address[] = [];
    for (const t of new Set(tokens.map((x) => x.toLowerCase() as Address))) {
      if (await this.isLaunchToken(t)) out.push(t);
    }
    return out;
  }

  private balanceOf(token: Address): Promise<bigint> {
    return this.mf.publicClient.readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: 'balanceOf',
      args: [this.account],
    } as never) as Promise<bigint>;
  }

  /** A registry owner function: sent to the registry with the account as its first argument. */
  private registryWrite(
    functionName: string,
    args: readonly unknown[],
    expected: Exclude<ChangeResult['outcome'], 'none' | 'cancelled'>,
    describe: (r: ChangeResult) => string,
    warnings: string[] = [],
    mustQueue = false,
  ): Promise<ChangeResult> {
    return sendChange(
      this.mf,
      this.signer,
      this.agents.registry,
      this.account,
      {
        to: this.agents.registry,
        abi: agentPolicyRegistryAbi,
        functionName,
        args: [this.account, ...args],
        mustQueue,
      },
      expected,
      describe,
      warnings,
    );
  }

  /** An account function (withdrawals): sent to the account itself. */
  private accountWrite(
    functionName: string,
    args: readonly unknown[],
    describe: (r: ChangeResult) => string,
  ): Promise<ChangeResult> {
    return sendChange(
      this.mf,
      this.signer,
      this.agents.registry,
      this.account,
      { to: this.account, abi: agentAccountAbi, functionName, args },
      'immediate',
      describe,
    );
  }
}
