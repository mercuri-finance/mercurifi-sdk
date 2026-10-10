import { keccak256, type Address, type Hex } from 'viem';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../../src/abi/index.js';
import { createClient, type CreateClientOptions, type MercurifiClient } from '../../src/client.js';
import { localNetwork, type LocalBookJson } from '../../src/networks.js';
import { MockRpc } from './mockRpc.js';

export const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
export const FACTORY_CODE: Hex = '0x6001600101';
export const IMPL_CODE: Hex = '0x6002600201';
export const REGISTRY_CODE: Hex = '0x6003600301';
export const ACCOUNT = A(0xaa);
export const TOKEN = A(0xbb);
export const CURVE = A(0xcc);
/** The policy registry; A(11) stays free as "a wrong implementation" in tests. */
export const REGISTRY = A(12);
export const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const AGENT_KEY = '0x5de4111afa1a4b94908f83536b1543d1e1b8f8a8b9a5c5e7a5e0d0ff0a0b0c0d';

export const localJson = (over: Partial<LocalBookJson> = {}): LocalBookJson => ({
  chainId: 31337,
  launchFactory: A(1),
  feeManager: A(2),
  graduationManager: A(3),
  launchHook: A(4),
  poolManager: A(5),
  permit2: A(6),
  universalRouter: A(7),
  v4Quoter: A(8),
  usdc: '0x3600000000000000000000000000000000000000',
  agentFactory: A(9),
  agentImplementation: A(10),
  agentRegistry: REGISTRY,
  agentFactoryCodeHash: keccak256(FACTORY_CODE),
  agentImplementationCodeHash: keccak256(IMPL_CODE),
  agentRegistryCodeHash: keccak256(REGISTRY_CODE),
  deployBlock: 1,
  ...over,
});

/** A MockRpc that passes start-up verification of the local book. */
export const localRpc = (): MockRpc => {
  const rpc = new MockRpc(31337);
  rpc.codes.set(A(9).toLowerCase(), FACTORY_CODE);
  rpc.codes.set(A(10).toLowerCase(), IMPL_CODE);
  rpc.codes.set(REGISTRY.toLowerCase(), REGISTRY_CODE);
  rpc.read(A(9), agentAccountFactoryAbi, 'implementation', A(10));
  rpc.read(A(9), agentAccountFactoryAbi, 'registry', REGISTRY);
  rpc.read(REGISTRY, agentPolicyRegistryAbi, 'FACTORY', A(9));
  return rpc;
};

export const localClient = (
  rpc: MockRpc,
  over: Partial<CreateClientOptions> = {},
): Promise<MercurifiClient> =>
  createClient({
    network: localNetwork(localJson()),
    rpcUrl: 'http://127.0.0.1:8545',
    transport: rpc.transport(),
    pollMs: 1,
    onWarning: () => undefined,
    ...over,
  });
