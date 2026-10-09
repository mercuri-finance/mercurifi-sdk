import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { createClient } from '../src/client.js';
import { InvalidInputError, NetworkMismatchError, NotDeployedError } from '../src/errors.js';
import { localNetwork, TESTNET } from '../src/networks.js';
import { A, localJson, localRpc, REGISTRY } from './helpers/local.js';
import { MockRpc } from './helpers/mockRpc.js';

const LOCAL = 'http://127.0.0.1:8545';

describe('createClient', () => {
  it('connects to testnet with the default RPC and reports agents as not deployed', async () => {
    const rpc = new MockRpc(TESTNET.chainId);
    const mf = await createClient({ network: 'testnet', transport: rpc.transport() });
    expect(mf.network.chainId).toBe(5042002);
    expect(() => mf.requireAgents()).toThrow(NotDeployedError);
  });

  it('refuses an RPC on the other network', async () => {
    const rpc = new MockRpc(5042);
    await expect(createClient({ network: 'testnet', transport: rpc.transport() })).rejects.toThrow(NetworkMismatchError);
    await expect(createClient({ network: 'testnet', transport: rpc.transport() })).rejects.toThrow(/chain 5042\b.*5042002/);
  });

  it('needs an explicit RPC URL on mainnet', async () => {
    await expect(createClient({ network: 'mainnet' })).rejects.toThrow(InvalidInputError);
  });

  it('verifies the local factory, implementation and registry code hashes', async () => {
    const mf = await createClient({ network: localNetwork(localJson()), rpcUrl: LOCAL, transport: localRpc().transport() });
    expect(mf.requireAgents().factory).toBe(A(9));
    expect(mf.requireAgents().registry).toBe(REGISTRY);
    const bad = localNetwork(localJson({ agentFactoryCodeHash: keccak256('0x00') }));
    await expect(createClient({ network: bad, rpcUrl: LOCAL, transport: localRpc().transport() })).rejects.toThrow(/code hash/);
    const badRegistry = localNetwork(localJson({ agentRegistryCodeHash: keccak256('0x00') }));
    await expect(createClient({ network: badRegistry, rpcUrl: LOCAL, transport: localRpc().transport() })).rejects.toThrow(/policy registry .* code hash/);
  });

  it('refuses a factory whose implementation is not the pinned one', async () => {
    const rpc = localRpc().read(A(9), agentAccountFactoryAbi, 'implementation', A(11));
    await expect(createClient({ network: localNetwork(localJson()), rpcUrl: LOCAL, transport: rpc.transport() })).rejects.toThrow(/implementation/);
  });

  it('refuses a factory that reports another registry, and a registry of another factory', async () => {
    const other = localRpc().read(A(9), agentAccountFactoryAbi, 'registry', A(13));
    await expect(createClient({ network: localNetwork(localJson()), rpcUrl: LOCAL, transport: other.transport() })).rejects.toThrow(/reports registry/);
    const foreign = localRpc().read(REGISTRY, agentPolicyRegistryAbi, 'FACTORY', A(14));
    await expect(createClient({ network: localNetwork(localJson()), rpcUrl: LOCAL, transport: foreign.transport() })).rejects.toThrow(/belongs to factory/);
  });

  it('accepts custom books only for chain 31337 on a loopback RPC', async () => {
    expect(() => localNetwork(localJson({ chainId: 5042 }))).toThrow(NetworkMismatchError);
    await expect(createClient({ network: localNetwork(localJson()), rpcUrl: 'https://rpc.example.org', transport: localRpc().transport() })).rejects.toThrow(/loopback/);
    await expect(createClient({ network: { ...TESTNET, name: 'local' }, rpcUrl: LOCAL, transport: localRpc().transport() })).rejects.toThrow(/31337/);
  });

  it('refuses an API key from the other network', async () => {
    const rpc = new MockRpc(TESTNET.chainId);
    await expect(createClient({ network: 'testnet', apiKey: 'mfk_live_abc', transport: rpc.transport() })).rejects.toThrow(/other network/);
  });
});

describe('MockRpc logs', () => {
  it('filters eth_getLogs by address and positional topics', async () => {
    const rpc = new MockRpc(31337);
    const t = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
    rpc.logs = [
      { address: REGISTRY, topics: [t(1), t(0xaa)], data: '0x' },
      { address: REGISTRY, topics: [t(2), t(0xbb)], data: '0x' },
      { address: A(9), topics: [t(1), t(0xaa)], data: '0x' },
    ];
    const req = rpc.transport()({}).request as (a: { method: string; params: unknown[] }) => Promise<unknown[]>;
    expect(await req({ method: 'eth_getLogs', params: [{ address: REGISTRY, topics: [null, t(0xaa)] }] })).toHaveLength(1);
    expect(await req({ method: 'eth_getLogs', params: [{ address: REGISTRY }] })).toHaveLength(2);
  });
});
