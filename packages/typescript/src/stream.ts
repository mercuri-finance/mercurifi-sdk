import { InvalidInputError, StreamError } from './errors.js';
import { redactUrl } from './redact.js';

export interface StreamEvent { id: string | null; type: string; data: unknown }

export interface StreamOptions {
  signal?: AbortSignal;
  lastEventId?: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Stop after this many reconnects (tests); unlimited by default. */
  maxReconnects?: number;
  /** Reconnect when no bytes (not even a heartbeat) arrive for this long. The server pings every 15 s. Default 45 s. */
  idleTimeoutMs?: number;
}

const PUBLIC_TOPIC = /^(head|trades|launches|governance|pools|pool-trades|(token|trader|agent-account):0x[0-9a-f]{40}|pool:0x[0-9a-f]{64})$/;

/** Limits on untrusted input. The server's own events are far smaller. */
const MAX_LINE_CHARS = 64 * 1024; // one line, and so the unterminated tail kept between chunks
const MAX_EVENT_CHARS = 256 * 1024; // the data of one event
const MAX_ID_CHARS = 64;
const DEDUPE_WINDOW = 2048;
const MAX_RETRY_AFTER_MS = 300_000;
const EVENT_ID = /^[0-9A-Za-z._:-]+$/;
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

const validId = (id: string): boolean => id.length > 0 && id.length <= MAX_ID_CHARS && EVENT_ID.test(id);

/**
 * The server's topic rules plus `agent-account:0x…`; `account:` is reserved
 * (docs/architecture/api.md) and private topics need a browser session. Event type strings are passed through.
 */
export const validateTopics = (topics: readonly string[]): string[] => {
  if (!Array.isArray(topics) || topics.length === 0 || topics.length > 20) throw new InvalidInputError('topics', 'subscribe to 1 to at most 20 topics');
  return topics.map((raw) => {
    if (typeof raw !== 'string') throw new InvalidInputError('topics', 'a topic must be a string');
    const t = raw.trim().toLowerCase();
    if (t === 'orders' || t === 'follows') throw new InvalidInputError('topics', `${t} is private and needs a browser session`);
    if (t.startsWith('account:')) throw new InvalidInputError('topics', 'account: is reserved; use agent-account:0x… for an agent account');
    if (!PUBLIC_TOPIC.test(t)) throw new InvalidInputError('topics', `unknown topic ${raw.slice(0, 80)}`);
    return t;
  });
};

interface RawEvent { id: string | null; event: string | null; data: string; retry: number | null }

const tooLarge = (what: string) => new StreamError(`The stream sent ${what} over the size limit; the connection was dropped.`, null);

/** Parses an SSE body. Oversized lines or events throw a StreamError instead of growing without bound. */
async function* parseSse(stream: ReadableStream<Uint8Array>, onBytes: () => void): AsyncGenerator<RawEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let first = true;
  let ev: RawEvent = { id: null, event: null, data: '', retry: null };
  let hasData = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (!buffer.endsWith('\r')) return;
        buffer += '\n'; // a final CR held back as a possible CRLF half is a line end after all
      } else {
        onBytes();
        buffer += decoder.decode(value, { stream: true });
      }
      if (first) {
        buffer = buffer.replace(/^﻿/, '');
        first = false;
      }
      let pos = 0;
      for (;;) {
        const rest = buffer.slice(pos);
        const m = /\r\n|\n|\r/.exec(rest);
        if (m === null) break;
        // A lone CR at the very end may be the first half of CRLF: wait for the next chunk.
        if (m[0] === '\r' && m.index + 1 === rest.length) break;
        const line = rest.slice(0, m.index);
        pos += m.index + m[0].length;
        if (line.length > MAX_LINE_CHARS) throw tooLarge('a line');
        if (line === '') {
          if (hasData || ev.event !== null || ev.retry !== null) yield ev;
          ev = { id: null, event: null, data: '', retry: null };
          hasData = false;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') ev.id = val;
        else if (field === 'event') ev.event = val;
        else if (field === 'data') {
          if (ev.data.length + val.length + 1 > MAX_EVENT_CHARS) throw tooLarge('an event');
          ev.data = hasData ? `${ev.data}\n${val}` : val;
          hasData = true;
        } else if (field === 'retry' && /^\d{1,9}$/.test(val)) ev.retry = Number(val);
      }
      buffer = buffer.slice(pos);
      if (buffer.length > MAX_LINE_CHARS) throw tooLarge('a line');
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

const parseData = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const abortableSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Server-sent events with automatic reconnect. Resumes with Last-Event-ID, drops ids already delivered (the server can
 * replay an event twice around a resume), and yields `reset` (gap: refetch over HTTP) as an ordinary event.
 *
 * Everything on the wire is untrusted: lines, events and ids are size-capped, malformed events are skipped, the server's
 * `retry:` hint is clamped to the backoff range. Reconnects use jittered exponential backoff up to `maxBackoffMs`; a
 * connection that delivered anything starts the backoff over, so the server's scheduled 30-minute close (it sends
 * `reset` first) costs one short pause. The request carries the API key: nothing here logs it, and error messages name
 * the host only.
 */
export async function* openStream(request: { url: string; headers: Record<string, string> }, o: StreamOptions = {}): AsyncGenerator<StreamEvent> {
  if (o.lastEventId !== undefined && !validId(o.lastEventId)) throw new InvalidInputError('lastEventId', 'not a valid stream event id');
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis);
  const sleepFn = o.sleep;
  const sleep = (ms: number): Promise<void> => (sleepFn === undefined ? abortableSleep(ms, o.signal) : sleepFn(ms));
  const random = o.random ?? Math.random;
  const min = Math.max(1, o.minBackoffMs ?? 500);
  const max = Math.max(min, o.maxBackoffMs ?? 30_000);
  const idleMs = o.idleTimeoutMs ?? 45_000;
  const backoff = (attempt: number) => Math.round(Math.min(max, min * 2 ** Math.min(attempt, 30)) * (0.5 + random() / 2));
  const host = redactUrl(request.url);
  const aborted = () => o.signal?.aborted === true;
  const seen = new Set<string>(); // insertion-ordered: the oldest id leaves first
  let lastId = o.lastEventId ?? null;
  let attempt = 0;
  let reconnects = 0;
  const spent = () => o.maxReconnects !== undefined && reconnects++ >= o.maxReconnects;

  while (!aborted()) {
    const conn = new AbortController();
    const onAbort = () => conn.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (idle !== undefined) clearTimeout(idle);
      if (idleMs > 0) idle = setTimeout(() => conn.abort(), idleMs);
    };
    try {
      let response: Response;
      try {
        bump();
        response = await fetchImpl(request.url, {
          headers: { ...request.headers, Accept: 'text/event-stream', ...(lastId === null ? {} : { 'Last-Event-ID': lastId }) },
          redirect: 'manual', // never forward the API key to a redirect target
          signal: conn.signal,
        });
      } catch {
        if (aborted()) return;
        if (spent()) return;
        await sleep(backoff(attempt++));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        await response.body?.cancel().catch(() => undefined);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : backoff(attempt++);
        await sleep(wait);
        if (spent()) return;
        continue;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new StreamError(`The stream at ${host} was refused with HTTP ${response.status}.`, response.status);
      }

      let retryMs: number | null = null;
      let delivered = false;
      try {
        for await (const ev of parseSse(response.body, bump)) {
          if (ev.retry !== null) retryMs = Math.min(max, Math.max(min, ev.retry));
          if (ev.data === '' && ev.event === null) continue;
          const type = ev.event ?? 'message';
          if (!EVENT_TYPE.test(type) || (ev.id !== null && !validId(ev.id))) continue; // malformed: skipped, never trusted
          if (ev.id !== null) {
            if (seen.has(ev.id)) continue;
            seen.add(ev.id);
            if (seen.size > DEDUPE_WINDOW) seen.delete(seen.values().next().value as string);
            lastId = ev.id;
          }
          delivered = true;
          yield { id: ev.id, type, data: parseData(ev.data) };
        }
      } catch (error) {
        if (error instanceof StreamError) throw error;
        if (aborted()) return;
      }
      if (aborted()) return;
      if (delivered) attempt = 0;
      if (spent()) return;
      await sleep(retryMs ?? backoff(delivered ? 0 : attempt++));
    } finally {
      if (idle !== undefined) clearTimeout(idle);
      o.signal?.removeEventListener('abort', onAbort);
      conn.abort(); // releases the connection when the consumer stops early or after any exit
    }
  }
}
