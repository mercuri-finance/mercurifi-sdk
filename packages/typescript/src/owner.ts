import {
  bytesToHex, decodeFunctionResult, encodeFunctionData, getAbiItem, isAddressEqual, parseEventLogs, toEventSelector, zeroAddress,
  type Abi, type AbiEvent, type Address, type Hex,
} from 'viem';

import { agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi, launchFactoryAbi, launchTokenAbi } from './abi/index.js';
import type { MercurifiClient } from './client.js';
import { InvalidInputError, NetworkMismatchError, NotOwnerError } from './errors.js';
import type { AgentBook } from './networks.js';
import { DEFAULT_AGENT_PERMISSIONS, encodePermissions, SELL_RISK_WARNING, type Permission } from './permissions.js';
import {
  DEFAULT_AGENT_DAYS, DEFAULT_INCREASE_DELAY, DEFAULT_PERIOD_SECONDS, DEFAULT_POLICY, MAX_AGENT_DAYS, MAX_INCREASE_DELAY,
  MAX_PERIOD_SECONDS, MIN_PERIOD_SECONDS, QUEUE_TTL_SECONDS, mergePolicy, previewPolicyChange, validatePolicy,
  type ChainPolicy, type PolicyInput, type PolicyPreview,
} from './policy.js';
import { effectiveEta, listQueued, scanLogs, type QueuedChange } from './queue.js';
import { isAgentAccount, latestTimestamp, readAccountState, readAgent, readCeilings, readRegistry, type AccountState } from './reads.js';
import type { Signer } from './signers.js';
import type { SentTx } from './tx.js';
import { resolveTokenAmount, resolveUsdc6, usdc6ToWei } from './units.js';

const DAY = 86_400;
const WITHDRAW_CHUNK = 100;
const AGENT_ACTION_TOPIC = toEventSelector(getAbiItem({ abi: agentAccountAbi, name: 'AgentAction' }) as AbiEvent);

export interface CreateAccountParams {
  referrer?: Address;
  policy?: PolicyInput;
  periodSeconds?: number;
  increaseDelay?: number;
  firstAgent?: { address: Address; expiresInDays?: number; permissions?: readonly Permission[] };
  salt?: Hex;
}
export interface CreatedAccount { account: Address; salt: Hex; txHash: Hex; block: bigint }
export interface ChangeResult { outcome: 'none' | 'immediate' | 'queued' | 'mixed'; queuedId: bigint | null; eta: number | null; txHash: Hex | null; block: bigint | null }
/** A policy preview plus the timing of its queued part. `etaIfQueued` and `expiresIfQueued` are null when nothing is queued. */
export interface PolicyPreviewFull extends PolicyPreview {
  ceilings: ChainPolicy;
  etaIfQueued: number | null;
  expiresIfQueued: number | null;
  /** One line per changed field: applies immediately, or queued with its executable window. */
  summary: string[];
}
export interface AgentGrant { expiresInDays?: number; permissions?: readonly Permission[] }
export interface WithdrawParams { token?: Address; usdc?: string; usdc6?: bigint; all?: boolean; amount?: string; amountWei?: bigint }

const WITHDRAW_KEYS = new Set(['token', 'usdc', 'usdc6', 'all', 'amount', 'amountWei']);
/** Withdrawals always go to the owner; a recipient-like field from an untyped caller is refused, never ignored. */
const rejectUnknownKeys = (p: object): void => {
  for (const key of Object.keys(p)) {
    if (!WITHDRAW_KEYS.has(key)) {
      throw new InvalidInputError(key, `Unknown withdraw field ${key}. Withdrawals always go to the account owner; there is no recipient parameter.`);
    }
  }
};

const NONE: ChangeResult = { outcome: 'none', queuedId: null, eta: null, txHash: null, block: null };
const randomSalt = (): Hex => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const expiryFrom = (now: bigint, days: number | undefined): number => {
  const d = days ?? DEFAULT_AGENT_DAYS;
  if (!Number.isInteger(d) || d < 1 || d > MAX_AGENT_DAYS) throw new InvalidInputError('expiresInDays', `expiresInDays must be an integer in 1..${MAX_AGENT_DAYS}`);
  return Number(now) + d * DAY;
};

const intIn = (field: string, v: number, min: number, max: number): number => {
  if (!Number.isInteger(v) || v < min || v > max) throw new InvalidInputError(field, `${field} must be an integer in ${min}..${max}`);
  return v;
};

const notOwnerKey = (agent: Address, signer: Signer): void => {
  if (isAddressEqual(agent, signer.address)) {
    throw new InvalidInputError('agent', 'Use a separate agent key, not the owner wallet: the owner key must never sit on a trading server.');
  }
};

/** Sends one call and reads back the queue id the function returned in its preflight (0 = applied immediately). */
const sendChange = async (
  mf: MercurifiClient, signer: Signer, registry: Address, account: Address,
  call: { to: Address; abi: Abi; functionName: string; args: readonly unknown[] }, expected: ChangeResult['outcome'],
): Promise<ChangeResult> => {
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
  const sent = await mf.sender.send(signer, { to: call.to, data, label: call.functionName });
  const queuedId = returnedId(call.abi, call.functionName, sent);
  const eta = queuedId === null
    ? null
    : Number((await readRegistry<readonly [number, number, bigint, bigint, Hex]>(mf.publicClient, registry, 'queued', [account, queuedId]))[1]);
  const outcome = queuedId === null && (expected === 'queued' || expected === 'mixed') ? 'immediate' : expected;
  return { outcome, queuedId, eta, txHash: sent.hash, block: sent.receipt.blockNumber };
};

const returnedId = (abi: Abi, functionName: string, sent: SentTx): bigint | null => {
  const item = abi.find((i) => i.type === 'function' && i.name === functionName) as { outputs?: readonly unknown[] } | undefined;
  if (item?.outputs === undefined || item.outputs.length === 0 || sent.preflightData === '0x') return null;
  const id = decodeFunctionResult({ abi, functionName, data: sent.preflightData } as never) as unknown;
  return typeof id === 'bigint' && id > 0n ? id : null;
};

/** Owner-side actions, signed by the main wallet. */
export class OwnerClient {
  constructor(private readonly mf: MercurifiClient, readonly signer: Signer) {}

  async createAccount(p: CreateAccountParams = {}): Promise<CreatedAccount> {
    const agents = this.mf.requireAgents();
    const client = this.mf.publicClient;
    const policy = mergePolicy(DEFAULT_POLICY, p.policy ?? {});
    validatePolicy(policy, await readCeilings(client, agents));
    const periodSeconds = intIn('periodSeconds', p.periodSeconds ?? DEFAULT_PERIOD_SECONDS, MIN_PERIOD_SECONDS, MAX_PERIOD_SECONDS);
    const increaseDelay = intIn('increaseDelay', p.increaseDelay ?? DEFAULT_INCREASE_DELAY, 0, MAX_INCREASE_DELAY);
    const salt = p.salt ?? randomSalt();
    const predicted = (await client.readContract({
      address: agents.factory, abi: agentAccountFactoryAbi, functionName: 'predictAccount', args: [this.signer.address, salt],
    } as never)) as Address;
    const referrer = p.referrer ?? zeroAddress;
    if (isAddressEqual(referrer, predicted)) throw new InvalidInputError('referrer', 'The referrer cannot be the account itself.');
    const code = await client.getCode({ address: predicted });
    if (code !== undefined && code !== '0x') throw new InvalidInputError('salt', 'An account already exists for this owner and salt; use another salt.');

    let firstAgent: Address = zeroAddress;
    let firstAgentExpiresAt = 0;
    let firstAgentPermissions = 0;
    if (p.firstAgent !== undefined) {
      notOwnerKey(p.firstAgent.address, this.signer);
      if (isAddressEqual(p.firstAgent.address, predicted)) throw new InvalidInputError('agent', 'The agent key cannot be the account itself.');
      const perms = p.firstAgent.permissions ?? DEFAULT_AGENT_PERMISSIONS;
      firstAgentPermissions = encodePermissions(perms);
      if (perms.includes('sell')) this.mf.warn(SELL_RISK_WARNING);
      firstAgent = p.firstAgent.address;
      firstAgentExpiresAt = expiryFrom(await latestTimestamp(client), p.firstAgent.expiresInDays);
    }

    const data = encodeFunctionData({
      abi: agentAccountFactoryAbi, functionName: 'createAccount',
      args: [salt, { referrer, policy, periodSeconds, increaseDelay, firstAgent, firstAgentExpiresAt, firstAgentPermissions }],
    } as never);
    const sent = await this.mf.sender.send(this.signer, { to: agents.factory, data, label: 'createAccount' });
    const created = parseEventLogs({
      abi: agentAccountFactoryAbi, eventName: 'AccountCreated', logs: sent.receipt.logs.filter((l) => isAddressEqual(l.address, agents.factory)),
    } as never) as unknown as { args: { account: Address } }[];
    const account = created[0]?.args.account ?? predicted;
    if (!isAddressEqual(account, predicted)) throw new NetworkMismatchError(`The factory created ${account}, not the predicted ${predicted}.`);
    return { account: predicted, salt, txHash: sent.hash, block: sent.receipt.blockNumber };
  }

  async manage(account: Address): Promise<AccountManager> {
    const agents = this.mf.requireAgents();
    if (!(await isAgentAccount(this.mf.publicClient, agents, account))) {
      throw new InvalidInputError('account', `${account} is not a Mercurifi agent account on ${this.mf.network.name}`);
    }
    const owner = await readRegistry<Address>(this.mf.publicClient, agents.registry, 'owner', [account]);
    if (!isAddressEqual(owner, this.signer.address)) throw new NotOwnerError(`${this.signer.address} is not the owner of ${account}`);
    return new AccountManager(this.mf, this.signer, account, agents);
  }

  /** Sends native USDC to the account (its receive() has no logic). */
  async deposit(account: Address, amount: { usdc?: string; usdc6?: bigint }): Promise<{ txHash: Hex }> {
    const agents = this.mf.requireAgents();
    if (!(await isAgentAccount(this.mf.publicClient, agents, account))) {
      throw new InvalidInputError('account', `${account} is not a Mercurifi agent account on ${this.mf.network.name}`);
    }
    const sent = await this.mf.sender.send(this.signer, { to: account, data: '0x', value: usdc6ToWei(resolveUsdc6(amount)), label: 'deposit' });
    return { txHash: sent.hash };
  }

  /** Sends native USDC to an agent key for gas; the agent pays its own gas. */
  async fundGas(agent: Address, amount: { usdc?: string; usdc6?: bigint }): Promise<{ txHash: Hex }> {
    const sent = await this.mf.sender.send(this.signer, { to: agent, data: '0x', value: usdc6ToWei(resolveUsdc6(amount)), label: 'fundGas' });
    return { txHash: sent.hash };
  }

  /** Called by the NEW owner from the queued transfer's ETA to 7 days after it: registry.acceptOwnership(account, id). */
  async acceptOwnership(account: Address, id: bigint): Promise<ChangeResult> {
    const agents = this.mf.requireAgents();
    return sendChange(this.mf, this.signer, agents.registry, account,
      { to: agents.registry, abi: agentPolicyRegistryAbi, functionName: 'acceptOwnership', args: [account, id] }, 'immediate');
  }
}

/**
 * Management of one account by its owner. Narrowing is immediate, widening is queued. Configuration lives
 * in the policy registry (account passed first); funds stay in the account.
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
    const [state, ceilings, now] = await Promise.all([this.state(), readCeilings(this.mf.publicClient, this.agents), latestTimestamp(this.mf.publicClient)]);
    const target = mergePolicy(state.policy, next);
    validatePolicy(target, ceilings);
    const base = previewPolicyChange(state.policy, target);
    const etaIfQueued = effectiveEta(Number(now), state.increaseDelay, state.increaseDelay);
    const expiresIfQueued = etaIfQueued + QUEUE_TTL_SECONDS;
    const at = (t: number): string => new Date(t * 1000).toISOString();
    const summary = base.changes.map((c) => c.direction === 'narrow'
      ? `${c.field}: ${c.current} -> ${c.next} applies immediately`
      : `${c.field}: ${c.current} -> ${c.next} is queued; executable from ${at(etaIfQueued)} until ${at(expiresIfQueued)}`);
    return { ...base, ceilings, etaIfQueued: base.queued.length > 0 ? etaIfQueued : null, expiresIfQueued: base.queued.length > 0 ? expiresIfQueued : null, summary };
  }

  async setPolicy(next: PolicyInput): Promise<ChangeResult & { preview: PolicyPreviewFull }> {
    const preview = await this.previewPolicy(next);
    if (preview.outcome === 'none') return { ...NONE, preview };
    return { ...(await this.registryWrite('setPolicy', [preview.target], preview.outcome)), preview };
  }

  async addAgent(agent: Address, grant: AgentGrant = {}): Promise<ChangeResult> {
    notOwnerKey(agent, this.signer);
    const perms = grant.permissions ?? DEFAULT_AGENT_PERMISSIONS;
    const bits = encodePermissions(perms);
    if (perms.includes('sell')) this.mf.warn(SELL_RISK_WARNING);
    const expiresAt = expiryFrom(await latestTimestamp(this.mf.publicClient), grant.expiresInDays);
    return this.registryWrite('addAgent', [agent, expiresAt, bits], 'queued');
  }

  async setAgent(agent: Address, grant: AgentGrant): Promise<ChangeResult> {
    const now = await latestTimestamp(this.mf.publicClient);
    const current = await readAgent(this.mf.publicClient, this.agents, this.account, agent, now);
    if (!current.active) throw new InvalidInputError('agent', `${agent} is not an active agent; use addAgent`);
    const perms = grant.permissions ?? current.permissions;
    const bits = encodePermissions(perms);
    const expiresAt = grant.expiresInDays === undefined ? current.expiresAt : expiryFrom(now, grant.expiresInDays);
    const widening = expiresAt > current.expiresAt || (bits & ~current.permissionBits) !== 0;
    if (widening && perms.includes('sell') && !current.permissions.includes('sell')) this.mf.warn(SELL_RISK_WARNING);
    return this.registryWrite('setAgent', [agent, expiresAt, bits], widening ? 'queued' : 'immediate');
  }

  /** Retires `oldAgent` now and queues `newAgent` under the delay rule. */
  async rotateAgent(oldAgent: Address, newAgent: Address, grant: AgentGrant = {}): Promise<ChangeResult> {
    notOwnerKey(newAgent, this.signer);
    const perms = grant.permissions ?? DEFAULT_AGENT_PERMISSIONS;
    const bits = encodePermissions(perms);
    if (perms.includes('sell')) this.mf.warn(SELL_RISK_WARNING);
    const expiresAt = expiryFrom(await latestTimestamp(this.mf.publicClient), grant.expiresInDays);
    return this.registryWrite('rotateAgent', [oldAgent, newAgent, expiresAt, bits], 'mixed');
  }

  /** Retires the address forever (revoking it if active); its queued items can no longer execute. */
  revokeAgent(agent: Address): Promise<ChangeResult> {
    return this.registryWrite('revokeAgent', [agent], 'immediate');
  }

  /** Adding is queued (and skipped when already allowed); removing is immediate and makes pending additions stale. */
  async setTokenAllowed(token: Address, allowed: boolean): Promise<ChangeResult> {
    if (allowed) {
      const curve = (await this.mf.publicClient.readContract({
        address: this.mf.network.launch.factory, abi: launchFactoryAbi, functionName: 'curveOf', args: [token],
      } as never)) as Address;
      if (isAddressEqual(curve, zeroAddress)) throw new InvalidInputError('token', `${token} is not a Mercurifi Launch token on ${this.mf.network.name}`);
      if (await readRegistry<boolean>(this.mf.publicClient, this.agents.registry, 'tokenAllowed', [this.account, token])) return NONE;
    }
    return this.registryWrite('setTokenAllowed', [token, allowed], allowed ? 'queued' : 'immediate');
  }

  async setIncreaseDelay(seconds: number): Promise<ChangeResult> {
    intIn('increaseDelay', seconds, 0, MAX_INCREASE_DELAY);
    const { increaseDelay } = await this.state();
    if (seconds === increaseDelay) return NONE;
    return this.registryWrite('setIncreaseDelay', [seconds], seconds > increaseDelay ? 'immediate' : 'queued');
  }

  /** Queues the transfer; the new owner completes it with OwnerClient.acceptOwnership after the delay. */
  transferOwnership(newOwner: Address): Promise<ChangeResult> {
    return this.registryWrite('transferOwnership', [newOwner], 'queued');
  }

  listQueued(opts: { fromBlock?: bigint } = {}): Promise<QueuedChange[]> {
    return listQueued(this.mf.publicClient, this.agents, this.account, opts);
  }

  executeQueued(id: bigint): Promise<ChangeResult> {
    return this.registryWrite('executeQueued', [id], 'immediate');
  }

  cancelQueued(id: bigint): Promise<ChangeResult> {
    return this.registryWrite('cancelQueued', [id], 'immediate');
  }

  /** Immediate both ways; pausing also voids every queued item. */
  pauseAgents(paused: boolean): Promise<ChangeResult> {
    return this.registryWrite('pauseAgents', [paused], 'immediate');
  }

  /** To the owner only, from the account. Native USDC: `usdc`/`usdc6`/`all`; a Launch token: `token` with `amount` ('all' allowed) or `amountWei`. */
  async withdraw(p: WithdrawParams): Promise<ChangeResult> {
    rejectUnknownKeys(p);
    let token: Address = zeroAddress;
    let amount: bigint;
    if (p.token === undefined || isAddressEqual(p.token, zeroAddress)) {
      amount = p.all === true ? await this.mf.publicClient.getBalance({ address: this.account }) : usdc6ToWei(resolveUsdc6(p));
    } else {
      if (isAddressEqual(p.token, this.mf.network.launch.usdc)) {
        throw new InvalidInputError('token', 'Withdraw USDC as native (omit token): the ERC-20 view at 0x3600…0000 is the same balance.');
      }
      token = p.token;
      const r = resolveTokenAmount(p);
      amount = r === 'all' ? await this.balanceOf(token) : r;
    }
    if (amount === 0n) throw new InvalidInputError('amount', 'Nothing to withdraw.');
    return this.accountWrite('withdraw', [token, amount]);
  }

  /**
   * Full balances of every held token, then native USDC, to the owner, in chunks of 100 tokens per transaction.
   * Without `tokens`, the list comes from the API's action history, or from the account's own AgentAction logs.
   */
  async withdrawMany(tokens?: readonly Address[], opts: { fromBlock?: bigint } = {}): Promise<{ txHashes: Hex[]; tokens: Address[] }> {
    const candidates = tokens ?? (await this.launchTokensOnly(await this.tokensTouched(opts.fromBlock)));
    const seen = new Set<string>();
    const held: Address[] = [];
    for (const t of candidates) {
      const key = t.toLowerCase();
      if (seen.has(key) || isAddressEqual(t, zeroAddress) || isAddressEqual(t, this.mf.network.launch.usdc)) continue;
      seen.add(key);
      if ((await this.balanceOf(t)) > 0n) held.push(t);
    }
    const list: Address[] = [...held, zeroAddress];
    const txHashes: Hex[] = [];
    for (let i = 0; i < list.length; i += WITHDRAW_CHUNK) {
      const r = await this.accountWrite('withdrawMany', [list.slice(i, i + WITHDRAW_CHUNK)]);
      if (r.txHash !== null) txHashes.push(r.txHash);
    }
    return { txHashes, tokens: held };
  }

  private async tokensTouched(fromBlock?: bigint): Promise<Address[]> {
    const api = this.mf.api;
    if (api !== null) {
      try {
        const out: Address[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.listActions(this.account, cursor);
          out.push(...page.items.map((a) => a.token));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return out;
      } catch {
        // fall back to the chain
      }
    }
    const logs = await scanLogs(this.mf.publicClient, { address: this.account, topics: [AGENT_ACTION_TOPIC] }, fromBlock ?? this.agents.deployBlock);
    return (parseEventLogs({ abi: agentAccountAbi, eventName: 'AgentAction', logs } as never) as unknown as { args: { token: Address } }[]).map((l) => l.args.token);
  }

  /** Discovered tokens come from an API or logs; only Launch tokens (known to the Launch factory) are ever asked to transfer. */
  private async launchTokensOnly(tokens: readonly Address[]): Promise<Address[]> {
    const out: Address[] = [];
    for (const t of new Set(tokens.map((x) => x.toLowerCase() as Address))) {
      const curve = (await this.mf.publicClient.readContract({
        address: this.mf.network.launch.factory, abi: launchFactoryAbi, functionName: 'curveOf', args: [t],
      } as never)) as Address;
      if (!isAddressEqual(curve, zeroAddress)) out.push(t);
    }
    return out;
  }

  private balanceOf(token: Address): Promise<bigint> {
    return this.mf.publicClient.readContract({ address: token, abi: launchTokenAbi, functionName: 'balanceOf', args: [this.account] } as never) as Promise<bigint>;
  }

  /** A registry owner function: sent to the registry with the account as its first argument. */
  private registryWrite(functionName: string, args: readonly unknown[], expected: ChangeResult['outcome']): Promise<ChangeResult> {
    return sendChange(this.mf, this.signer, this.agents.registry, this.account,
      { to: this.agents.registry, abi: agentPolicyRegistryAbi, functionName, args: [this.account, ...args] }, expected);
  }

  /** An account function (withdrawals): sent to the account itself. */
  private accountWrite(functionName: string, args: readonly unknown[]): Promise<ChangeResult> {
    return sendChange(this.mf, this.signer, this.agents.registry, this.account,
      { to: this.account, abi: agentAccountAbi, functionName, args }, 'immediate');
  }
}
