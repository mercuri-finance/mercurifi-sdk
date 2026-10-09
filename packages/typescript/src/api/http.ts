import { isAddress, isHex, type Address, type Hex } from 'viem';

import { ApiError, InvalidInputError, MercurifiError } from '../errors.js';
import { isLoopbackUrl } from '../networks.js';
import { redactUrlsIn } from '../redact.js';
import type {
  ApiAccount, ApiAccountSummary, ApiAction, ApiQuote, ApiToken, BuildRequest, BuiltTx, ImageUpload, LaunchMetadata,
  MercurifiApi, Page, QuoteKind, QuoteRequest, UploadedMetadata,
} from './types.js';

export interface HttpApiOptions { baseUrl: string; chainId: number; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }

interface ErrorBody { error?: { code?: unknown; message?: unknown } }
interface Answer { body: unknown; headers: Headers }
type Init = { method?: string; json?: unknown; form?: FormData };

/** A response larger than this is refused unread (the largest legitimate answer is a page of actions). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Items per list answer; the API pages far below this. */
const MAX_ITEMS = 1_000;
const MAX_CURSOR = 256;
const CURSOR = /^[A-Za-z0-9_\-.:=~]+$/;
const DECIMAL = /^\d{1,78}$/;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

const bad = (path: string, what: string): MercurifiError => new MercurifiError('API_BAD_RESPONSE', `The API answered ${path} with something unexpected (${what}); it was ignored.`);

/** Server text is untrusted: no control or format characters, no URLs, bounded. */
const cleanText = (value: unknown, max = 200): string => {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\p{Cf}+/gu, '');
  const chars = Array.from(redactUrlsIn(plain).trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : chars.join('');
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAddr = (v: unknown): v is Address => typeof v === 'string' && isAddress(v, { strict: false });

const addressParam = (field: string, value: unknown): string => {
  if (!isAddr(value)) throw new InvalidInputError(field, `${field} is not an address`);
  return value.toLowerCase();
};

/**
 * fetch-based MercurifiApi. Sends `X-Api-Key` when given; never sends anything that could sign or move funds.
 * Answers are untrusted: shapes are checked, sizes and page counts are bounded, redirects are refused (the key must
 * not follow one), and nothing here is ever a reason to sign (see verifyBuiltTx).
 * Paths and bodies follow the Mercurifi API (`/v1/openapi.json`); this is the only file that knows them.
 */
export class HttpApi implements MercurifiApi {
  readonly baseUrl: string;
  readonly chainId: number;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(o: HttpApiOptions) {
    let url: URL;
    try {
      url = new URL(o.baseUrl);
    } catch {
      throw new InvalidInputError('apiBaseUrl', 'the API base URL is not a valid URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(o.baseUrl))) throw new InvalidInputError('apiBaseUrl', 'the API base URL must use https (http is allowed for loopback only)');
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new InvalidInputError('apiBaseUrl', 'the API base URL must not carry credentials, a query or a fragment');
    this.baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    if (!Number.isInteger(o.chainId) || o.chainId < 1) throw new InvalidInputError('chainId', 'chainId must be a positive integer');
    this.chainId = o.chainId;
    if (o.apiKey !== undefined && (typeof o.apiKey !== 'string' || o.apiKey.trim() === '')) throw new InvalidInputError('apiKey', 'apiKey is empty');
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = o.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new InvalidInputError('timeoutMs', 'timeoutMs must be a positive integer (milliseconds)');
    this.#timeoutMs = timeoutMs;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, chainId: this.chainId, apiKey: this.#apiKey === undefined ? null : '[redacted]' };
  }

  [INSPECT](): string {
    return `HttpApi { baseUrl: '${this.baseUrl}', chainId: ${this.chainId}, apiKey: ${this.#apiKey === undefined ? 'none' : '[redacted]'} }`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: 'application/json', ...(this.#apiKey === undefined ? {} : { 'X-Api-Key': this.#apiKey }), ...extra };
  }

  private async readBody(response: Response, path: string): Promise<string> {
    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw bad(path, 'too large');
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw bad(path, 'too large');
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  private async send(path: string, init: Init = {}): Promise<Answer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await this.readBody(response, path);
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const e = isObject(body) ? (body as ErrorBody).error : undefined;
        const code = isObject(e) && typeof e.code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(e.code) ? e.code : 'http_error';
        const message = isObject(e) && typeof e.message === 'string' && cleanText(e.message) !== '' ? cleanText(e.message) : `HTTP ${response.status} from ${path}`;
        const retry = Number(response.headers.get('Retry-After'));
        throw new ApiError(response.status, code, message, Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : null);
      }
      return { body, headers: response.headers };
    } catch (error) {
      if (error instanceof MercurifiError) throw error;
      const reason = timedOut ? `timed out after ${this.#timeoutMs} ms` : redactUrlsIn(String((error as { shortMessage?: string }).shortMessage ?? (error as Error)?.message ?? 'unknown error')).split('\n')[0];
      throw new ApiError(0, timedOut ? 'timeout' : 'network', `Request to ${path} failed: ${cleanText(reason)}`, null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, init: Init = {}): Promise<unknown> {
    return (await this.send(path, init)).body;
  }

  /** A list endpoint: a JSON array, with the next page's cursor in the Next-Cursor header. */
  private async page<T>(path: string, item: (v: unknown) => v is T, sent?: string): Promise<Page<T>> {
    const { body, headers } = await this.send(path);
    if (!Array.isArray(body)) throw bad(path, 'not a list');
    if (body.length > MAX_ITEMS) throw bad(path, 'too many items');
    if (!body.every(item)) throw bad(path, 'an item has the wrong shape');
    const next = headers.get('Next-Cursor');
    if (next === null || next === '') return { items: body, nextCursor: null };
    if (next.length > MAX_CURSOR || !CURSOR.test(next)) throw bad(path, 'bad cursor');
    if (next === sent) throw bad(path, 'the cursor did not advance');
    return { items: body, nextCursor: next };
  }

  async getAccount(account: Address, opts: { live?: boolean } = {}): Promise<ApiAccount> {
    const a = addressParam('account', account);
    const path = `/v1/agent-accounts/${a}${opts.live === true ? '?live=1' : ''}`;
    const body = await this.request(path);
    if (!isObject(body) || !isAddr(body.account) || body.account.toLowerCase() !== a) throw bad(path, 'not the requested account');
    for (const k of ['owner', 'referrer', 'factory'] as const) if (body[k] !== undefined && !isAddr(body[k])) throw bad(path, `${k} is not an address`);
    return body as unknown as ApiAccount;
  }

  async listAccounts(owner: Address): Promise<ApiAccountSummary[]> {
    const path = `/v1/agent-accounts?owner=${addressParam('owner', owner)}`;
    return (await this.page<ApiAccountSummary>(path, (v): v is ApiAccountSummary => isObject(v) && isAddr(v.account) && (v.owner === undefined || isAddr(v.owner)))).items;
  }

  async listActions(account: Address, cursor?: string): Promise<Page<ApiAction>> {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > MAX_CURSOR || !CURSOR.test(cursor))) throw new InvalidInputError('cursor', 'cursor is not one the API issued');
    const q = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return await this.page<ApiAction>(`/v1/agent-accounts/${addressParam('account', account)}/actions${q}`, (v): v is ApiAction => isObject(v) && typeof v.id === 'string' && (v.token === undefined || isAddr(v.token)), cursor);
  }

  async quote(kind: QuoteKind, body: QuoteRequest): Promise<ApiQuote> {
    if (kind !== 'curve-buy' && kind !== 'curve-sell' && kind !== 'pool-swap') throw new InvalidInputError('kind', 'unknown quote kind');
    const path = `/v1/quote/${kind}`;
    const answer = await this.request(path, { method: 'POST', json: body });
    if (!isObject(answer) || answer.advisory !== true) throw bad(path, 'not an advisory quote');
    return answer as ApiQuote;
  }

  async buildTx(body: BuildRequest): Promise<BuiltTx> {
    const path = '/v1/tx/build';
    const r = await this.request(path, { method: 'POST', json: body });
    if (!isObject(r) || !Number.isSafeInteger(r.chainId) || !isAddr(r.to) || !isHex(r.data) || typeof r.value !== 'string' || !DECIMAL.test(r.value)) throw bad(path, 'not a transaction');
    if (r.selector !== undefined && !(isHex(r.selector) && r.selector.length === 10)) throw bad(path, 'bad selector');
    return { chainId: r.chainId as number, to: r.to, data: r.data as Hex, value: r.value, ...(typeof r.function === 'string' ? { function: cleanText(r.function, 64) } : {}), ...(r.selector === undefined ? {} : { selector: r.selector as Hex }) };
  }

  async uploadLaunchMetadata(meta: LaunchMetadata, image?: ImageUpload): Promise<UploadedMetadata> {
    const path = '/v1/uploads/launch-metadata';
    const form = new FormData();
    form.append('metadata', JSON.stringify(meta));
    if (image !== undefined) {
      if (image.contentType !== 'image/png' && image.contentType !== 'image/jpeg') throw new InvalidInputError('image', 'image must be image/png or image/jpeg');
      form.append('file', new Blob([image.bytes as unknown as ArrayBuffer], { type: image.contentType }), image.filename ?? (image.contentType === 'image/png' ? 'image.png' : 'image.jpg'));
    }
    const r = await this.request(path, { method: 'POST', form });
    if (!isObject(r) || typeof r.metadataURI !== 'string') throw bad(path, 'no metadata URI');
    if (r.imageStatus !== undefined && r.imageStatus !== 'clean' && r.imageStatus !== 'review') throw bad(path, 'unknown image status');
    return { metadataURI: r.metadataURI, imageStatus: r.imageStatus ?? null };
  }

  async getToken(token: Address): Promise<ApiToken | null> {
    const t = addressParam('token', token);
    const path = `/v1/tokens/${t}`;
    const r = await this.request(path);
    if (r === null || r === undefined) return null;
    if (!isObject(r) || !isAddr(r.address) || r.address.toLowerCase() !== t) throw bad(path, 'not the requested token');
    return r as unknown as ApiToken;
  }

  streamRequest(topics: readonly string[]): { url: string; headers: Record<string, string> } {
    return { url: `${this.baseUrl}/v1/stream?topics=${topics.map((t) => encodeURIComponent(t)).join(',')}`, headers: this.headers() };
  }
}
