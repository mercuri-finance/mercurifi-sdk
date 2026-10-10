import { custom, type CustomTransport } from 'viem';

import { MercurifiError } from './errors.js';
import { redactUrl, redactUrlsIn } from './redact.js';

/** Largest JSON-RPC response read into memory (the Python Rpc's MAX_RESPONSE_BYTES). */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A transport or HTTP failure on the RPC path: host only, first line only, and no `cause`, so neither the message, the
 * stack nor a cause chain can carry the RPC URL (which often holds a provider key in its path). `reason` is the
 * credential-free part, for messages that name the failed check.
 */
export class RpcTransportError extends MercurifiError {
  readonly reason: string;

  constructor(host: string, reason: string) {
    super('RPC_ERROR', `The RPC request to ${host} failed: ${reason}`);
    this.name = 'RpcTransportError';
    this.reason = reason;
  }
}

/** The reason of an SDK transport failure found in an error's cause chain, or null. */
export const rpcCheckReason = (error: unknown): string | null => {
  let e: unknown = error;
  for (let i = 0; i < 16 && typeof e === 'object' && e !== null; i += 1) {
    if (e instanceof RpcTransportError) return e.reason;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
};

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
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
      return null;
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The SDK's HTTP JSON-RPC transport, with the Python Rpc's rules (rpc.py): bodies over {@link MAX_RPC_RESPONSE_BYTES}
 * (declared or streamed) fail; a body must be JSON-RPC 2.0 answering the request's own numeric id. A JSON-RPC error
 * answer is passed on as `{ code, message, data }` (URLs in the node's words reduced to hosts), so revert data still
 * decodes; every other failure is an {@link RpcTransportError}. The RPC URL is never part of any error.
 */
export const rpcTransport = (
  rpcUrl: string,
  inner?: FetchFn,
  maxBytes = MAX_RPC_RESPONSE_BYTES,
): CustomTransport => {
  const host = redactUrl(rpcUrl);
  // Anything the runtime says about the request may quote the URL (or just its path): both are cut before redaction.
  const path = (() => {
    try {
      const u = new URL(rpcUrl);
      return `${u.pathname}${u.search}`.length > 1 ? `${u.pathname}${u.search}` : null;
    } catch {
      return null;
    }
  })();
  const clean = (text: string): string => {
    let t = text.split(rpcUrl).join(host);
    if (path !== null) t = t.split(path).join('/…');
    return redactUrlsIn(t).split('\n')[0]!.slice(0, 200);
  };
  const fail = (reason: string) => new RpcTransportError(host, clean(reason));
  let nextId = 0;
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        nextId += 1;
        const id = nextId;
        const doFetch: FetchFn = inner ?? ((i, o) => globalThis.fetch(i, o));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let status = 0;
        let text: string | null = null;
        let failure: string | null = null;
        try {
          const response = await doFetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] }),
            signal: controller.signal,
            redirect: 'error',
          });
          status = response.status;
          text = await readCapped(response, maxBytes);
          if (text === null) failure = `the response is larger than ${maxBytes} bytes`;
        } catch (error) {
          // Only the error's name and own first line: its cause (undici's socket error, a DNS record) is dropped.
          failure = controller.signal.aborted
            ? `timed out after ${TIMEOUT_MS / 1000} s`
            : `${(error as Error)?.name ?? 'Error'}: ${String((error as Error)?.message ?? error)}`;
        } finally {
          clearTimeout(timer);
        }
        if (failure !== null) throw fail(failure);
        let body: unknown;
        try {
          body = JSON.parse(text ?? '');
        } catch {
          body = undefined;
        }
        const ok = status >= 200 && status < 300;
        // A non-2xx answer still counts when it is a well-formed JSON-RPC error for this request (viem's rule).
        if (!ok && !(isObject(body) && isObject(body.error) && typeof body.error.code === 'number'))
          throw fail(`HTTP ${status}`);
        if (body === undefined) throw fail('the response is not JSON');
        if (!isObject(body)) throw fail('the response is not a JSON-RPC object');
        if (body.jsonrpc !== '2.0') throw fail('the response is not JSON-RPC 2.0');
        if (typeof body.id !== 'number' || body.id !== id)
          throw fail('the response id does not match the request');
        if (body.error !== undefined && body.error !== null) {
          const e = body.error;
          if (!isObject(e) || typeof e.code !== 'number') throw fail('malformed JSON-RPC error');
          const message = typeof e.message === 'string' ? clean(e.message) : '';
          throw Object.assign(new Error(message), {
            code: e.code,
            ...(e.data === undefined ? {} : { data: e.data }),
          });
        }
        if (!('result' in body)) throw fail('the response has neither result nor error');
        return body.result;
      },
    },
    { key: 'mercurifi-http', name: 'Mercurifi HTTP JSON-RPC', retryCount: 2 },
  );
};
