import { InvalidInputError, StreamError } from './errors.js';
import { redactUrl } from './redact.js';

/**
 * One server event. `data` is untrusted external content (token names, symbols and other user-supplied text arrive
 * here): validate it before use and never feed it to an LLM unfiltered. A `reset` event means "refetch over HTTP, you
 * may have missed events"; it also arrives about every 30 minutes by design, when the server recycles the connection.
 */
export interface StreamEvent { id: string | null; type: string; data: unknown }

/** Passed to `onReconnect` before each wait. `reason` is a fixed, redacted label: it never contains the URL or the key. */
export interface ReconnectInfo { attempt: number; delayMs: number; reason: string }

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
  /** A connection must live this long (default 10 s) before the next failure starts the backoff over. */
  healthyAfterMs?: number;
  /**
   * Called before every reconnect wait. Without it the stream retries silently: a dead server or a rejected key (401 on a
   * retryable path, 5xx) loops with backoff and no signal, so pass this to log, count or give up (abort the signal).
   */
  onReconnect?: (info: ReconnectInfo) => void;
  /** Clock for connection lifetimes (tests). */
  now?: () => number;
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
async function* parseSse(stream: ReadableStream<Uint8Array>, beforeRead: () => void, afterRead: () => void): AsyncGenerator<RawEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ev: RawEvent = { id: null, event: null, data: '', retry: null };
  let hasData = false;
  try {
    for (;;) {
      beforeRead();
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } finally {
        afterRead();
      }
      const { value, done } = result;
      if (done) {
        if (!buffer.endsWith('\r')) return;
        buffer += '\n'; // a final CR held back as a possible CRLF half is a line end after all
      } else {
        buffer += decoder.decode(value, { stream: true }); // TextDecoder drops a leading BOM itself
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
 * `retry:` hint and `Retry-After` are clamped. Reconnects use jittered exponential backoff up to `maxBackoffMs`. The
 * backoff starts over only after a connection has lived `healthyAfterMs` (10 s); delivering events, or a `reset`, does
 * not count, so a server or proxy that sends one event and closes cannot make every client reconnect in a tight loop.
 * Server hints (`retry:`, `Retry-After`) are jittered upwards and never undercut the backoff after a short connection.
 *
 * The stream is silent about reconnects unless you pass `onReconnect`; a dead server or a retryable auth failure
 * otherwise retries forever. The request carries the API key: nothing here logs it, error messages name the host only
 * and `onReconnect` reasons are fixed labels.
 */
export async function* openStream(request: { url: string; headers: Record<string, string> }, o: StreamOptions = {}): AsyncGenerator<StreamEvent> {
  if (o.lastEventId !== undefined && !validId(o.lastEventId)) throw new InvalidInputError('lastEventId', 'not a valid stream event id');
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis);
  const sleepFn = o.sleep;
  const sleep = (ms: number): Promise<void> => (sleepFn === undefined ? abortableSleep(ms, o.signal) : sleepFn(ms));
  const random = o.random ?? Math.random;
  const now = o.now ?? Date.now;
  const min = Math.max(1, o.minBackoffMs ?? 500);
  const max = Math.max(min, o.maxBackoffMs ?? 30_000);
  const idleMs = o.idleTimeoutMs ?? 45_000;
  const healthyMs = o.healthyAfterMs ?? 10_000;
  const backoff = (n: number) => Math.round(Math.min(max, min * 2 ** Math.min(n, 30)) * (0.5 + random() / 2));
  const jitterUp = (ms: number) => Math.round(ms * (1 + random() / 2)); // server hints are minimums: only ever lengthen them
  const host = redactUrl(request.url);
  const aborted = () => o.signal?.aborted === true;
  const seen = new Set<string>(); // insertion-ordered: the oldest id leaves first
  let lastId = o.lastEventId ?? null;
  let attempt = 0; // consecutive short-lived or failed connections
  let reconnects = 0;
  const spent = () => o.maxReconnects !== undefined && reconnects++ >= o.maxReconnects;
  const notify = (reason: string, delayMs: number) => {
    try {
      o.onReconnect?.({ attempt, delayMs, reason });
    } catch {
      // a throwing observer must not break the stream
    }
  };

  while (!aborted()) {
    const conn = new AbortController();
    const onAbort = () => conn.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let idleFired = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    // Armed only while waiting on the network, so a slow consumer never looks like a silent server.
    const arm = () => {
      disarm();
      if (idleMs > 0) idle = setTimeout(() => { idleFired = true; conn.abort(); }, idleMs);
    };
    const disarm = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = undefined;
    };
    try {
      let response: Response;
      const startedAt = now();
      try {
        arm();
        response = await fetchImpl(request.url, {
          headers: { ...request.headers, Accept: 'text/event-stream', ...(lastId === null ? {} : { 'Last-Event-ID': lastId }) },
          redirect: 'manual', // never forward the API key to a redirect target
          signal: conn.signal,
        });
      } catch {
        if (aborted()) return;
        if (spent()) return;
        const delay = backoff(attempt);
        attempt++;
        notify(idleFired ? 'connection timed out' : 'network error', delay);
        await sleep(delay);
        continue;
      } finally {
        disarm();
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        await response.body?.cancel().catch(() => undefined);
        const own = backoff(attempt);
        const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(jitterUp(retryAfter * 1000), MAX_RETRY_AFTER_MS) : 0;
        const delay = Math.max(own, hinted);
        attempt++;
        notify(`HTTP ${response.status}`, delay);
        await sleep(delay);
        if (spent()) return;
        continue;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new StreamError(`The stream at ${host} was refused with HTTP ${response.status}.`, response.status);
      }

      let retryMs: number | null = null;
      let ended = 'stream ended';
      try {
        for await (const ev of parseSse(response.body, arm, disarm)) {
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
          yield { id: ev.id, type, data: parseData(ev.data) };
        }
      } catch (error) {
        if (error instanceof StreamError) throw error;
        if (aborted()) return;
        ended = idleFired ? 'idle timeout' : 'stream error';
      }
      if (aborted()) return;
      if (now() - startedAt >= healthyMs) attempt = 0;
      const own = backoff(attempt);
      const delay = retryMs === null ? own : Math.max(own, jitterUp(retryMs));
      attempt++;
      if (spent()) return;
      notify(ended, delay);
      await sleep(delay);
    } finally {
      disarm();
      o.signal?.removeEventListener('abort', onAbort);
      conn.abort(); // releases the connection when the consumer stops early or after any exit
    }
  }
}
