// The SDK's JSON-RPC transport (parity with Python's Rpc.request): id, jsonrpc, a response size cap, and no RPC URL in
// any error. No socket opens: every fetch here is a stub.
import { createPublicClient } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/client.js';
import { extractRevertData } from '../src/revert.js';
import { MAX_RPC_RESPONSE_BYTES, rpcTransport, RpcTransportError } from '../src/rpcFetch.js';

const URL_ = 'http://127.0.0.1:1/v2/SECRETPATHKEY';
type Answer = (sent: { id: number; method: string }) => unknown;
const stub = (answer: Answer, init: { status?: number; headers?: Record<string, string> } = {}) =>
  vi.fn(async (_input: string | URL | Request, req?: RequestInit) => {
    const sent = JSON.parse(String(req?.body)) as { id: number; method: string };
    const body = answer(sent);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: init.headers ?? { 'content-type': 'application/json' },
    });
  });
const client = (
  f: ReturnType<typeof stub> | ((i: string | URL | Request, r?: RequestInit) => Promise<Response>),
  max?: number,
) => createPublicClient({ transport: rpcTransport(URL_, f, max) });

/** Every string reachable from an error: message, stack, own fields and the whole cause chain. */
const everything = (e: unknown): string => {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 20 && typeof cur === 'object' && cur !== null; i += 1) {
    out.push(String((cur as Error).message), String((cur as Error).stack));
    for (const v of Object.values(cur)) if (typeof v === 'string') out.push(v);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out.join('\n');
};

afterEach(() => vi.unstubAllGlobals());

describe('rpcTransport', () => {
  it('passes a JSON-RPC 2.0 answer to the request id through', async () => {
    expect(
      await client(stub((s) => ({ jsonrpc: '2.0', id: s.id, result: '0x7a69' }))).getChainId(),
    ).toBe(31337);
  });

  it.each([
    [
      'another id',
      (s: { id: number }) => ({ jsonrpc: '2.0', id: s.id + 1, result: '0x1' }),
      /id does not match/,
    ],
    [
      'the id as a string',
      (s: { id: number }) => ({ jsonrpc: '2.0', id: String(s.id), result: '0x1' }),
      /id does not match/,
    ],
    ['no id', () => ({ jsonrpc: '2.0', result: '0x1' }), /id does not match/],
    ['no jsonrpc', (s: { id: number }) => ({ id: s.id, result: '0x1' }), /not JSON-RPC 2.0/],
    [
      'jsonrpc 1.0',
      (s: { id: number }) => ({ jsonrpc: '1.0', id: s.id, result: '0x1' }),
      /not JSON-RPC 2.0/,
    ],
    [
      'an array',
      (s: { id: number }) => [{ jsonrpc: '2.0', id: s.id, result: '0x1' }],
      /not a JSON-RPC object/,
    ],
    ['not JSON', () => 'hello', /not JSON/],
    [
      'neither result nor error',
      (s: { id: number }) => ({ jsonrpc: '2.0', id: s.id }),
      /neither result nor error/,
    ],
  ] as const)('refuses %s, without the URL', async (_name, answer, pattern) => {
    const err = await client(stub(answer as Answer))
      .getChainId()
      .catch((e: unknown) => e);
    expect(rpcReason(err)).toMatch(pattern);
    expect(everything(err)).not.toContain('SECRETPATHKEY');
  });

  it('refuses a body over the cap, declared or streamed', async () => {
    const declared = stub((s) => ({ jsonrpc: '2.0', id: s.id, result: '0x1' }), {
      headers: { 'content-length': String(MAX_RPC_RESPONSE_BYTES + 1) },
    });
    expect(
      rpcReason(
        await client(declared)
          .getChainId()
          .catch((e: unknown) => e),
      ),
    ).toMatch(/larger than/);
    const streamed = stub((s) => ({ jsonrpc: '2.0', id: s.id, result: `0x${'00'.repeat(64)}` }));
    expect(
      rpcReason(
        await client(streamed, 100)
          .getChainId()
          .catch((e: unknown) => e),
      ),
    ).toMatch(/larger than 100 bytes/);
  });

  it('maps HTTP and socket failures to RPC_ERROR with the host only and no cause', async () => {
    const http = await client(stub(() => 'nope', { status: 503 }))
      .getChainId()
      .catch((e: unknown) => e);
    expect(rpcReason(http)).toBe('HTTP 503');
    const sock = await client(async () => {
      throw Object.assign(new TypeError(`fetch failed for ${URL_}`), {
        cause: new Error(`connect ECONNREFUSED ${URL_}`),
      });
    })
      .getChainId()
      .catch((e: unknown) => e);
    const t = findTransport(sock)!;
    expect(t.code).toBe('RPC_ERROR');
    expect(t.message).toContain('127.0.0.1:1');
    expect(t.cause).toBeUndefined();
    for (const e of [http, sock]) expect(everything(e)).not.toContain('SECRETPATHKEY');
  });

  it('keeps a JSON-RPC error answer (with revert data) so reverts still decode, URLs in its text reduced to hosts', async () => {
    const data = '0x08c379a0';
    const err = await client(
      stub((s) => ({
        jsonrpc: '2.0',
        id: s.id,
        error: { code: 3, message: `execution reverted via ${URL_}`, data },
      })),
    )
      .call({ to: '0x00000000000000000000000000000000000000aa', data: '0x' })
      .catch((e: unknown) => e);
    expect(extractRevertData(err)).toBe(data);
    expect(everything(err)).not.toContain('SECRETPATHKEY');
    // A 4xx/5xx carrying a JSON-RPC error is still the node's answer (as viem treats it).
    const e500 = await client(
      stub((s) => ({ jsonrpc: '2.0', id: s.id, error: { code: -32000, message: 'boom' } }), {
        status: 500,
      }),
    )
      .getChainId()
      .catch((e: unknown) => e);
    expect(findTransport(e500)).toBeNull();
  });

  it('is the transport createClient uses, and start-up names the failed check', async () => {
    // The right chain id under the wrong request id: without the check the chain test would pass.
    const fetchStub = stub((s) => ({ jsonrpc: '2.0', id: s.id + 1000, result: '0x4cef52' }));
    vi.stubGlobal('fetch', fetchStub);
    const err = await createClient({
      network: 'testnet',
      rpcUrl: 'http://127.0.0.1:1/key-abc',
    }).catch((e: unknown) => e);
    expect(fetchStub).toHaveBeenCalled();
    expect(String((err as Error).message)).toMatch(
      /start-up verification: the response id does not match the request/,
    );
    expect(everything(err)).not.toContain('key-abc');
  });
});

function findTransport(e: unknown): RpcTransportError | null {
  let cur: unknown = e;
  for (let i = 0; i < 20 && typeof cur === 'object' && cur !== null; i += 1) {
    if (cur instanceof RpcTransportError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
function rpcReason(e: unknown): string | undefined {
  return findTransport(e)?.reason;
}
