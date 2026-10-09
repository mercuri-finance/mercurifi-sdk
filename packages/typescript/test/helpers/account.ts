import {
  encodeAbiParameters, encodeEventTopics, getAbiItem, zeroAddress,
  type Abi, type AbiEvent, type AbiParameter, type Address, type Hex,
} from 'viem';

import {
  agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi, bondingCurveAbi, launchFactoryAbi, launchTokenAbi,
} from '../../src/abi/index.js';
import { DEFAULT_POLICY, type ChainPolicy } from '../../src/policy.js';
import { A, ACCOUNT, CURVE, REGISTRY, TOKEN } from './local.js';
import type { MockRpc, RpcLog } from './mockRpc.js';

export { REGISTRY };
export const FACTORY = A(9);
export const LAUNCH_FACTORY = A(1);
/** The beta ceilings. minTokenAgeBlocks is a floor on-chain, so the beta value is 0. */
export const CEILINGS: ChainPolicy = {
  maxTradeUsdc: 1_000_000_000n, periodSpendCap: 10_000_000_000n, perTokenPeriodCap: 2_000_000_000n, periodSellCap: 10_000_000_000n,
  maxActionsPerPeriod: 5_000, launchesPerPeriod: 20, maxPriceImpactBps: 2_000, maxSnipeBps: 9_900,
  minTokenAgeBlocks: 0, maxDeadlineSeconds: 600, allowlistOnly: false,
};
const WAD = 10n ** 18n;
const same = (a: unknown, b: Address): boolean => String(a).toLowerCase() === b.toLowerCase();

const zeroFor = (p: AbiParameter): unknown => {
  if (p.type === 'address') return zeroAddress;
  if (p.type === 'bool') return false;
  if (p.type === 'string') return '';
  if (p.type === 'bytes') return '0x';
  if (p.type.startsWith('bytes')) return `0x${'00'.repeat(Number(p.type.slice(5)))}`;
  if (p.type === 'tuple') return Object.fromEntries((p as unknown as { components: AbiParameter[] }).components.map((c) => [c.name, zeroFor(c)]));
  return 0n;
};

/** Encodes `eventName` from `abi` as an RPC log; inputs not named in `values` are zero. */
export const eventLog = (abi: Abi, address: Address, eventName: string, values: Record<string, unknown>): RpcLog => {
  const ev = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, values[i.name!] ?? zeroFor(i)]));
  const plain = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: [ev], eventName, args: indexed } as never) as Hex[],
    data: encodeAbiParameters(plain, plain.map((i) => values[i.name!] ?? zeroFor(i))),
  };
};

/** The account's own AgentAction log (fills are decoded from it). */
export const agentActionLog = (values: Record<string, unknown>): RpcLog => eventLog(agentAccountAbi, ACCOUNT, 'AgentAction', values);

/** A registry event; `account` (indexed topic 1) defaults to ACCOUNT. */
export const registryLog = (eventName: string, values: Record<string, unknown>): RpcLog =>
  eventLog(agentPolicyRegistryAbi, REGISTRY, eventName, { account: ACCOUNT, ...values });

/** A queue event carrying `id` (how chain-only queue listing discovers ids). */
export const queueLog = (id: bigint, eventName = 'AgentQueued'): RpcLog => registryLog(eventName, { id });

export interface AccountMockOptions {
  owner: Address;
  agent: Address;
  agentActive?: boolean;
  agentExpiresAt?: number;
  agentPermissions?: number;
  policy?: ChainPolicy;
  increaseDelay?: number;
  epoch?: bigint;
  writeSeq?: bigint;
  /** account.basis(token): [costUsdc, tokens, highWater]. */
  basis?: readonly [bigint, bigint, bigint];
  /** registry.headroom(account): [spend, sell, actions, launches]. */
  headroom?: readonly [bigint, bigint, number, number];
}

/** Factory, account and registry reads of one account. Registry calls take the account as args[0]. */
export const mockAccount = (rpc: MockRpc, o: AccountMockOptions): void => {
  rpc.read(FACTORY, agentAccountFactoryAbi, 'isAccount', (args) => same(args[0], ACCOUNT));
  rpc.read(FACTORY, agentAccountFactoryAbi, 'ceilings', CEILINGS);
  rpc.read(FACTORY, agentAccountFactoryAbi, 'isPaused', false);
  rpc.read(ACCOUNT, agentAccountAbi, 'owner', o.owner);
  rpc.read(ACCOUNT, agentAccountAbi, 'referrer', A(0x77));
  rpc.read(ACCOUNT, agentAccountAbi, 'REGISTRY', REGISTRY);
  rpc.read(ACCOUNT, agentAccountAbi, 'basis', o.basis ?? [0n, 0n, 0n]);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'owner', o.owner);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'policy', o.policy ?? DEFAULT_POLICY);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'periodSeconds', 86_400);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'increaseDelay', o.increaseDelay ?? 3_600);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'ownerPaused', false);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'activeAgentCount', 1);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'epoch', o.epoch ?? 1n);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'writeSeq', o.writeSeq ?? 1n);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'agent', (args) =>
    same(args[1], o.agent)
      ? { active: o.agentActive ?? true, expiresAt: o.agentExpiresAt ?? 1_800_000_000, permissions: o.agentPermissions ?? 63 }
      : { active: false, expiresAt: 0, permissions: 0 });
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'retired', false);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'headroom', o.headroom ?? [400_000_000n, 500_000_000n, 499, 3]);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'usage', [19_637n, 100_000_000n, 0n, 1, 0]);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenAllowed', false);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenSpent', 0n);
  for (const fn of ['policyWrite', 'agentWrite', 'tokenWrite', 'delayWrite']) rpc.read(REGISTRY, agentPolicyRegistryAbi, fn, 0n);
  rpc.balances.set(ACCOUNT, 1_000n * WAD);
};

export interface CurveMockOptions {
  phase?: number;
  tokensOut?: bigint;
  usdcUsed?: (usdcIn: bigint) => bigint;
  sold?: bigint;
  curveSupply?: bigint;
  usdcOut?: bigint;
  balance?: bigint;
  /** Marginal price, native wei per whole token. The default sits just above the mocked buy's average price (zero impact). */
  price?: bigint;
  snipe?: bigint;
  launchBlock?: bigint;
}

export const mockCurve = (rpc: MockRpc, o: CurveMockOptions = {}): void => {
  rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'curveOf', (args) => (same(args[0], TOKEN) ? CURVE : zeroAddress));
  rpc.read(CURVE, bondingCurveAbi, 'phase', o.phase ?? 0);
  rpc.read(CURVE, bondingCurveAbi, 'quoteBuy', (args) => {
    const usdcIn = args[0] as bigint;
    return [o.tokensOut ?? 1_000_000n * WAD, o.usdcUsed ? o.usdcUsed(usdcIn) : usdcIn, usdcIn / 100n, 0n];
  });
  rpc.read(CURVE, bondingCurveAbi, 'quoteSell', () => [o.usdcOut ?? 9_900_000_000_000_000_000n, 100_000_000_000_000_000n]);
  rpc.read(CURVE, bondingCurveAbi, 'sold', o.sold ?? 100_000_000n * WAD);
  rpc.read(CURVE, bondingCurveAbi, 'curveSupply', o.curveSupply ?? 800_000_000n * WAD);
  rpc.read(CURVE, bondingCurveAbi, 'price', o.price ?? 25_000_000_000_000n);
  rpc.read(CURVE, bondingCurveAbi, 'currentSnipeBps', o.snipe ?? 0n);
  rpc.read(CURVE, bondingCurveAbi, 'launchBlock', o.launchBlock ?? 100n);
  rpc.read(CURVE, bondingCurveAbi, 'progressBps', 1_250n);
  rpc.read(CURVE, bondingCurveAbi, 'token', TOKEN);
  rpc.read(TOKEN, launchTokenAbi, 'balanceOf', o.balance ?? 0n);
  rpc.read(TOKEN, launchTokenAbi, 'name', 'Example');
  rpc.read(TOKEN, launchTokenAbi, 'symbol', 'EX');
};
