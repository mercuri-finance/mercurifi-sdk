import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../../src/abi/index.js';
import { TESTNET } from '../../src/networks.js';
import { MockRpc } from './mockRpc.js';

interface Entry {
  address: Address;
  code: Hex;
}
/** The live testnet runtime code (fixtures/testnet-agent-code.json); keccak of each must equal the pinned hash. */
export const TESTNET_CODE = JSON.parse(
  readFileSync(new URL('../../../../fixtures/testnet-agent-code.json', import.meta.url), 'utf8'),
) as {
  chainId: number;
  factory: Entry;
  implementation: Entry;
  registry: Entry;
};

/** A MockRpc on chain 5042002 that passes start-up verification of the pinned testnet book (code hashes and wiring). */
export const testnetRpc = (): MockRpc => {
  const agents = TESTNET.agents!;
  const rpc = new MockRpc(TESTNET.chainId);
  rpc.codes.set(agents.factory.toLowerCase(), TESTNET_CODE.factory.code);
  rpc.codes.set(agents.implementation.toLowerCase(), TESTNET_CODE.implementation.code);
  rpc.codes.set(agents.registry.toLowerCase(), TESTNET_CODE.registry.code);
  rpc.read(agents.factory, agentAccountFactoryAbi, 'implementation', agents.implementation);
  rpc.read(agents.factory, agentAccountFactoryAbi, 'registry', agents.registry);
  rpc.read(agents.registry, agentPolicyRegistryAbi, 'FACTORY', agents.factory);
  return rpc;
};
