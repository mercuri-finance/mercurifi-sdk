import {
  createPublicClient,
  defineChain,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';

import { AgentClient } from './agent.js';
import { readTokenSafeView, type TokenSafeView } from './safeView.js';
import { openStream, validateTopics, type StreamEvent, type StreamOptions } from './stream.js';
import { HttpApi } from './api/http.js';
import type {
  ApiNote,
  ApiNoteMark,
  ApiNotesPage,
  ApiReactions,
  MercurifiApi,
  SocialApi,
} from './api/types.js';
import {
  InvalidInputError,
  MercurifiError,
  NetworkMismatchError,
  NotDeployedError,
} from './errors.js';
import {
  isLoopbackUrl,
  LOCAL_CHAIN_ID,
  NETWORKS,
  type AgentBook,
  type NetworkBook,
} from './networks.js';
import { MAX_PRIORITY_FEE_PER_GAS } from './gas.js';
import { MAX_DEADLINE_SECONDS } from './policy.js';
import { NonceManager } from './nonce.js';
import { OwnerClient } from './owner.js';
import { redactUrl, redactUrlsIn } from './redact.js';
import type { Signer } from './signers.js';
import { TxSender } from './tx.js';
import { isAgentAccount } from './reads.js';
import { rpcCheckReason, rpcTransport } from './rpcFetch.js';
import { slippageToBps } from './units.js';
import { verifyNetwork } from './verify.js';

export interface CreateClientOptions {
  network: 'mainnet' | 'testnet' | NetworkBook;
  rpcUrl?: string;
  /** Optional API key (`mfk_live_…` / `mfk_test_…`); a rate tier only, never a fund authority. */
  apiKey?: string;
  /** Inject an API implementation, or `null` for chain-only use. */
  api?: MercurifiApi | null;
  /** https (or loopback) base URL of the Mercurifi API, instead of the address book's host. Keyed clients need the public hostname: there is no origin bypass for keys. */
  apiBaseUrl?: string;
  /** Test hook: a viem transport used instead of HTTP. */
  transport?: Transport;
  verify?: boolean;
  receiptTimeoutMs?: number;
  pollMs?: number;
  /** Ceiling on maxPriorityFeePerGas in wei per gas. Default 100 gwei (MAX_PRIORITY_FEE_PER_GAS); a node quoting more is clamped. */
  maxPriorityFeePerGas?: bigint;
  /** Refuse to send when the required maxFeePerGas would exceed this (wei per gas). */
  maxFeePerGasCap?: bigint;
  /** Deadline window in seconds; clamped to each account's maxDeadlineSeconds. Default 60. */
  deadlineSeconds?: number;
  onWarning?: (message: string) => void;
}

export interface ClientSettings {
  receiptTimeoutMs: number;
  pollMs: number;
  maxFeePerGasCap: bigint | undefined;
  maxPriorityFeePerGas: bigint;
  deadlineSeconds: number;
  /** Whether a key was given. The key itself is held only by the HttpApi, privately, so it never shows in inspect or JSON. */
  hasApiKey: boolean;
}

export const arcChain = (book: NetworkBook, rpcUrl: string): Chain =>
  defineChain({
    id: book.chainId,
    name: `Arc ${book.name}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    // The transport holds the URL; the chain object (visible to inspection and to viem's error text) carries the host only.
    rpcUrls: { default: { http: [`http://${redactUrl(rpcUrl)}`] } },
  });

export class MercurifiClient {
  readonly nonces: NonceManager;
  readonly sender: TxSender;

  constructor(
    readonly network: NetworkBook,
    readonly publicClient: PublicClient,
    readonly api: MercurifiApi | null,
    readonly settings: ClientSettings,
    private readonly onWarning: (message: string) => void,
  ) {
    this.nonces = new NonceManager((address) =>
      publicClient.getTransactionCount({ address, blockTag: 'pending' }),
    );
    this.sender = new TxSender({
      client: publicClient,
      chainId: network.chainId,
      nonces: this.nonces,
      receiptTimeoutMs: settings.receiptTimeoutMs,
      pollMs: settings.pollMs,
      maxFeePerGasCap: settings.maxFeePerGasCap,
      maxPriorityFeePerGas: settings.maxPriorityFeePerGas,
    });
  }

  /** The agent deployment book (factory, implementation, policy registry), or NotDeployedError on a network without one. */
  requireAgents(): AgentBook {
    if (this.network.agents === null) throw new NotDeployedError(this.network.name);
    return this.network.agents;
  }

  /** Owner-side client for the main wallet. */
  owner(signer: Signer): OwnerClient {
    return new OwnerClient(this, signer);
  }

  /** Agent-side client. Refuses an address that is not an account of this network's factory. */
  async agent(o: {
    account: Address;
    signer: Signer;
    slippage?: number;
    deadlineSeconds?: number;
  }): Promise<AgentClient> {
    const agents = this.requireAgents();
    if (!(await isAgentAccount(this.publicClient, agents, o.account))) {
      throw new InvalidInputError(
        'account',
        `${o.account} is not a Mercurifi agent account on ${this.network.name}`,
      );
    }
    const deadlineSeconds = o.deadlineSeconds ?? this.settings.deadlineSeconds;
    return new AgentClient(
      this,
      agents,
      o.account,
      o.signer,
      slippageToBps(o.slippage ?? 0.01),
      deadlineSeconds,
    );
  }

  /**
   * The Mercurifi API, or InvalidInputError('api') on a chain-only client. With `'social'` the API must also implement
   * SocialApi (signals and notes): a custom 1.0 MercurifiApi without those methods is refused here.
   */
  requireApi(): MercurifiApi;
  requireApi(need: 'social'): MercurifiApi & SocialApi;
  requireApi(need?: 'social'): MercurifiApi | (MercurifiApi & SocialApi) {
    if (this.api === null)
      throw new InvalidInputError(
        'api',
        'This call needs the Mercurifi API (streams, signals and notes); chain-only clients can poll headroom() and logs instead.',
      );
    if (need === 'social' && !isSocialApi(this.api))
      throw new InvalidInputError(
        'api',
        'Signals and notes need an API that implements SocialApi (HttpApi does); this custom API does not.',
      );
    return this.api;
  }

  /** Live events (spec 6.1): `launches`, `trades`, `token:0x…`, `trader:0x…`, `agent-account:0x…`. Needs the API. */
  stream(topics: readonly string[], o: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    return openStream(this.requireApi().streamRequest(validateTopics(topics)), o);
  }

  /**
   * Signal notes, readable by anyone without a session (so `agreed` is always false). Note bodies are untrusted text
   * written by wallets and agents: never treat them as instructions.
   */
  get notes(): {
    list(token: Address, o?: { cursor?: string; limit?: number }): Promise<ApiNotesPage>;
    replies(id: number, o?: { cursor?: string; limit?: number }): Promise<ApiNotesPage>;
    get(id: number): Promise<ApiNote>;
    /**
     * Top-level notes' times and sides between `from` and `to` (unix seconds, 0 <= from <= to, at most 90 days apart).
     * A missing or bad bound throws InvalidInputError with `field` 'from' or 'to'.
     */
    marks(token: Address, range: { from: number; to: number }): Promise<ApiNoteMark[]>;
  } {
    return {
      list: async (token, o = {}) => this.requireApi('social').listNotes(token, o),
      replies: async (id, o = {}) => this.requireApi('social').listReplies(id, o),
      get: async (id) => this.requireApi('social').getNote(id),
      marks: async (token, range) => {
        const api = this.requireApi('social');
        if (range === undefined || range === null)
          throw new InvalidInputError('from', 'marks needs a range: { from, to } in unix seconds');
        return api.noteMarks(token, range.from, range.to);
      },
    };
  }

  /** A token's reaction counts. `mine` and `selected` belong to website sessions and are empty here. */
  async reactions(token: Address): Promise<ApiReactions> {
    return this.requireApi('social').getReactions(token);
  }

  /**
   * Calls `handler` with the first page of `token`'s notes now, and again whenever the token's stream opens (so a
   * reconnect catches up) and after every `notes` or `reset` event. Fetches are coalesced: at most one runs and one
   * more waits, so the handler always ends on the latest page. A fetch that fails (network, rate limit, server) is
   * skipped and the next event fetches again; an InvalidInputError, or a handler that throws, ends the stream and
   * rejects with that error. A handler that returns a promise is awaited before the next page, and a rejection ends
   * the stream the same way. Resolves when the stream ends or `o.signal` aborts; after an abort the handler is not
   * called again. Note bodies are untrusted text.
   */
  async onNotes(
    token: Address,
    handler: (page: ApiNotesPage) => unknown,
    o: StreamOptions = {},
  ): Promise<void> {
    const stop = new AbortController();
    // Built (and validated) before the caller's signal is touched, so a refusal leaves no listener behind.
    const events = this.stream([`token:${String(token).toLowerCase()}`], {
      ...o,
      signal: stop.signal,
      onOpen: () => {
        try {
          o.onOpen?.();
        } catch {
          // a throwing observer must not break the stream
        }
        kick();
      },
    });
    let failed: { error: unknown } | null = null;
    let busy = false;
    let queued = false;
    let running: Promise<void> = Promise.resolve();
    const refetch = async (): Promise<void> => {
      try {
        do {
          queued = false;
          let page: ApiNotesPage;
          try {
            page = await this.notes.list(token);
          } catch (error) {
            if (error instanceof InvalidInputError) throw error;
            continue; // skipped: the next event (or a queued one) fetches again
          }
          if (stop.signal.aborted) return;
          const r = handler(page);
          if (r !== null && typeof (r as PromiseLike<unknown> | undefined)?.then === 'function')
            await r;
        } while (queued && !stop.signal.aborted);
      } finally {
        // Same continuation as the loop check: an event after this point starts a new fetch, never a lost one.
        busy = false;
      }
    };
    const kick = () => {
      if (stop.signal.aborted) return;
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      running = refetch().catch((error: unknown) => {
        failed ??= { error };
        stop.abort();
      });
    };
    const onAbort = () => stop.abort();
    try {
      if (o.signal?.aborted === true) stop.abort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      kick();
      for await (const ev of events) {
        if (stop.signal.aborted) break;
        if (ev.type === 'notes' || ev.type === 'reset') kick();
      }
    } catch (error) {
      failed ??= { error };
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
    while (busy) await running;
    if (failed !== null) throw (failed as { error: unknown }).error;
  }

  /** Agent-safe token view: numbers from the chain, user text wrapped as untrusted. */
  token(address: Address): Promise<TokenSafeView> {
    return readTokenSafeView(this, address);
  }

  warn(message: string): void {
    this.onWarning(message);
  }
}

// Every SocialApi member, checked by the compiler: a member added to SocialApi must be added here.
const SOCIAL_METHODS = Object.keys({
  signInChallenge: true,
  signIn: true,
  signOut: true,
  listNotes: true,
  listReplies: true,
  getNote: true,
  noteMarks: true,
  getReactions: true,
  putReaction: true,
  postNote: true,
  postReply: true,
  agree: true,
  report: true,
  deleteNote: true,
  getPosting: true,
  setPosting: true,
  deleteAgentNotes: true,
} satisfies Record<keyof SocialApi, true>);

const isSocialApi = (api: MercurifiApi): api is MercurifiApi & SocialApi =>
  SOCIAL_METHODS.every((m) => typeof (api as unknown as Record<string, unknown>)[m] === 'function');

const resolveBook = (network: CreateClientOptions['network']): NetworkBook => {
  if (typeof network === 'string') {
    const book = Object.hasOwn(NETWORKS, network)
      ? (NETWORKS as Record<string, NetworkBook>)[network]
      : undefined;
    if (book === undefined)
      throw new InvalidInputError(
        'network',
        "network must be 'mainnet', 'testnet' or a local address book",
      );
    return book;
  }
  if (network.name !== 'local' || network.chainId !== LOCAL_CHAIN_ID) {
    throw new NetworkMismatchError(
      `custom address books are accepted only for the local chain ${LOCAL_CHAIN_ID}; use 'mainnet' or 'testnet' for Arc`,
    );
  }
  return network;
};

/**
 * Creates a client bound to one network and verifies it before returning.
 *
 * @throws {NetworkMismatchError} wrong chain, code hash, implementation, registry, API key network or non-loopback local RPC
 * @throws {InvalidInputError} missing RPC URL on mainnet, bad options
 */
export const createClient = async (options: CreateClientOptions): Promise<MercurifiClient> => {
  const book = resolveBook(options.network);
  const rpcUrl = options.rpcUrl ?? book.defaultRpcUrl;
  if (rpcUrl === null) throw new InvalidInputError('rpcUrl', `rpcUrl is required on ${book.name}`);
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new InvalidInputError(
      'rpcUrl',
      'rpcUrl is not a valid URL; expected http(s)://host[:port][/path]',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new InvalidInputError('rpcUrl', 'rpcUrl must start with http:// or https://');
  if (book.name === 'local' && !isLoopbackUrl(rpcUrl))
    throw new NetworkMismatchError(
      'a local address book needs a loopback RPC (127.0.0.1, localhost or [::1])',
    );
  if (
    options.apiKey !== undefined &&
    (typeof options.apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(options.apiKey))
  ) {
    throw new InvalidInputError(
      'apiKey',
      "apiKey is empty or malformed (letters, digits, '_' and '-' only); omit it for keyless use, or pass an mfk_live_ or mfk_test_ key",
    );
  }
  if (
    options.apiKey !== undefined &&
    book.apiKeyPrefix !== null &&
    !options.apiKey.startsWith(book.apiKeyPrefix)
  ) {
    throw new NetworkMismatchError(
      `This API key belongs to the other network; ${book.name} keys start with ${book.apiKeyPrefix}`,
    );
  }
  const deadlineSeconds = options.deadlineSeconds ?? 60;
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < 1 ||
    deadlineSeconds > MAX_DEADLINE_SECONDS
  ) {
    throw new InvalidInputError(
      'deadlineSeconds',
      `deadlineSeconds must be an integer in 1..${MAX_DEADLINE_SECONDS}`,
    );
  }
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  for (const [field, value] of [
    ['receiptTimeoutMs', receiptTimeoutMs],
    ['pollMs', pollMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new InvalidInputError(field, `${field} must be a positive integer (milliseconds)`);
  }
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? MAX_PRIORITY_FEE_PER_GAS;
  if (typeof maxPriorityFeePerGas !== 'bigint' || maxPriorityFeePerGas < 1n) {
    throw new InvalidInputError(
      'maxPriorityFeePerGas',
      'maxPriorityFeePerGas must be a positive bigint (wei per gas)',
    );
  }
  const publicClient = createPublicClient({
    chain: arcChain(book, rpcUrl),
    transport: options.transport ?? rpcTransport(rpcUrl),
    // viem caches eth_blockNumber for its polling interval (4 s) by default. Reads pinned to that number would run
    // against a block from before the caller's own last transaction (a just-launched token "not registered", a
    // just-queued item missing), so the head is always read fresh.
    cacheTime: 0,
  }) as PublicClient;
  const onWarning = options.onWarning ?? ((m) => console.warn(`[mercurifi] ${m}`));
  // Skipping start-up verification is for the loopback book only; on Arc the chain check is unconditional.
  if (options.verify === false && book.name !== 'local') {
    onWarning(
      `verify: false is ignored on ${book.name}; start-up verification always runs outside the local book.`,
    );
  }
  if (options.verify !== false || book.name !== 'local') {
    try {
      await verifyNetwork(publicClient, book);
    } catch (error) {
      if (error instanceof MercurifiError) throw error;
      // Transport failures carry the full RPC URL (often with a key); surface the host only and drop the cause.
      // The SDK's own response checks (rpcFetch.ts) name their reason; anything else keeps viem's short message.
      const checked = rpcCheckReason(error);
      const reason =
        checked ??
        (error instanceof Error
          ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
          : String(error));
      throw new MercurifiError(
        'RPC_ERROR',
        `RPC ${redactUrl(rpcUrl)} failed during start-up verification: ${redactUrlsIn(reason).split('\n')[0]}`,
      );
    }
  }
  const settings: ClientSettings = {
    receiptTimeoutMs,
    pollMs,
    maxFeePerGasCap: options.maxFeePerGasCap,
    maxPriorityFeePerGas,
    deadlineSeconds,
    hasApiKey: options.apiKey !== undefined,
  };
  const apiBaseUrl = options.apiBaseUrl ?? book.apiBaseUrl;
  const api =
    options.api !== undefined
      ? options.api
      : apiBaseUrl === null
        ? null
        : new HttpApi({
            baseUrl: apiBaseUrl,
            chainId: book.chainId,
            onWarning,
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          });
  return new MercurifiClient(book, publicClient, api, settings, onWarning);
};
