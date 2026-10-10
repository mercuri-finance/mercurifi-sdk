import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { createClient } from '../src/client.js';
import { redactUrl, redactUrlsIn } from '../src/redact.js';
import { InvalidInputError, NetworkMismatchError, NotDeployedError } from '../src/errors.js';
import { localNetwork, MAINNET, TESTNET } from '../src/networks.js';
import { A, localJson, localRpc, REGISTRY } from './helpers/local.js';
import { MockRpc } from './helpers/mockRpc.js';
import { TESTNET_CODE, testnetRpc } from './helpers/testnet.js';

const LOCAL = 'http://127.0.0.1:8545';

describe('createClient', () => {
  it('connects to testnet with the default RPC and verifies the pinned agent deployment', async () => {
    const rpc = testnetRpc();
    const mf = await createClient({ network: 'testnet', transport: rpc.transport() });
    expect(mf.network.chainId).toBe(5042002);
    expect(mf.requireAgents()).toBe(TESTNET.agents);
    expect(rpc.methods('eth_getCode').map(([a]) => String(a).toLowerCase())).toEqual(
      [TESTNET_CODE.factory.address, TESTNET_CODE.implementation.address, TESTNET_CODE.registry.address].map((a) => a.toLowerCase()));
  });

  it('pins the live testnet runtime code: the fixture hashes to the book and a changed byte is refused', async () => {
    const agents = TESTNET.agents!;
    expect(keccak256(TESTNET_CODE.factory.code)).toBe(agents.factoryCodeHash);
    expect(keccak256(TESTNET_CODE.implementation.code)).toBe(agents.implementationCodeHash);
    expect(keccak256(TESTNET_CODE.registry.code)).toBe(agents.registryCodeHash);
    const tampered = testnetRpc();
    tampered.codes.set(agents.implementation.toLowerCase(), `${TESTNET_CODE.implementation.code.slice(0, -2)}00` as Hex);
    await expect(createClient({ network: 'testnet', transport: tampered.transport() })).rejects.toThrow(/implementation .* code hash/);
    const empty = new MockRpc(TESTNET.chainId);
    await expect(createClient({ network: 'testnet', transport: empty.transport() })).rejects.toThrow(NetworkMismatchError);
  });

  it('keeps mainnet without an agent deployment', async () => {
    expect(MAINNET.agents).toBeNull();
    const mf = await createClient({ network: 'mainnet', rpcUrl: 'https://rpc.example', transport: new MockRpc(MAINNET.chainId).transport() });
    expect(() => mf.requireAgents()).toThrow(NotDeployedError);
  });

  it('reads the head block fresh every time (no viem block-number cache)', async () => {
    const rpc = testnetRpc();
    const mf = await createClient({ network: 'testnet', transport: rpc.transport() });
    const first = await mf.publicClient.getBlockNumber();
    rpc.block.number += 5n;
    expect(await mf.publicClient.getBlockNumber()).toBe(first + 5n);
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

describe('createClient hardening', () => {
  it('does not resolve inherited names as networks', async () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expect(createClient({ network: n as never })).rejects.toThrow(InvalidInputError);
    }
  });

  it('rejects a malformed rpcUrl with InvalidInputError', async () => {
    const rpc = new MockRpc(TESTNET.chainId);
    for (const rpcUrl of ['not a url', '', 'ftp://host']) {
      await expect(createClient({ network: 'testnet', rpcUrl, transport: rpc.transport() })).rejects.toMatchObject({ name: 'InvalidInputError', field: 'rpcUrl' });
    }
  });

  it('gives an empty apiKey its own message', async () => {
    const rpc = new MockRpc(TESTNET.chainId);
    await expect(createClient({ network: 'testnet', apiKey: '', transport: rpc.transport() })).rejects.toThrow(/apiKey is empty/);
    await expect(createClient({ network: 'testnet', apiKey: '  ', transport: rpc.transport() })).rejects.toMatchObject({ field: 'apiKey' });
  });

  it('shows only the RPC host in surfaced errors', async () => {
    const secret = 'https://user:pw@rpc.example.org/v2/SECRETKEY123?k=SECRETKEY123';
    const failing = (() => ({ request: async () => { throw new Error(`fetch failed for ${secret}`); } })) as never;
    const err = await createClient({ network: 'mainnet', rpcUrl: secret, transport: failing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = JSON.stringify([(err as Error).message, (err as Error).stack, String((err as Error).cause)]);
    expect(text).not.toContain('SECRETKEY123');
    expect(text).not.toContain('pw@');
    expect((err as Error).message).toContain('rpc.example.org');
  });

  it('redacts URLs inside messages', () => {
    expect(redactUrlsIn('GET https://a.b/c/KEY failed, see http://x.y:8080/z?q=1')).toBe('GET a.b failed, see x.y:8080');
    expect(redactUrl('nonsense')).toBe('invalid URL');
    expect(redactUrlsIn('a ftp://f.g/KEY b javascript:x')).toBe('a f.g b invalid URL');
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
