import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../../src/abi/index.js';
import { MAINNET, TESTNET, type NetworkBook } from '../../src/networks.js';
import { MockRpc } from './mockRpc.js';

interface Entry {
  address: Address;
  code: Hex;
}
interface AgentCode {
  chainId: number;
  factory: Entry;
  implementation: Entry;
  registry: Entry;
}
const readCode = (file: string): AgentCode =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/${file}`, import.meta.url), 'utf8'),
  ) as AgentCode;

/** The live testnet runtime code (fixtures/testnet-agent-code.json); keccak of each must equal the pinned hash. */
export const TESTNET_CODE = readCode('testnet-agent-code.json');
/** The live mainnet runtime code (fixtures/mainnet-agent-code.json); keccak of each must equal the pinned hash. */
export const MAINNET_CODE = readCode('mainnet-agent-code.json');

const pinnedRpc = (book: NetworkBook, code: AgentCode): MockRpc => {
  const agents = book.agents!;
  const rpc = new MockRpc(book.chainId);
  rpc.codes.set(agents.factory.toLowerCase(), code.factory.code);
  rpc.codes.set(agents.implementation.toLowerCase(), code.implementation.code);
  rpc.codes.set(agents.registry.toLowerCase(), code.registry.code);
  rpc.read(agents.factory, agentAccountFactoryAbi, 'implementation', agents.implementation);
  rpc.read(agents.factory, agentAccountFactoryAbi, 'registry', agents.registry);
  rpc.read(agents.registry, agentPolicyRegistryAbi, 'FACTORY', agents.factory);
  return rpc;
};

/** A MockRpc on chain 5042002 that passes start-up verification of the pinned testnet book (code hashes and wiring). */
export const testnetRpc = (): MockRpc => pinnedRpc(TESTNET, TESTNET_CODE);

/** A MockRpc on chain 5042 that passes start-up verification of the pinned mainnet book (code hashes and wiring). */
export const mainnetRpc = (): MockRpc => pinnedRpc(MAINNET, MAINNET_CODE);
