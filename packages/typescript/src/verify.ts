import { isAddressEqual, keccak256, type Address, type Hex, type PublicClient } from 'viem';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from './abi/index.js';
import { NetworkMismatchError } from './errors.js';
import type { NetworkBook } from './networks.js';

const checkCode = async (
  client: PublicClient,
  label: string,
  address: Address,
  expected: Hex,
): Promise<void> => {
  const code = await client.getCode({ address });
  if (code === undefined || code === '0x' || keccak256(code) !== expected) {
    throw new NetworkMismatchError(
      `The agent account ${label} at ${address} does not match the pinned code hash.`,
    );
  }
};

/**
 * Start-up check: the RPC serves the book's chain, and the agent factory, implementation and policy
 * registry carry the pinned runtime code and point at each other. Refuses rather than warns: a wrong network or code
 * means every later step is unsafe.
 */
export const verifyNetwork = async (client: PublicClient, book: NetworkBook): Promise<void> => {
  const chainId = await client.getChainId();
  if (chainId !== book.chainId) {
    throw new NetworkMismatchError(
      `The RPC serves chain ${chainId}, but the ${book.name} address book is chain ${book.chainId}. Testnet and mainnet are never mixed.`,
    );
  }
  const agents = book.agents;
  if (agents === null) return;
  await checkCode(client, 'factory', agents.factory, agents.factoryCodeHash);
  await checkCode(client, 'implementation', agents.implementation, agents.implementationCodeHash);
  await checkCode(client, 'policy registry', agents.registry, agents.registryCodeHash);
  const [impl, registry, registryFactory] = await Promise.all([
    client.readContract({
      address: agents.factory,
      abi: agentAccountFactoryAbi,
      functionName: 'implementation',
    }),
    client.readContract({
      address: agents.factory,
      abi: agentAccountFactoryAbi,
      functionName: 'registry',
    }),
    client.readContract({
      address: agents.registry,
      abi: agentPolicyRegistryAbi,
      functionName: 'FACTORY',
    }),
  ]);
  if (!isAddressEqual(impl, agents.implementation)) {
    throw new NetworkMismatchError(
      `The factory reports implementation ${impl}, not the pinned ${agents.implementation}.`,
    );
  }
  if (!isAddressEqual(registry, agents.registry)) {
    throw new NetworkMismatchError(
      `The factory reports registry ${registry}, not the pinned ${agents.registry}.`,
    );
  }
  if (!isAddressEqual(registryFactory, agents.factory)) {
    throw new NetworkMismatchError(
      `The policy registry at ${agents.registry} belongs to factory ${registryFactory}, not the pinned ${agents.factory}.`,
    );
  }
};
