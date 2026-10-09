import { http, type HttpTransport } from 'viem';

/** Largest JSON-RPC response read into memory (the Python Rpc's MAX_RESPONSE_BYTES). */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

class RpcResponseCheckError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RpcResponseCheckError';
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RpcResponseCheckError(`the response is larger than ${maxBytes} bytes`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RpcResponseCheckError(`the response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const idOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : undefined);

/** One response object: JSON-RPC 2.0 and the id of the request it answers (a number, never a boolean or a string). */
function checkOne(sentId: unknown, body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RpcResponseCheckError('the response is not a JSON-RPC object');
  if ((body as { jsonrpc?: unknown }).jsonrpc !== '2.0') throw new RpcResponseCheckError('the response is not JSON-RPC 2.0');
  const id = idOf(body);
  if (typeof id !== 'number' || id !== sentId) throw new RpcResponseCheckError('the response id does not match the request');
}

/**
 * A fetch for viem's HTTP transport with the Python Rpc's response checks: the body is read up to
 * {@link MAX_RPC_RESPONSE_BYTES} (declared or streamed), and a 2xx body must be JSON-RPC 2.0 answering the request's own
 * id (each id once, for a batch). Anything else fails the request instead of being decoded.
 */
export const checkedRpcFetch = (inner?: FetchFn, maxBytes = MAX_RPC_RESPONSE_BYTES): FetchFn => async (input, init) => {
  const doFetch: FetchFn = inner ?? ((i, o) => globalThis.fetch(i, o));
  let sent: unknown;
  try {
    sent = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  } catch {
    sent = undefined;
  }
  const response = await doFetch(input, init);
  const text = await readCapped(response, maxBytes);
  if (response.ok) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcResponseCheckError('the response is not JSON');
    }
    if (Array.isArray(sent)) {
      if (!Array.isArray(body) || body.length !== sent.length) throw new RpcResponseCheckError('the batch response does not match the request');
      const want = new Set(sent.map(idOf));
      for (const item of body) {
        const id = idOf(item);
        if (!want.delete(id)) throw new RpcResponseCheckError('the response id does not match the request');
        checkOne(id, item);
      }
    } else {
      checkOne(idOf(sent), body);
    }
  }
  return new Response(text === '' ? null : text, { status: response.status, statusText: response.statusText, headers: { 'content-type': 'application/json' } });
};

/** The reason of an SDK response check found in an error's cause chain, or null. */
export const rpcCheckReason = (error: unknown): string | null => {
  let e: unknown = error;
  for (let i = 0; i < 8 && typeof e === 'object' && e !== null; i += 1) {
    if (e instanceof RpcResponseCheckError) return e.message;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
};

/** The SDK's HTTP transport: viem's, with the checked fetch and the same body cap. */
export const rpcTransport = (rpcUrl: string, inner?: FetchFn): HttpTransport =>
  http(rpcUrl, { retryCount: 2, timeout: 15_000, fetchFn: checkedRpcFetch(inner), maxResponseBodySize: MAX_RPC_RESPONSE_BYTES });
