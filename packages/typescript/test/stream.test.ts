import { describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/client.js';
import { InvalidInputError, StreamError } from '../src/errors.js';
import { openStream, validateTopics, type StreamEvent } from '../src/stream.js';
import { localJson, localRpc } from './helpers/local.js';
import { localNetwork } from '../src/networks.js';

const body = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
const sse = (status: number, chunks: string[] = [], headers: Record<string, string> = {}) => new Response(status === 200 ? body(chunks) : null, { status, headers });
const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const REQ = { url: 'https://x.example/v1/stream?topics=launches', headers: { 'X-Api-Key': 'mfk_test_k' } };
const nosleep = async () => undefined;
type Init = RequestInit & { headers: Record<string, string> };

describe('openStream', () => {
  it('parses events split across chunks and skips comments', async () => {
    const f = vi.fn(async () => sse(200, [': open\n\nid: 1-0\nevent: la', 'unch\ndata: {"a":1}\n\n: ping\n\n']));
    const events = await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep: nosleep }));
    expect(events).toEqual([{ id: '1-0', type: 'launch', data: { a: 1 } }]);
  });

  it('drops a duplicate id after a resume and sends Last-Event-ID (Review Focus 4)', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(sse(200, ['id: 1-0\nevent: trade\ndata: 1\n\nid: 2-0\nevent: trade\ndata: 2\n\n']))
      .mockResolvedValueOnce(sse(200, ['id: 2-0\nevent: trade\ndata: 2\n\nid: 3-0\nevent: trade\ndata: 3\n\n']));
    const events = await collect(openStream(REQ, { fetch: f, maxReconnects: 1, sleep: nosleep }));
    expect(events.map((e) => e.id)).toEqual(['1-0', '2-0', '3-0']);
    expect((f.mock.calls[1]![1] as Init).headers['Last-Event-ID']).toBe('2-0');
    expect((f.mock.calls[1]![1] as Init).headers['X-Api-Key']).toBe('mfk_test_k');
  });

  it('surfaces a reset as an explicit event', async () => {
    const f = vi.fn(async () => sse(200, ['event: reset\ndata: {}\n\n']));
    expect(await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep: nosleep }))).toEqual([{ id: null, type: 'reset', data: {} }]);
  });

  it('waits Retry-After on 429 and fails fast on 400', async () => {
    const sleep = vi.fn(async () => undefined);
    const f = vi.fn().mockResolvedValueOnce(sse(429, [], { 'Retry-After': '5' })).mockResolvedValueOnce(sse(200, []));
    await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep }));
    expect(sleep).toHaveBeenCalledWith(5_000);
    await expect(collect(openStream(REQ, { fetch: vi.fn(async () => sse(400)), sleep }))).rejects.toThrow(StreamError);
  });

  it('validates topics like the server, plus agent-account topics', () => {
    expect(validateTopics(['launches', 'agent-account:0x' + 'A'.repeat(40)])).toEqual(['launches', 'agent-account:0x' + 'a'.repeat(40)]);
    expect(() => validateTopics(['account:0x' + 'a'.repeat(40)])).toThrow(/reserved/);
    expect(() => validateTopics(['orders'])).toThrow(/browser session/);
    expect(() => validateTopics(['nope'])).toThrow(/unknown topic/);
    expect(() => validateTopics(Array(21).fill('launches'))).toThrow(/at most 20/);
  });

  it('never puts the key or the URL path in an error', async () => {
    const req = { url: 'https://x.example/secret-path/v1/stream?topics=launches&k=SECRETQ', headers: { 'X-Api-Key': 'mfk_live_SECRET' } };
    const error = await collect(openStream(req, { fetch: vi.fn(async () => sse(403)), sleep: nosleep })).catch((e: unknown) => e as StreamError);
    expect(error).toBeInstanceOf(StreamError);
    expect((error as StreamError).status).toBe(403);
    const text = String((error as StreamError).message) + JSON.stringify(error);
    expect(text).not.toMatch(/SECRET|secret-path/);
    expect(text).toContain('x.example');
  });

  it('refuses redirects so the key is not forwarded', async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
    await expect(collect(openStream(REQ, { fetch: f as unknown as typeof fetch, sleep: nosleep }))).rejects.toThrow(/HTTP 302/);
    expect(f.mock.calls[0]![1]!.redirect).toBe('manual');
  });

  it('handles CRLF split across chunks and CR line ends without a phantom event', async () => {
    const f = vi.fn(async () => sse(200, ['id: 1-0\r', '\nevent: trade\r\ndata: 1\r\n\r', '\n', 'id: 2-0\revent: trade\rdata: 2\r\r']));
    const events = await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep: nosleep }));
    expect(events).toEqual([{ id: '1-0', type: 'trade', data: 1 }, { id: '2-0', type: 'trade', data: 2 }]);
  });

  it('joins multi-line data and keeps non-JSON data as text', async () => {
    const f = vi.fn(async () => sse(200, ['event: note\ndata: a\ndata: b\n\n']));
    expect(await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep: nosleep }))).toEqual([{ id: null, type: 'note', data: 'a\nb' }]);
  });

  it('skips malformed events (bad type or id) and carries on', async () => {
    const f = vi.fn(async () => sse(200, ['event: <script>\ndata: 1\n\nid: bad id!\nevent: trade\ndata: 2\n\nid: 5-0\nevent: trade\ndata: 3\n\n']));
    expect(await collect(openStream(REQ, { fetch: f, maxReconnects: 0, sleep: nosleep }))).toEqual([{ id: '5-0', type: 'trade', data: 3 }]);
  });

  it('refuses an oversized line, event or unterminated buffer', async () => {
    const big = 'x'.repeat(70 * 1024);
    for (const chunks of [[`data: ${big}\n\n`], [big], [`data: ${'y'.repeat(60_000)}\n`.repeat(6) + '\n']]) {
      const f = vi.fn(async () => sse(200, chunks));
      await expect(collect(openStream(REQ, { fetch: f, sleep: nosleep }))).rejects.toThrow(/size limit/);
    }
  });

  it('reconnects after a server max-life reset with a short pause, not an alarm', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const f = vi.fn()
      .mockResolvedValueOnce(sse(200, ['id: 1-0\nevent: trade\ndata: 1\n\nevent: reset\ndata: {}\n\n']))
      .mockResolvedValueOnce(sse(200, ['id: 2-0\nevent: trade\ndata: 2\n\n']));
    const events = await collect(openStream(REQ, { fetch: f, maxReconnects: 1, sleep, random: () => 0.5 }));
    expect(events.map((e) => e.type)).toEqual(['trade', 'reset', 'trade']);
    expect(sleep).toHaveBeenCalledWith(375); // first-step backoff (500 ms at jitter 0.75), not grown
    expect((f.mock.calls[1]![1] as Init).headers['Last-Event-ID']).toBe('1-0');
  });

  it('backs off exponentially with jitter up to a ceiling on connection failures', async () => {
    const waits: number[] = [];
    const f = vi.fn(async () => { throw new Error('connect ECONNREFUSED https://x.example/secret'); });
    await collect(openStream(REQ, { fetch: f, maxReconnects: 6, minBackoffMs: 100, maxBackoffMs: 500, random: () => 1, sleep: async (ms) => { waits.push(ms); } }));
    expect(waits).toEqual([100, 200, 400, 500, 500, 500]);
    const lows: number[] = [];
    await collect(openStream(REQ, { fetch: f, maxReconnects: 2, minBackoffMs: 100, maxBackoffMs: 500, random: () => 0, sleep: async (ms) => { lows.push(ms); } }));
    expect(lows).toEqual([50, 100]);
  });

  it('clamps a hostile retry hint and Retry-After', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const f = vi.fn().mockResolvedValueOnce(sse(200, ['retry: 999999999\ndata: 1\n\n'])).mockResolvedValueOnce(sse(429, [], { 'Retry-After': '99999999' }));
    await collect(openStream(REQ, { fetch: f, maxReconnects: 1, sleep }));
    expect(sleep.mock.calls.map((c: unknown[]) => c[0])).toEqual([30_000, 300_000]);
  });

  it('bounds the dedupe window', async () => {
    const many = Array.from({ length: 2100 }, (_, i) => `id: ${i}-0\nevent: t\ndata: ${i}\n\n`).join('');
    const f = vi.fn().mockResolvedValueOnce(sse(200, [many])).mockResolvedValueOnce(sse(200, ['id: 0-0\nevent: t\ndata: 0\n\nid: 2099-0\nevent: t\ndata: 2099\n\n']));
    const events = await collect(openStream(REQ, { fetch: f, maxReconnects: 1, sleep: nosleep }));
    // 0-0 fell out of the 2048-id window and is delivered again; 2099-0 is still remembered.
    expect(events.filter((e) => e.id === '0-0')).toHaveLength(2);
    expect(events.filter((e) => e.id === '2099-0')).toHaveLength(1);
  });

  it('stops cleanly on abort, mid-stream and while backing off, and cancels the connection', async () => {
    const ac = new AbortController();
    let cancelled = false;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('id: 1-0\nevent: t\ndata: 1\n\n')); init?.signal?.addEventListener('abort', () => { cancelled = true; try { c.error(new Error('aborted')); } catch { /* closed */ } }); },
    }), { status: 200 }));
    const out: StreamEvent[] = [];
    for await (const ev of openStream(REQ, { fetch: f as unknown as typeof fetch, signal: ac.signal })) {
      out.push(ev);
      ac.abort();
    }
    expect(out).toHaveLength(1);
    expect(cancelled).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    // already aborted: no request at all
    expect(await collect(openStream(REQ, { fetch: f as unknown as typeof fetch, signal: ac.signal }))).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('aborts the default backoff sleep', async () => {
    const ac = new AbortController();
    const f = vi.fn(async () => { throw new Error('down'); });
    const run = collect(openStream(REQ, { fetch: f, signal: ac.signal, minBackoffMs: 60_000, maxBackoffMs: 60_000 }));
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await run).toEqual([]);
  });

  it('reconnects when the connection goes silent past the idle timeout', async () => {
    let n = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (n++ > 0) return sse(200, ['id: 9-0\nevent: t\ndata: 9\n\n']);
      return new Response(new ReadableStream<Uint8Array>({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new Error('idle'))); } }), { status: 200 });
    });
    const events = await collect(openStream(REQ, { fetch: f as unknown as typeof fetch, idleTimeoutMs: 20, maxReconnects: 1, sleep: nosleep }));
    expect(events.map((e) => e.id)).toEqual(['9-0']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed lastEventId', async () => {
    await expect(collect(openStream(REQ, { lastEventId: 'a b\nc', fetch: vi.fn() }))).rejects.toThrow(InvalidInputError);
  });
});

describe('MercurifiClient.stream', () => {
  it('validates topics, builds the request from the API and needs one', async () => {
    const streamRequest = vi.fn((topics: readonly string[]) => ({ url: `https://api.example/v1/stream?topics=${topics.join(',')}`, headers: { 'X-Api-Key': 'mfk_test_k' } }));
    const api = { streamRequest } as never;
    const mf = await createClient({ network: localNetwork(localJson()), rpcUrl: 'http://127.0.0.1:8545', transport: localRpc().transport(), api });
    const f = vi.fn(async () => sse(200, ['id: 1-0\nevent: trade\ndata: 1\n\n']));
    const events = await collect(mf.stream(['Trades', 'agent-account:0x' + 'B'.repeat(40)], { fetch: f, maxReconnects: 0, sleep: nosleep }));
    expect(streamRequest).toHaveBeenCalledWith(['trades', 'agent-account:0x' + 'b'.repeat(40)]);
    expect(events).toHaveLength(1);
    expect(() => mf.stream(['account:0x' + 'b'.repeat(40)])).toThrow(/reserved/);
    const keyless = await createClient({ network: localNetwork(localJson()), rpcUrl: 'http://127.0.0.1:8545', transport: localRpc().transport(), api: null });
    expect(() => keyless.stream(['trades'])).toThrow(InvalidInputError);
  });
});
