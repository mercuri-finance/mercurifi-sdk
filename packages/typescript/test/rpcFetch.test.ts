// The checked JSON-RPC fetch (parity with Python's Rpc.request): id, jsonrpc and a response size cap. No socket opens:
// every fetch here is a stub.
import { createPublicClient } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/client.js';
import { checkedRpcFetch, MAX_RPC_RESPONSE_BYTES, rpcTransport } from '../src/rpcFetch.js';

type Answer = (sent: { id: number; method: string }) => unknown;
const stub = (answer: Answer, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { id: number; method: string };
    const body = answer(sent);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers });
  });

const call = (f: ReturnType<typeof checkedRpcFetch>, id: unknown = 7) =>
  f('http://127.0.0.1:1', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }) });

afterEach(() => vi.unstubAllGlobals());

describe('checkedRpcFetch', () => {
  it('passes a JSON-RPC 2.0 answer to the request id through', async () => {
    const r = await call(checkedRpcFetch(stub((s) => ({ jsonrpc: '2.0', id: s.id, result: '0x7a69' }))));
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 7, result: '0x7a69' });
  });

  it.each([
    ['another id', (s: { id: number }) => ({ jsonrpc: '2.0', id: s.id + 1, result: '0x1' }), /id does not match/],
    ['the id as a string', (s: { id: number }) => ({ jsonrpc: '2.0', id: String(s.id), result: '0x1' }), /id does not match/],
    ['no id', () => ({ jsonrpc: '2.0', result: '0x1' }), /id does not match/],
    ['no jsonrpc', (s: { id: number }) => ({ id: s.id, result: '0x1' }), /not JSON-RPC 2.0/],
    ['jsonrpc 1.0', (s: { id: number }) => ({ jsonrpc: '1.0', id: s.id, result: '0x1' }), /not JSON-RPC 2.0/],
    ['an array', (s: { id: number }) => [{ jsonrpc: '2.0', id: s.id, result: '0x1' }], /not a JSON-RPC object/],
    ['not JSON', () => 'hello', /not JSON/],
  ] as const)('refuses %s', async (_name, answer, pattern) => {
    await expect(call(checkedRpcFetch(stub(answer as Answer)))).rejects.toThrow(pattern);
  });

  it('refuses a body over the cap, declared or streamed', async () => {
    const declared = stub((s) => ({ jsonrpc: '2.0', id: s.id, result: '0x1' }), { 'content-length': String(MAX_RPC_RESPONSE_BYTES + 1) });
    await expect(call(checkedRpcFetch(declared))).rejects.toThrow(/larger than/);
    const streamed = stub((s) => ({ jsonrpc: '2.0', id: s.id, result: `0x${'00'.repeat(64)}` }));
    await expect(call(checkedRpcFetch(streamed, 100))).rejects.toThrow(/larger than 100 bytes/);
  });

  it('checks every id of a batch once', async () => {
    const f = checkedRpcFetch(async (_i, init) => {
      const sent = JSON.parse(String(init?.body)) as { id: number }[];
      return new Response(JSON.stringify(sent.map((s) => ({ jsonrpc: '2.0', id: sent[0]!.id, result: '0x1' }))), { status: 200 });
    });
    const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'a' }, { jsonrpc: '2.0', id: 2, method: 'b' }]);
    await expect(f('http://127.0.0.1:1', { method: 'POST', body })).rejects.toThrow(/id does not match/);
  });

  it('fails a viem request on a mismatched id instead of decoding it', async () => {
    const client = createPublicClient({ transport: rpcTransport('http://127.0.0.1:1', stub((s) => ({ jsonrpc: '2.0', id: s.id + 1, result: '0x7a69' }))) });
    await expect(client.getChainId()).rejects.toThrow(/id does not match/);
    const ok = createPublicClient({ transport: rpcTransport('http://127.0.0.1:1', stub((s) => ({ jsonrpc: '2.0', id: s.id, result: '0x7a69' }))) });
    expect(await ok.getChainId()).toBe(31337);
  });

  it('is the transport createClient uses', async () => {
    // The right chain id under the wrong request id: without the check the chain test would pass.
    const fetchStub = stub((s) => ({ jsonrpc: '2.0', id: s.id + 1000, result: '0x4cef52' }));
    vi.stubGlobal('fetch', fetchStub);
    const err = await createClient({ network: 'testnet', rpcUrl: 'http://127.0.0.1:1/key-abc' }).catch((e: unknown) => e);
    expect(fetchStub).toHaveBeenCalled();
    expect(String((err as Error).message)).toMatch(/start-up verification: the response id does not match the request/);
    expect(String((err as Error).message)).not.toContain('key-abc');
  });
});
