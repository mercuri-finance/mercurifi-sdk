import type { Address, PublicClient } from 'viem';

import { agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi } from './abi/index.js';
import type { AgentBook } from './networks.js';
import { decodePermissions, type Permission } from './permissions.js';
import type { ChainPolicy } from './policy.js';

export const toChainPolicy = (p: ChainPolicy): ChainPolicy => ({
  maxTradeUsdc: BigInt(p.maxTradeUsdc), periodSpendCap: BigInt(p.periodSpendCap), perTokenPeriodCap: BigInt(p.perTokenPeriodCap),
  periodSellCap: BigInt(p.periodSellCap), maxActionsPerPeriod: Number(p.maxActionsPerPeriod), launchesPerPeriod: Number(p.launchesPerPeriod),
  maxPriceImpactBps: Number(p.maxPriceImpactBps), maxSnipeBps: Number(p.maxSnipeBps), minTokenAgeBlocks: Number(p.minTokenAgeBlocks),
  maxDeadlineSeconds: Number(p.maxDeadlineSeconds), allowlistOnly: Boolean(p.allowlistOnly),
});

/** `blockNumber` pins a read; omitted, the node's latest block answers. */
const at = (blockNumber: bigint | undefined): { blockNumber?: bigint } => (blockNumber === undefined ? {} : { blockNumber });

/** Untyped read of the account (funds, basis, owner, referrer): the generated ABI types are exact, but the SDK reads by name. */
export const readAccount = <T>(client: PublicClient, account: Address, functionName: string, args?: readonly unknown[], blockNumber?: bigint): Promise<T> =>
  client.readContract({ address: account, abi: agentAccountAbi, functionName, args, ...at(blockNumber) } as never) as Promise<T>;

/** Untyped read of the policy registry. Every registry view takes the account as its first argument. */
export const readRegistry = <T>(client: PublicClient, registry: Address, functionName: string, args: readonly unknown[], blockNumber?: bigint): Promise<T> =>
  client.readContract({ address: registry, abi: agentPolicyRegistryAbi, functionName, args, ...at(blockNumber) } as never) as Promise<T>;

export const readPolicy = async (client: PublicClient, agents: AgentBook, account: Address, blockNumber?: bigint): Promise<ChainPolicy> =>
  toChainPolicy(await readRegistry<ChainPolicy>(client, agents.registry, 'policy', [account], blockNumber));

/** The registry's first check: the account owner's pause or the platform pause (`Paused`). */
export const readPaused = async (client: PublicClient, agents: AgentBook, account: Address, blockNumber?: bigint): Promise<boolean> => {
  const [owner, platform] = await Promise.all([
    readRegistry<boolean>(client, agents.registry, 'ownerPaused', [account], blockNumber),
    client.readContract({ address: agents.factory, abi: agentAccountFactoryAbi, functionName: 'isPaused', ...at(blockNumber) } as never) as Promise<boolean>,
  ]);
  return owner || platform;
};

export interface AccountState {
  account: Address;
  registry: Address;
  owner: Address;
  referrer: Address;
  policy: ChainPolicy;
  periodSeconds: number;
  increaseDelay: number;
  ownerPaused: boolean;
  factoryPaused: boolean;
  activeAgentCount: number;
  epoch: bigint;
  /** Registry write sequence: queued items record it; a subject written after an item's `seq` is not overwritten by it. */
  writeSeq: bigint;
  balanceWei: bigint;
}

export const readAccountState = async (client: PublicClient, agents: AgentBook, account: Address): Promise<AccountState> => {
  const r = <T>(fn: string) => readRegistry<T>(client, agents.registry, fn, [account]);
  const [owner, referrer, policy, periodSeconds, increaseDelay, ownerPaused, activeAgentCount, epoch, writeSeq, factoryPaused, balanceWei] = await Promise.all([
    r<Address>('owner'),
    readAccount<Address>(client, account, 'referrer'),
    r<ChainPolicy>('policy'),
    r<number>('periodSeconds'),
    r<number>('increaseDelay'),
    r<boolean>('ownerPaused'),
    r<number>('activeAgentCount'),
    r<bigint>('epoch'),
    r<bigint>('writeSeq'),
    client.readContract({ address: agents.factory, abi: agentAccountFactoryAbi, functionName: 'isPaused' }) as Promise<boolean>,
    client.getBalance({ address: account }),
  ]);
  return {
    account, registry: agents.registry, owner, referrer, policy: toChainPolicy(policy), periodSeconds: Number(periodSeconds),
    increaseDelay: Number(increaseDelay), ownerPaused, factoryPaused, activeAgentCount: Number(activeAgentCount),
    epoch: BigInt(epoch), writeSeq: BigInt(writeSeq), balanceWei,
  };
};

export const readCeilings = async (client: PublicClient, agents: AgentBook): Promise<ChainPolicy> =>
  toChainPolicy((await client.readContract({ address: agents.factory, abi: agentAccountFactoryAbi, functionName: 'ceilings' } as never)) as ChainPolicy);

export const isAgentAccount = (client: PublicClient, agents: AgentBook, account: Address): Promise<boolean> =>
  client.readContract({ address: agents.factory, abi: agentAccountFactoryAbi, functionName: 'isAccount', args: [account] } as never) as Promise<boolean>;

export interface AgentInfo {
  address: Address;
  active: boolean;
  /** Revoked once; can never be an agent of this account again. */
  retired: boolean;
  expiresAt: number;
  expired: boolean;
  permissions: Permission[];
  permissionBits: number;
}

export const readAgent = async (client: PublicClient, agents: AgentBook, account: Address, agent: Address, now: bigint, blockNumber?: bigint): Promise<AgentInfo> => {
  const [a, retired] = await Promise.all([
    readRegistry<{ active: boolean; expiresAt: number; permissions: number }>(client, agents.registry, 'agent', [account, agent], blockNumber),
    readRegistry<boolean>(client, agents.registry, 'retired', [account, agent], blockNumber),
  ]);
  const expiresAt = Number(a.expiresAt);
  return {
    address: agent, active: a.active, retired, expiresAt, expired: BigInt(expiresAt) <= now,
    permissions: decodePermissions(Number(a.permissions)), permissionBits: Number(a.permissions),
  };
};

export const latestTimestamp = async (client: PublicClient): Promise<bigint> => (await client.getBlock({ blockTag: 'latest' })).timestamp;
