import { isAddress, isHex, type Address, type Hex } from 'viem';

import { ApiError, InvalidInputError, MercurifiError } from '../errors.js';
import { isLoopbackUrl } from '../networks.js';
import { redactUrlsIn } from '../redact.js';
import type {
  ApiAccount,
  ApiAccountSummary,
  ApiAction,
  ApiNote,
  ApiNoteMark,
  ApiNotesPage,
  ApiPosting,
  ApiQuote,
  ApiReactions,
  ApiSignInChallenge,
  ApiSocialSession,
  ApiToken,
  BuildRequest,
  BuiltTx,
  ImageUpload,
  LaunchMetadata,
  MercurifiApi,
  NoteSide,
  Page,
  QuoteKind,
  QuoteRequest,
  UploadedMetadata,
} from './types.js';

export interface HttpApiOptions {
  baseUrl: string;
  chainId: number;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}
interface Answer {
  body: unknown;
  headers: Headers;
}
type Init = {
  method?: string;
  json?: unknown;
  form?: FormData;
  /** A social session's bearer: sent as Authorization, redacted from errors, and the API key is left off. */
  bearer?: string;
  /** Sign-in: send neither the API key nor Authorization. */
  anonymous?: boolean;
};

/** A response larger than this is refused unread (the largest legitimate answer is a page of actions). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Items per list answer; the API pages far below this. */
const MAX_ITEMS = 1_000;
const MAX_CURSOR = 256;
const MAX_LIST_PAGES = 10;
const CURSOR = /^[A-Za-z0-9_\-.:=~]+$/;
const DECIMAL = /^\d{1,78}$/;
/** RFC 6750 token68: header-safe, so a bearer can never inject a header. */
const BEARER = /^[A-Za-z0-9\-._~+/]{1,512}=*$/;
const NONCE = /^[A-Za-z0-9]{1,128}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const REACTION_KEY = /^[a-z_]{1,32}$/;
const MAX_PAGE = 50;
/** The API serves at most this many marks per range. */
const MAX_MARKS = 2_000;
const MARKS_SPAN = 90 * 86_400;
const NOTE_MAX = 280;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

const bad = (path: string, what: string): MercurifiError =>
  new MercurifiError(
    'API_BAD_RESPONSE',
    `The API answered ${path} with something unexpected (${what}); it was ignored.`,
  );

/** Server text is untrusted: no control or format characters, no URLs, bounded. */
const cleanText = (value: unknown, max = 200): string => {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const plain = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\p{Cf}+/gu, '');
  const chars = Array.from(redactUrlsIn(plain).trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : chars.join('');
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isAddr = (v: unknown): v is Address =>
  typeof v === 'string' && isAddress(v, { strict: false });

const addressParam = (field: string, value: unknown): string => {
  if (!isAddr(value)) throw new InvalidInputError(field, `${field} is not an address`);
  return value.toLowerCase();
};

const checkCursor = (cursor: unknown): void => {
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length > MAX_CURSOR || !CURSOR.test(cursor))
  )
    throw new InvalidInputError('cursor', 'cursor is not one the API issued');
};

/** `?cursor=…&limit=…` from the defined fields, checked first. */
const pageQuery = (o: { cursor?: string; limit?: number }): string => {
  checkCursor(o.cursor);
  if (
    o.limit !== undefined &&
    (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > MAX_PAGE)
  )
    throw new InvalidInputError('limit', `limit must be 1 to ${MAX_PAGE}`);
  const parts = [
    ...(o.cursor === undefined ? [] : [`cursor=${encodeURIComponent(o.cursor)}`]),
    ...(o.limit === undefined ? [] : [`limit=${o.limit}`]),
  ];
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
};

const noteId = (id: unknown): number => {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new InvalidInputError('id', 'id must be a positive integer note id');
  return id;
};

/** Never echoes the value: a malformed bearer may be a secret with a stray character. */
const bearerParam = (bearer: unknown): string => {
  if (typeof bearer !== 'string' || !BEARER.test(bearer))
    throw new InvalidInputError('bearer', 'bearer is not a session token');
  return bearer;
};

const codePoints = (s: string): number => [...s].length;

/**
 * A note body as the API will store it: control and format characters and line or paragraph separators removed,
 * trimmed, 1 to 280 characters (code points). Throws RangeError otherwise. The API also refuses links and addresses.
 */
export const checkBody = (body: string): string => {
  if (typeof body !== 'string') throw new RangeError('a note body must be text');
  const clean = body.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  const n = codePoints(clean);
  if (n < 1 || n > NOTE_MAX)
    throw new RangeError(`a note body must be 1 to ${NOTE_MAX} characters`);
  return clean;
};

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isSide = (v: unknown): v is NoteSide => v === 'bullish' || v === 'bearish';

const isNote = (v: unknown): v is ApiNote =>
  isObject(v) &&
  Number.isSafeInteger(v.id) &&
  (v.id as number) > 0 &&
  isAddr(v.address) &&
  isSide(v.side) &&
  (v.holdBps === null || isCount(v.holdBps)) &&
  typeof v.body === 'string' &&
  codePoints(v.body) <= NOTE_MAX &&
  isCount(v.createdAt) &&
  (v.replyCount === undefined || isCount(v.replyCount)) &&
  isCount(v.agreeCount) &&
  typeof v.agreed === 'boolean' &&
  typeof v.agent === 'boolean';

const isNotesPage = (v: unknown): v is ApiNotesPage =>
  isObject(v) &&
  Array.isArray(v.notes) &&
  v.notes.length <= MAX_PAGE &&
  v.notes.every(isNote) &&
  (v.nextCursor === null ||
    (typeof v.nextCursor === 'string' &&
      v.nextCursor.length <= MAX_CURSOR &&
      CURSOR.test(v.nextCursor)));

const isMark = (v: unknown): v is ApiNoteMark =>
  isObject(v) &&
  Number.isSafeInteger(v.id) &&
  (v.id as number) > 0 &&
  isCount(v.createdAt) &&
  isSide(v.side) &&
  typeof v.agent === 'boolean';

const isReactions = (v: unknown): v is ApiReactions =>
  isObject(v) &&
  isObject(v.counts) &&
  Object.values(v.counts).every(isCount) &&
  isCount(v.total) &&
  isCount(v.holders) &&
  (v.mine === null || typeof v.mine === 'string') &&
  Array.isArray(v.selected) &&
  v.selected.every((k) => typeof k === 'string') &&
  typeof v.brandLookalike === 'boolean';

const isPosting = (v: unknown): v is ApiPosting =>
  isObject(v) && typeof v.enabled === 'boolean' && (v.updatedAt === null || isCount(v.updatedAt));

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
  readonly #warn: (message: string) => void;

  constructor(o: HttpApiOptions) {
    let url: URL;
    try {
      url = new URL(o.baseUrl);
    } catch {
      throw new InvalidInputError('apiBaseUrl', 'the API base URL is not a valid URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(o.baseUrl)))
      throw new InvalidInputError(
        'apiBaseUrl',
        'the API base URL must use https (http is allowed for loopback only)',
      );
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
      throw new InvalidInputError(
        'apiBaseUrl',
        'the API base URL must not carry credentials, a query or a fragment',
      );
    this.baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    if (!Number.isInteger(o.chainId) || o.chainId < 1)
      throw new InvalidInputError('chainId', 'chainId must be a positive integer');
    this.chainId = o.chainId;
    if (
      o.apiKey !== undefined &&
      (typeof o.apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(o.apiKey))
    )
      throw new InvalidInputError(
        'apiKey',
        "apiKey is malformed: expected 1-256 letters, digits, '_' or '-' (check for a stray newline or space)",
      );
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = o.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new InvalidInputError(
        'timeoutMs',
        'timeoutMs must be a positive integer (milliseconds)',
      );
    this.#timeoutMs = timeoutMs;
    this.#warn = o.onWarning ?? (() => undefined);
  }

  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      chainId: this.chainId,
      apiKey: this.#apiKey === undefined ? null : '[redacted]',
    };
  }

  [INSPECT](): string {
    return `HttpApi { baseUrl: '${this.baseUrl}', chainId: ${this.chainId}, apiKey: ${this.#apiKey === undefined ? 'none' : '[redacted]'} }`;
  }

  /** Text with every occurrence of the API key and the request's bearer replaced, so no error can carry them. */
  private keyless(text: string, bearer?: string): string {
    let out = text;
    // An empty needle would splice the marker between every character.
    for (const secret of [this.#apiKey, bearer])
      if (secret !== undefined && secret !== '') out = out.split(secret).join('[redacted]');
    return out;
  }

  private headers(extra: Record<string, string> = {}, noKey = false): Record<string, string> {
    return {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      ...(this.#apiKey === undefined || noKey ? {} : { 'X-Api-Key': this.#apiKey }),
      ...extra,
    };
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
        headers: this.headers(
          {
            ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(init.bearer === undefined ? {} : { Authorization: `Bearer ${init.bearer}` }),
          },
          init.bearer !== undefined || init.anonymous === true,
        ),
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
        // A server (or a proxy in front of it) may echo the request headers: the key is cut from its words before anything else.
        const rawCode = isObject(e) && typeof e.code === 'string' ? e.code : '';
        const code =
          /^[a-z0-9_.-]{1,64}$/i.test(rawCode) && this.keyless(rawCode, init.bearer) === rawCode
            ? rawCode
            : 'http_error';
        const said =
          isObject(e) && typeof e.message === 'string'
            ? cleanText(this.keyless(e.message, init.bearer))
            : '';
        const message = said !== '' ? said : `HTTP ${response.status} from ${path}`;
        const retry = Number(response.headers.get('Retry-After'));
        throw new ApiError(
          response.status,
          code,
          message,
          Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : null,
        );
      }
      return { body, headers: response.headers };
    } catch (error) {
      if (error instanceof MercurifiError) throw error;
      const reason = timedOut
        ? `timed out after ${this.#timeoutMs} ms`
        : redactUrlsIn(
            String(
              (error as { shortMessage?: string }).shortMessage ??
                (error as Error)?.message ??
                'unknown error',
            ),
          ).split('\n')[0];
      throw new ApiError(
        0,
        timedOut ? 'timeout' : 'network',
        `Request to ${path} failed: ${cleanText(this.keyless(String(reason), init.bearer))}`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, init: Init = {}): Promise<unknown> {
    return (await this.send(path, init)).body;
  }

  /** A list endpoint: a JSON array, with the next page's cursor in the Next-Cursor header. */
  private async page<T>(
    path: string,
    item: (v: unknown) => v is T,
    sent?: string,
  ): Promise<Page<T>> {
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
    if (!isObject(body) || !isAddr(body.account) || body.account.toLowerCase() !== a)
      throw bad(path, 'not the requested account');
    for (const k of ['owner', 'referrer', 'factory'] as const)
      if (body[k] !== undefined && !isAddr(body[k])) throw bad(path, `${k} is not an address`);
    return body as unknown as ApiAccount;
  }

  /** Follows Next-Cursor up to MAX_LIST_PAGES pages and warns when the list was cut short. */
  async listAccounts(owner: Address): Promise<ApiAccountSummary[]> {
    const base = `/v1/agent-accounts?owner=${addressParam('owner', owner)}`;
    const out: ApiAccountSummary[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages++) {
      const page = await this.page<ApiAccountSummary>(
        cursor === undefined ? base : `${base}&cursor=${encodeURIComponent(cursor)}`,
        (v): v is ApiAccountSummary =>
          isObject(v) && isAddr(v.account) && (v.owner === undefined || isAddr(v.owner)),
        cursor,
      );
      out.push(...page.items);
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
    this.#warn(
      `The account list was cut off after ${MAX_LIST_PAGES} pages; more accounts exist than were returned.`,
    );
    return out;
  }

  async listActions(account: Address, cursor?: string): Promise<Page<ApiAction>> {
    checkCursor(cursor);
    const q = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return await this.page<ApiAction>(
      `/v1/agent-accounts/${addressParam('account', account)}/actions${q}`,
      (v): v is ApiAction =>
        isObject(v) && typeof v.id === 'string' && (v.token === undefined || isAddr(v.token)),
      cursor,
    );
  }

  async quote(kind: QuoteKind, body: QuoteRequest): Promise<ApiQuote> {
    if (kind !== 'curve-buy' && kind !== 'curve-sell' && kind !== 'pool-swap')
      throw new InvalidInputError('kind', 'unknown quote kind');
    const path = `/v1/quote/${kind}`;
    const answer = await this.request(path, { method: 'POST', json: body });
    if (!isObject(answer) || answer.advisory !== true) throw bad(path, 'not an advisory quote');
    return answer as ApiQuote;
  }

  async buildTx(body: BuildRequest): Promise<BuiltTx> {
    const path = '/v1/tx/build';
    const r = await this.request(path, { method: 'POST', json: body });
    if (
      !isObject(r) ||
      !Number.isSafeInteger(r.chainId) ||
      !isAddr(r.to) ||
      !isHex(r.data) ||
      typeof r.value !== 'string' ||
      !DECIMAL.test(r.value)
    )
      throw bad(path, 'not a transaction');
    if (r.selector !== undefined && !(isHex(r.selector) && r.selector.length === 10))
      throw bad(path, 'bad selector');
    return {
      chainId: r.chainId as number,
      to: r.to,
      data: r.data as Hex,
      value: r.value,
      ...(typeof r.function === 'string' ? { function: cleanText(r.function, 64) } : {}),
      ...(r.selector === undefined ? {} : { selector: r.selector as Hex }),
    };
  }

  async uploadLaunchMetadata(meta: LaunchMetadata, image?: ImageUpload): Promise<UploadedMetadata> {
    const path = '/v1/uploads/launch-metadata';
    const form = new FormData();
    form.append('metadata', JSON.stringify(meta));
    if (image !== undefined) {
      if (image.contentType !== 'image/png' && image.contentType !== 'image/jpeg')
        throw new InvalidInputError('image', 'image must be image/png or image/jpeg');
      form.append(
        'file',
        new Blob([image.bytes as unknown as ArrayBuffer], { type: image.contentType }),
        image.filename ?? (image.contentType === 'image/png' ? 'image.png' : 'image.jpg'),
      );
    }
    const r = await this.request(path, { method: 'POST', form });
    if (!isObject(r) || typeof r.metadataURI !== 'string') throw bad(path, 'no metadata URI');
    if (r.imageStatus !== undefined && r.imageStatus !== 'clean' && r.imageStatus !== 'review')
      throw bad(path, 'unknown image status');
    return { metadataURI: r.metadataURI, imageStatus: r.imageStatus ?? null };
  }

  async getToken(token: Address): Promise<ApiToken | null> {
    const t = addressParam('token', token);
    const path = `/v1/tokens/${t}`;
    const r = await this.request(path);
    if (r === null || r === undefined) return null;
    if (!isObject(r) || !isAddr(r.address) || r.address.toLowerCase() !== t)
      throw bad(path, 'not the requested token');
    return r as unknown as ApiToken;
  }

  async signInChallenge(
    kind: 'agent' | 'owner',
    account: Address,
    signer: Address,
  ): Promise<ApiSignInChallenge> {
    if (kind !== 'agent' && kind !== 'owner')
      throw new InvalidInputError('kind', "kind must be 'agent' or 'owner'");
    const json = {
      kind,
      account: addressParam('account', account),
      signer: addressParam('signer', signer),
    };
    const path = '/v1/agent-auth/nonce';
    const r = await this.request(path, { method: 'POST', json, anonymous: true });
    if (
      !isObject(r) ||
      typeof r.nonce !== 'string' ||
      !NONCE.test(r.nonce) ||
      typeof r.message !== 'string' ||
      r.message.length > 1_024 ||
      !isCount(r.issuedAt) ||
      !isCount(r.expiresAt)
    )
      throw bad(path, 'not a sign-in challenge');
    return { nonce: r.nonce, message: r.message, issuedAt: r.issuedAt, expiresAt: r.expiresAt };
  }

  async signIn(nonce: string, signature: Hex): Promise<ApiSocialSession> {
    if (typeof nonce !== 'string' || !NONCE.test(nonce))
      throw new InvalidInputError('nonce', 'nonce is not one the API issued');
    if (typeof signature !== 'string' || !SIGNATURE.test(signature))
      throw new InvalidInputError('signature', 'signature must be 65 bytes of hex');
    const path = '/v1/agent-auth/session';
    const r = await this.request(path, {
      method: 'POST',
      json: { nonce, signature },
      anonymous: true,
    });
    if (
      !isObject(r) ||
      typeof r.token !== 'string' ||
      !BEARER.test(r.token) ||
      (r.kind !== 'agent' && r.kind !== 'owner') ||
      !isAddr(r.account) ||
      !isCount(r.expiresAt)
    )
      throw bad(path, 'not a session');
    return { token: r.token, kind: r.kind, account: r.account, expiresAt: r.expiresAt };
  }

  async signOut(bearer: string): Promise<void> {
    await this.request('/v1/agent-auth/session', {
      method: 'DELETE',
      bearer: bearerParam(bearer),
    });
  }

  async listNotes(
    token: Address,
    o: { cursor?: string; limit?: number } = {},
  ): Promise<ApiNotesPage> {
    const path = `/v1/tokens/${addressParam('token', token)}/notes${pageQuery(o)}`;
    const r = await this.request(path);
    if (!isNotesPage(r)) throw bad(path, 'not a page of notes');
    return r;
  }

  async listReplies(
    id: number,
    o: { cursor?: string; limit?: number } = {},
  ): Promise<ApiNotesPage> {
    const path = `/v1/notes/${noteId(id)}/replies${pageQuery(o)}`;
    const r = await this.request(path);
    if (!isNotesPage(r)) throw bad(path, 'not a page of replies');
    return r;
  }

  async getNote(id: number): Promise<ApiNote> {
    const path = `/v1/notes/${noteId(id)}`;
    const r = await this.request(path);
    if (!isNote(r) || r.id !== id) throw bad(path, 'not the requested note');
    return r;
  }

  async noteMarks(token: Address, from: number, to: number): Promise<ApiNoteMark[]> {
    if (!Number.isSafeInteger(from) || from < 0)
      throw new RangeError('from must be unix seconds, 0 or more');
    if (!Number.isSafeInteger(to) || to < from)
      throw new RangeError('to must be unix seconds, not before from');
    if (to - from > MARKS_SPAN) throw new RangeError('to must be at most 90 days after from');
    const path = `/v1/tokens/${addressParam('token', token)}/notes/marks?from=${from}&to=${to}`;
    const r = await this.request(path);
    if (!Array.isArray(r) || r.length > MAX_MARKS || !r.every(isMark))
      throw bad(path, 'not a list of marks');
    return r;
  }

  async getReactions(token: Address): Promise<ApiReactions> {
    const path = `/v1/tokens/${addressParam('token', token)}/reactions`;
    const r = await this.request(path);
    if (!isReactions(r)) throw bad(path, 'not reactions');
    return r;
  }

  async putReaction(
    token: Address,
    key: string | null,
    bearer: string,
    active?: boolean,
  ): Promise<void> {
    if (key !== null && (typeof key !== 'string' || !REACTION_KEY.test(key)))
      throw new InvalidInputError('key', 'key is not a reaction name');
    if (active !== undefined && (typeof active !== 'boolean' || key === null))
      throw new InvalidInputError('active', 'active must be true or false, with a key');
    await this.request(`/v1/tokens/${addressParam('token', token)}/reactions`, {
      method: 'PUT',
      json: active === undefined ? { key } : { key, active },
      bearer: bearerParam(bearer),
    });
  }

  async postNote(token: Address, body: string, bearer: string): Promise<ApiNote> {
    const path = `/v1/tokens/${addressParam('token', token)}/notes`;
    const r = await this.request(path, {
      method: 'POST',
      json: { body },
      bearer: bearerParam(bearer),
    });
    if (!isNote(r)) throw bad(path, 'not a note');
    return r;
  }

  async postReply(id: number, body: string, bearer: string): Promise<ApiNote> {
    const path = `/v1/notes/${noteId(id)}/replies`;
    const r = await this.request(path, {
      method: 'POST',
      json: { body },
      bearer: bearerParam(bearer),
    });
    if (!isNote(r)) throw bad(path, 'not a reply');
    return r;
  }

  async agree(id: number, active: boolean, bearer: string): Promise<void> {
    if (typeof active !== 'boolean')
      throw new InvalidInputError('active', 'active must be true or false');
    await this.request(`/v1/notes/${noteId(id)}/agree`, {
      method: 'PUT',
      json: { active },
      bearer: bearerParam(bearer),
    });
  }

  async report(id: number, bearer: string): Promise<void> {
    await this.request(`/v1/notes/${noteId(id)}/report`, {
      method: 'POST',
      bearer: bearerParam(bearer),
    });
  }

  async deleteNote(id: number, bearer: string): Promise<void> {
    await this.request(`/v1/notes/${noteId(id)}`, {
      method: 'DELETE',
      bearer: bearerParam(bearer),
    });
  }

  async getPosting(account: Address): Promise<ApiPosting> {
    const path = `/v1/agent-accounts/${addressParam('account', account)}/posting`;
    const r = await this.request(path);
    if (!isPosting(r)) throw bad(path, 'not a posting switch');
    return r;
  }

  async setPosting(account: Address, enabled: boolean, bearer: string): Promise<ApiPosting> {
    if (typeof enabled !== 'boolean')
      throw new InvalidInputError('enabled', 'enabled must be true or false');
    const path = `/v1/agent-accounts/${addressParam('account', account)}/posting`;
    const r = await this.request(path, {
      method: 'PUT',
      json: { enabled },
      bearer: bearerParam(bearer),
    });
    if (!isPosting(r)) throw bad(path, 'not a posting switch');
    return r;
  }

  async deleteAgentNotes(account: Address, bearer: string): Promise<{ deleted: number }> {
    const path = `/v1/agent-accounts/${addressParam('account', account)}/notes`;
    const r = await this.request(path, { method: 'DELETE', bearer: bearerParam(bearer) });
    if (!isObject(r) || !isCount(r.deleted)) throw bad(path, 'not a delete count');
    return { deleted: r.deleted };
  }

  /** The returned headers contain the API key: pass them to the stream client and never log or serialise this object. */
  streamRequest(topics: readonly string[]): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.baseUrl}/v1/stream?topics=${topics.map((t) => encodeURIComponent(t)).join(',')}`,
      headers: this.headers(),
    };
  }
}
