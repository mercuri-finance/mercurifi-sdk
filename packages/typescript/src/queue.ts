import { decodeAbiParameters, pad, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem';

import { agentPolicyRegistryAbi } from './abi/index.js';
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

export type QueuedStatus = 'pending' | 'ready' | 'expired' | 'cancelled' | 'stale';

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
};

/** Queued changes of `account`, found in the registry's logs within the queue window, with live status. */
export const listQueued = async (client: PublicClient, agents: AgentBook, account: Address, opts: { fromBlock?: bigint } = {}): Promise<QueuedChange[]> => {
  const reg = <T>(fn: string, args: readonly unknown[]) => readRegistry<T>(client, agents.registry, fn, [account, ...args]);
  const head = await client.getBlockNumber();
  const windowStart = head > QUEUE_WINDOW_BLOCKS ? head - QUEUE_WINDOW_BLOCKS : 0n;
  const from = opts.fromBlock ?? (windowStart > agents.deployBlock ? windowStart : agents.deployBlock);
  const logs = await scanLogs(client, { address: agents.registry, topics: [null, accountTopic(account)] }, from, head);
  const ids = new Set<bigint>();
  for (const log of parseEventLogs({ abi: agentPolicyRegistryAbi, logs: logs as never, strict: false })) {
    if (!(QUEUE_EVENTS as readonly string[]).includes(log.eventName)) continue;
    const args = log.args as Record<string, unknown> | undefined;
    if (typeof args?.account !== 'string' || args.account.toLowerCase() !== account.toLowerCase()) continue;
    if (typeof args.id === 'bigint') ids.add(args.id);
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
    const status: QueuedStatus = BigInt(itemEpoch) !== BigInt(epoch) ? 'cancelled'
      : now > BigInt(expiresAt) ? 'expired'
        : stale ? 'stale'
          : now < BigInt(etaN) ? 'pending' : 'ready';
    const warning = status === 'stale' && 'policy' in d
      ? 'Every policy field was changed after this was queued, so executing it changes nothing.'
      : WARNINGS[status] ?? null;
    out.push({ id, ...decoded, eta: etaN, expiresAt, seq, status, warning });
  }
  return out;
};
