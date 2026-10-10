import { readFileSync } from 'node:fs';
import { createPublicClient, encodeErrorResult, toEventSelector, toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError } from '../src/errors.js';
import {
  AGENT_ACCOUNT_SERVICE, agentIdFromReceipt, agentUriProblem, buildRegistrationFile, encodeRegister, encodeSetAgentURI, ERC8004_REGISTRIES,
  erc8004Registries, getAgent, identityRegistryAbi, registrationDataUri, registrationFileJson, type IdentityReceiptLike, type RegistrationFileParams,
} from '../src/identity.js';
import * as sdk from '../src/index.js';
import { MockRpc } from './helpers/mockRpc.js';

interface FileCase { name: string; input: Record<string, unknown>; json: string; dataUri: string }
interface RefuseCase { name: string; input: Record<string, unknown>; field: string; pyField: string; error: string }
const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/identity.json', import.meta.url), 'utf8')) as {
  registries: Record<'testnet' | 'mainnet', Record<string, unknown>>;
  selectors: Record<string, Hex>;
  events: Record<string, Hex>;
  register: { agentURI: string; data: Hex }[];
  setAgentURI: { agentId: string; agentURI: string; data: Hex }[];
  agentUriProblems: { uri: string; problem: string | null }[];
  files: FileCase[];
  refuse: RefuseCase[];
  receipt: { transactionHash: Hex; status: Hex; logs: { address: Address; topics: Hex[]; data: Hex }[] };
  receiptExpect: { agentId: string; owner: Address; agentURI: string };
};
const params = (input: Record<string, unknown>): RegistrationFileParams =>
  ({ ...input, ...(input.agentId !== undefined ? { agentId: BigInt(input.agentId as string) } : {}) }) as unknown as RegistrationFileParams;
const receipt = (): IdentityReceiptLike => ({ transactionHash: v.receipt.transactionHash, status: v.receipt.status === '0x1' ? 'success' : 'reverted', logs: v.receipt.logs });
const TESTNET = ERC8004_REGISTRIES.testnet;

describe('ERC-8004 registries and ABI (shared vectors)', () => {
  it('pins the per-network addresses', () => {
    expect(ERC8004_REGISTRIES).toEqual(v.registries);
  });
  it('uses the selectors and topics found in the deployed implementation', () => {
    for (const [sig, sel] of Object.entries(v.selectors)) expect(toFunctionSelector(`function ${sig}`)).toBe(sel);
    const fns = identityRegistryAbi.filter((i) => i.type === 'function').map((i) => toFunctionSelector(i));
    expect(new Set(fns)).toEqual(new Set(Object.values(v.selectors)));
    const events = identityRegistryAbi.filter((i) => i.type === 'event').map((i) => toEventSelector(i));
    expect(new Set(events)).toEqual(new Set(Object.values(v.events)));
  });
  it('keeps mainnet refused while Agent Accounts are not deployed there', () => {
    expect(() => erc8004Registries('mainnet')).toThrow(NotDeployedError);
    expect(() => encodeRegister({ network: 'mainnet', agentURI: 'https://a.example/a.json' })).toThrow(NotDeployedError);
    expect(() => erc8004Registries('local' as never)).toThrow(InvalidInputError);
  });
  it('is exported from the package entry', () => {
    expect(sdk.buildRegistrationFile).toBe(buildRegistrationFile);
    expect(sdk.encodeRegister).toBe(encodeRegister);
    expect(sdk.getAgent).toBe(getAgent);
  });
});

describe('calldata for the caller\'s own wallet', () => {
  it.each(v.register)('register($agentURI)', ({ agentURI, data }) => {
    expect(encodeRegister({ network: 'testnet', agentURI })).toEqual({ chainId: 5042002, to: TESTNET.identityRegistry, data, value: 0n });
  });
  it.each(v.setAgentURI)('setAgentURI($agentId, $agentURI)', ({ agentId, agentURI, data }) => {
    expect(encodeSetAgentURI({ network: 'testnet', agentId: BigInt(agentId), agentURI })).toEqual({ chainId: 5042002, to: TESTNET.identityRegistry, data, value: 0n });
  });
  it('refuses an unusable agent URI or id', () => {
    expect(() => encodeRegister({ network: 'testnet', agentURI: 'http://a.example/a.json' })).toThrow(InvalidInputError);
    expect(() => encodeSetAgentURI({ network: 'testnet', agentId: -1n, agentURI: 'https://a.example/a.json' })).toThrow(/agentId/);
    expect(() => encodeSetAgentURI({ network: 'testnet', agentId: 1 as never, agentURI: 'https://a.example/a.json' })).toThrow(/agentId/);
  });
  it.each(v.agentUriProblems)('agentUriProblem($uri) is $problem', ({ uri, problem }) => {
    expect(agentUriProblem(uri)).toBe(problem);
  });
});

describe('buildRegistrationFile (shared vectors)', () => {
  it.each(v.files)('$name gives the canonical JSON and data URI', ({ input, json, dataUri }) => {
    const file = buildRegistrationFile(params(input));
    expect(registrationFileJson(file)).toBe(json);
    expect(registrationDataUri(file)).toBe(dataUri);
    expect(agentUriProblem(registrationDataUri(file))).toBeNull();
  });
  it('links the account as a service entry, never as the agent wallet', () => {
    const file = buildRegistrationFile(params(v.files[0]!.input));
    expect(file.services[0]).toEqual({ name: AGENT_ACCOUNT_SERVICE, endpoint: 'eip155:5042002:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
    expect(JSON.stringify(file)).not.toMatch(/agentWallet/);
  });
  it.each(v.refuse)('refuses $name', ({ input, field, error }) => {
    let err: unknown;
    try {
      buildRegistrationFile(params(input));
    } catch (e) {
      err = e;
    }
    expect(err, 'was accepted').toBeInstanceOf(InvalidInputError);
    expect((err as InvalidInputError).field).toBe(field);
    expect((err as Error).message).toContain(error);
  });
  it('refuses wrong types and unknown service fields', () => {
    const base = { network: 'testnet', account: TESTNET.identityRegistry, name: 'a' } as const;
    expect(() => buildRegistrationFile({ ...base, active: 'yes' as never })).toThrow(/active/);
    expect(() => buildRegistrationFile({ ...base, x402Support: 1 as never })).toThrow(/x402Support/);
    expect(() => buildRegistrationFile({ ...base, services: [{ name: 'web', endpoint: 'https://a.example', url: 'x' } as never] })).toThrow(/unknown field url/);
    expect(() => buildRegistrationFile({ ...base, agentId: 5 as never })).toThrow(/agentId/);
  });
});

describe('agentIdFromReceipt', () => {
  it('reads the Registered log of a real testnet register(string) receipt', () => {
    expect(agentIdFromReceipt({ network: 'testnet', receipt: receipt() })).toEqual({
      agentId: BigInt(v.receiptExpect.agentId), owner: v.receiptExpect.owner, agentURI: v.receiptExpect.agentURI,
    });
  });
  it('falls back to the mint Transfer without a Registered log', () => {
    const logs = v.receipt.logs.filter((l) => l.topics[0] === v.events['Transfer(address,address,uint256)']);
    expect(agentIdFromReceipt({ network: 'testnet', receipt: { ...receipt(), logs } })).toEqual({
      agentId: BigInt(v.receiptExpect.agentId), owner: v.receiptExpect.owner, agentURI: null,
    });
  });
  it('ignores logs from any other address', () => {
    const logs = v.receipt.logs.map((l) => ({ ...l, address: '0x000000000000000000000000000000000000dEaD' as Address }));
    expect(() => agentIdFromReceipt({ network: 'testnet', receipt: { ...receipt(), logs } })).toThrow(/no agent registration event/);
  });
  it('refuses a reverted receipt and two registrations', () => {
    expect(() => agentIdFromReceipt({ network: 'testnet', receipt: { ...receipt(), status: 'reverted' } })).toThrow(/reverted/);
    const twice = { ...receipt(), logs: [...v.receipt.logs, ...v.receipt.logs] };
    expect(() => agentIdFromReceipt({ network: 'testnet', receipt: twice })).toThrow(MercurifiError);
  });
});

describe('getAgent', () => {
  const OWNER = v.receiptExpect.owner;
  const client = (rpc: MockRpc) => createPublicClient({ transport: rpc.transport() });
  const mocked = (chainId = 5042002) =>
    new MockRpc(chainId)
      .read(TESTNET.identityRegistry, identityRegistryAbi, 'ownerOf', OWNER)
      .read(TESTNET.identityRegistry, identityRegistryAbi, 'tokenURI', 'https://agentcard.example.com/agent-9258.json')
      .read(TESTNET.identityRegistry, identityRegistryAbi, 'getAgentWallet', OWNER);
  it('reads owner, URI and agent wallet', async () => {
    expect(await getAgent(client(mocked()), { network: 'testnet', agentId: 897205n })).toEqual({
      agentId: 897205n, owner: OWNER, agentURI: 'https://agentcard.example.com/agent-9258.json', agentWallet: OWNER,
    });
  });
  it('refuses an RPC on another chain', async () => {
    await expect(getAgent(client(mocked(5042)), { network: 'testnet', agentId: 1n })).rejects.toBeInstanceOf(NetworkMismatchError);
  });
  it('reports an unknown id as AGENT_NOT_FOUND', async () => {
    const nonexistent = encodeErrorResult({
      abi: [{ type: 'error', name: 'ERC721NonexistentToken', inputs: [{ name: 'tokenId', type: 'uint256' }] }], errorName: 'ERC721NonexistentToken', args: [9n],
    });
    const rpc = mocked().revert(TESTNET.identityRegistry, identityRegistryAbi, 'ownerOf', nonexistent);
    await expect(getAgent(client(rpc), { network: 'testnet', agentId: 9n })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });
  it('keeps the RPC URL out of a transport failure', async () => {
    const SECRET = 'SUPERSECRETKEY123';
    const rpc = mocked();
    rpc.on('eth_call', () => {
      throw new Error(`fetch failed for https://rpc.example/v2/${SECRET}`);
    });
    const err = await getAgent(client(rpc), { network: 'testnet', agentId: 1n }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'RPC_ERROR' });
    expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(SECRET);
  });
});
