import { decodeAbiParameters, pad, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem';

import { agentPolicyRegistryAbi } from './abi/index.js';
import type { MercurifiApi } from './api/types.js';
import type { AgentBook } from './networks.js';
import { decodePermissions, type Permission } from './permissions.js';
import { POLICY_FIELDS, QUEUE_TTL_SECONDS, type ChainPolicy, type PolicyField } from './policy.js';
import { latestTimestamp, readRegistry, toChainPolicy } from './reads.js';

export const LOG_CHUNK = 10_000n;
/** 14 days at ~0.5 s blocks: an item is executable at most `increaseDelay` (≤ 7 d) + 7 d after it was queued. */
export const QUEUE_WINDOW_BLOCKS = 2_419_200n;

export interface RawLog { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number }

/** An address as a 32-byte log topic (indexed `address` arguments are left-padded). */
export const accountTopic = (account: Address): Hex => pad(account.toLowerCase() as Hex, { size: 32 });

/**
 * Raw eth_getLogs over [fromBlock, toBlock] in chunks (public Arc RPCs bound the range per call). Raw, because viem's
 * getLogs cannot filter one indexed topic across several events, which the registry's queue events need.
 */
export const scanLogs = async (
  client: PublicClient, filter: { address: Address; topics?: readonly (Hex | null)[] }, fromBlock: bigint, toBlock?: bigint, chunk = LOG_CHUNK,
): Promise<RawLog[]> => {
  const head = toBlock ?? (await client.getBlockNumber());
  const out: RawLog[] = [];
  for (let start = fromBlock; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    const logs = await client.request({
      method: 'eth_getLogs',
      params: [{ address: filter.address, ...(filter.topics === undefined ? {} : { topics: [...filter.topics] }), fromBlock: toHex(start), toBlock: toHex(end) }],
    });
    for (const l of logs) {
      out.push({
        address: l.address, topics: [...l.topics] as Hex[], data: l.data, blockNumber: BigInt(l.blockNumber ?? '0x0'),
        transactionHash: (l.transactionHash ?? '0x') as Hex, logIndex: Number(l.logIndex ?? '0x0'),
      });
    }
  }
  return out;
};

export const POLICY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'maxTradeUsdc', type: 'uint64' }, { name: 'periodSpendCap', type: 'uint64' }, { name: 'perTokenPeriodCap', type: 'uint64' },
    { name: 'periodSellCap', type: 'uint64' }, { name: 'maxActionsPerPeriod', type: 'uint32' }, { name: 'launchesPerPeriod', type: 'uint16' },
    { name: 'maxPriceImpactBps', type: 'uint16' }, { name: 'maxSnipeBps', type: 'uint16' }, { name: 'minTokenAgeBlocks', type: 'uint32' },
    { name: 'maxDeadlineSeconds', type: 'uint32' }, { name: 'allowlistOnly', type: 'bool' },
  ],
} as const;
const AGENT_PAYLOAD = [{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }] as const;

/** `Q_*` kinds of AgentTypes.sol; payload layouts per the registry's `queued` NatSpec (no snapshots). */
export const QUEUE_KINDS = Object.freeze({ 1: 'addAgent', 2: 'setAgent', 3: 'policy', 4: 'allowToken', 5: 'delay', 6: 'owner' } as const);
export type QueueKindName = (typeof QUEUE_KINDS)[keyof typeof QUEUE_KINDS] | 'unknown';
/** Registry events that create a queue item; each carries `id` (and `account` as topic 1). */
export const QUEUE_EVENTS = Object.freeze(['AgentQueued', 'PolicyQueued', 'TokenAllowQueued', 'IncreaseDelayQueued', 'OwnershipQueued'] as const);

export type QueuedDetail =
  | { agent: Address; expiresAt: number; permissions: Permission[] }
  /** `superseded`: fields written after queueing, which keep their current value when the item executes. */
  | { policy: ChainPolicy; superseded: PolicyField[] }
  | { token: Address }
  | { delay: number }
  | { newOwner: Address }
  | { raw: Hex };

export const decodeQueuedPayload = (kind: number, payload: Hex): { kind: QueueKindName; detail: QueuedDetail } => {
  try {
    switch (kind) {
      case 1:
      case 2: {
        const [agent, expiresAt, permissions] = decodeAbiParameters(AGENT_PAYLOAD, payload);
        return { kind: kind === 1 ? 'addAgent' : 'setAgent', detail: { agent, expiresAt: Number(expiresAt), permissions: decodePermissions(Number(permissions)) } };
      }
      case 3: {
        const [policy] = decodeAbiParameters([POLICY_TUPLE], payload) as unknown as [ChainPolicy];
        return { kind: 'policy', detail: { policy: toChainPolicy(policy), superseded: [] } };
      }
      case 4:
        return { kind: 'allowToken', detail: { token: decodeAbiParameters([{ type: 'address' }], payload)[0] } };
      case 5:
        return { kind: 'delay', detail: { delay: Number(decodeAbiParameters([{ type: 'uint32' }], payload)[0]) } };
      case 6:
        return { kind: 'owner', detail: { newOwner: decodeAbiParameters([{ type: 'address' }], payload)[0] } };
      default:
        return { kind: 'unknown', detail: { raw: payload } };
    }
  } catch {
    return { kind: 'unknown', detail: { raw: payload } };
  }
};

export type QueuedStatus = 'pending' | 'ready' | 'expired' | 'cancelled' | 'stale' | 'unexecutable';

/**
 * The registry's effective ETA: `queuedAt + max(delayAtQueue, current delay)`. Raising the widening delay therefore also
 * postpones items that are already queued; lowering it never brings them forward.
 */
export const effectiveEta = (queuedAt: number, delayAtQueue: number, currentDelay: number): number =>
  queuedAt + Math.max(delayAtQueue, currentDelay);

export interface QueuedChange {
  id: bigint;
  kind: QueueKindName;
  /** Effective ETA (a later delay raise moves it), Unix seconds. */
  eta: number;
  /** ETA + 7 days; after this the item can no longer run. */
  expiresAt: number;
  /** Registry `writeSeq` when queued. */
  seq: bigint;
  /**
   * `cancelled`: queued before a pause or an ownership change (older epoch); `stale`: its agent, token entry or delay
   * was written after it (executing reverts StaleQueued), or every policy field was; otherwise by the time window.
   */
  status: QueuedStatus;
  /**
   * What executing it now would do wrong, in words: `StaleQueued` for a stale agent, token or delay item, `QueuedExpired`
   * past the window, a no-op for a policy item whose every field was written since, silent cancellation for an old epoch.
   * `null` when nothing is wrong.
   */
  warning: string | null;
  detail: QueuedDetail;
}

const WARNINGS: Partial<Record<QueuedStatus, string>> = {
  stale: 'Executing this reverts StaleQueued (its subject changed after it was queued); cancel it and queue it again if still wanted.',
  expired: 'Executing this reverts QueuedExpired (the 7-day window after its ETA has passed); cancel it and queue it again if still wanted.',
  cancelled: 'Voided by a pause or an ownership change after it was queued; executing it only clears it.',
  unexecutable: 'Executing this reverts AgentExpiryOutOfRange: the agent would already be expired at the earliest time it can run. Cancel it and queue a longer expiry.',
};

const OWNER_WARNINGS: Partial<Record<QueuedStatus, string>> = {
  pending: 'An ownership transfer is completed only by the new owner calling acceptOwnership once the ETA has passed; executeQueued reverts AcceptRequired. The current owner can cancelQueued it.',
  ready: 'An ownership transfer is completed only by the new owner calling acceptOwnership (within 7 days of the ETA); executeQueued reverts AcceptRequired. The current owner can cancelQueued it.',
  cancelled: 'Voided by a pause or an ownership change: acceptOwnership now reverts StaleQueued and executeQueued reverts AcceptRequired. Only cancelQueued clears it.',
  expired: 'The 7-day window has passed: acceptOwnership reverts QueuedExpired. Only cancelQueued clears it.',
};

/** Hard bound on the ids taken from an API answer; each is verified on chain anyway. */
const MAX_API_IDS = 200;

/** Candidate ids from the API's pending list (untrusted: each is re-read from the registry). Null when the API is unusable. */
const idsFromApi = async (api: MercurifiApi, account: Address): Promise<Set<bigint> | null> => {
  try {
    const acc = await api.getAccount(account);
    const ids = new Set<bigint>();
    for (const item of acc.pending.slice(0, MAX_API_IDS)) {
      if (typeof item.id === 'string' && /^[0-9]{1,18}$/.test(item.id)) ids.add(BigInt(item.id));
    }
    return ids;
  } catch {
    return null;
  }
};

/**
 * Queued changes of `account` with live status, every field read from the registry. Candidate ids come from the API
 * first when `opts.api` is given, and otherwise (or if it fails) from the registry's logs within the queue window.
 */
export const listQueued = async (
  client: PublicClient, agents: AgentBook, account: Address, opts: { fromBlock?: bigint; api?: MercurifiApi | null } = {},
): Promise<QueuedChange[]> => {
  const reg = <T>(fn: string, args: readonly unknown[]) => readRegistry<T>(client, agents.registry, fn, [account, ...args]);
  let ids = opts.api ? await idsFromApi(opts.api, account) : null;
  // An empty API list is not proof of an empty queue (the API may lag or be wrong): still scan the recent window.
  if (ids === null || ids.size === 0) {
    ids = ids ?? new Set<bigint>();
    const head = await client.getBlockNumber();
    const windowStart = head > QUEUE_WINDOW_BLOCKS ? head - QUEUE_WINDOW_BLOCKS : 0n;
    const from = opts.fromBlock ?? (windowStart > agents.deployBlock ? windowStart : agents.deployBlock);
    const logs = await scanLogs(client, { address: agents.registry, topics: [null, accountTopic(account)] }, from, head);
    for (const log of parseEventLogs({ abi: agentPolicyRegistryAbi, logs: logs as never, strict: false })) {
      if (!(QUEUE_EVENTS as readonly string[]).includes(log.eventName)) continue;
      const args = log.args as Record<string, unknown> | undefined;
      if (typeof args?.account !== 'string' || args.account.toLowerCase() !== account.toLowerCase()) continue;
      if (typeof args.id === 'bigint') ids.add(args.id);
    }
  }
  const [epoch, now] = await Promise.all([reg<bigint>('epoch', []), latestTimestamp(client)]);
  const out: QueuedChange[] = [];
  for (const id of [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [kind, eta, itemEpoch, seqRaw, payload] = await reg<readonly [number, number, bigint, bigint, Hex]>('queued', [id]);
    if (Number(kind) === 0) continue; // executed or cancelled
    const seq = BigInt(seqRaw);
    const etaN = Number(eta);
    const expiresAt = etaN + QUEUE_TTL_SECONDS;
    const decoded = decodeQueuedPayload(Number(kind), payload);
    let stale = false;
    const d = decoded.detail;
    if ('agent' in d) stale = BigInt(await reg<bigint>('agentWrite', [d.agent])) > seq;
    else if ('token' in d) stale = BigInt(await reg<bigint>('tokenWrite', [d.token])) > seq;
    else if ('delay' in d) stale = BigInt(await reg<bigint>('delayWrite', [])) > seq;
    else if ('policy' in d) {
      const writes = await Promise.all(POLICY_FIELDS.map((_f, i) => reg<bigint>('policyWrite', [BigInt(i)])));
      d.superseded = POLICY_FIELDS.filter((_f, i) => BigInt(writes[i]!) > seq);
      stale = d.superseded.length === POLICY_FIELDS.length;
    }
    // executeQueued checks the epoch first, then the window, then freshness; the status follows the same order.
    // An agent item whose expiry is not after max(now, eta) fails _checkAgentTerms at every possible execution time.
    const unexecutable = 'agent' in d && BigInt(d.expiresAt) <= (now > BigInt(etaN) ? now : BigInt(etaN));
    const status: QueuedStatus = BigInt(itemEpoch) !== BigInt(epoch) ? 'cancelled'
      : now > BigInt(expiresAt) ? 'expired'
        : stale ? 'stale'
          : unexecutable ? 'unexecutable'
            : now < BigInt(etaN) ? 'pending' : 'ready';
    const warning = decoded.kind === 'owner'
      ? OWNER_WARNINGS[status] ?? null
      : status === 'stale' && 'policy' in d
        ? 'Every policy field was changed after this was queued, so executing it changes nothing.'
        : WARNINGS[status] ?? null;
    out.push({ id, ...decoded, eta: etaN, expiresAt, seq, status, warning });
  }
  return out;
};
