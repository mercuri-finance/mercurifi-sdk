import { createPublicClient, defineChain, http, type Chain, type PublicClient, type Transport } from 'viem';

import type { MercurifiApi } from './api/types.js';
import { InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError } from './errors.js';
import { isLoopbackUrl, LOCAL_CHAIN_ID, NETWORKS, type AgentBook, type NetworkBook } from './networks.js';
import { MAX_DEADLINE_SECONDS } from './policy.js';
import { redactUrl, redactUrlsIn } from './redact.js';
import { verifyNetwork } from './verify.js';

export interface CreateClientOptions {
  network: 'mainnet' | 'testnet' | NetworkBook;
  rpcUrl?: string;
  /** Optional API key (`mfk_live_…` / `mfk_test_…`); a rate tier only, never a fund authority. */
  apiKey?: string;
  /** Inject an API implementation, or `null` for chain-only use. */
  api?: MercurifiApi | null;
  /** Test hook: a viem transport used instead of HTTP. */
  transport?: Transport;
  verify?: boolean;
  receiptTimeoutMs?: number;
  pollMs?: number;
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
  deadlineSeconds: number;
  apiKey: string | undefined;
}

export const arcChain = (book: NetworkBook, rpcUrl: string): Chain =>
  defineChain({
    id: book.chainId,
    name: `Arc ${book.name}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

export class MercurifiClient {
  constructor(
    readonly network: NetworkBook,
    readonly publicClient: PublicClient,
    readonly api: MercurifiApi | null,
    readonly settings: ClientSettings,
    private readonly onWarning: (message: string) => void,
  ) {}

  /** The agent deployment book (factory, implementation, policy registry), or NotDeployedError on a network without one. */
  requireAgents(): AgentBook {
    if (this.network.agents === null) throw new NotDeployedError(this.network.name);
    return this.network.agents;
  }

  warn(message: string): void {
    this.onWarning(message);
  }
}

const resolveBook = (network: CreateClientOptions['network']): NetworkBook => {
  if (typeof network === 'string') {
    const book = Object.hasOwn(NETWORKS, network) ? (NETWORKS as Record<string, NetworkBook>)[network] : undefined;
    if (book === undefined) throw new InvalidInputError('network', "network must be 'mainnet', 'testnet' or a local address book");
    return book;
  }
  if (network.name !== 'local' || network.chainId !== LOCAL_CHAIN_ID) {
    throw new NetworkMismatchError(`custom address books are accepted only for the local chain ${LOCAL_CHAIN_ID}; use 'mainnet' or 'testnet' for Arc`);
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
    throw new InvalidInputError('rpcUrl', 'rpcUrl is not a valid URL; expected http(s)://host[:port][/path]');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new InvalidInputError('rpcUrl', 'rpcUrl must start with http:// or https://');
  if (book.name === 'local' && !isLoopbackUrl(rpcUrl)) throw new NetworkMismatchError('a local address book needs a loopback RPC (127.0.0.1, localhost or [::1])');
  if (options.apiKey !== undefined && options.apiKey.trim() === '') {
    throw new InvalidInputError('apiKey', 'apiKey is empty; omit it for keyless use, or pass a key that starts with mfk_live_ or mfk_test_');
  }
  if (options.apiKey !== undefined && book.apiKeyPrefix !== null && !options.apiKey.startsWith(book.apiKeyPrefix)) {
    throw new NetworkMismatchError(`This API key belongs to the other network; ${book.name} keys start with ${book.apiKeyPrefix}`);
  }
  const deadlineSeconds = options.deadlineSeconds ?? 60;
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > MAX_DEADLINE_SECONDS) {
    throw new InvalidInputError('deadlineSeconds', `deadlineSeconds must be an integer in 1..${MAX_DEADLINE_SECONDS}`);
  }
  const publicClient = createPublicClient({
    chain: arcChain(book, rpcUrl),
    transport: options.transport ?? http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  }) as PublicClient;
  if (options.verify !== false) {
    try {
      await verifyNetwork(publicClient, book);
    } catch (error) {
      if (error instanceof MercurifiError) throw error;
      // Transport failures carry the full RPC URL (often with a key); surface the host only and drop the cause.
      const reason = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
      throw new MercurifiError('RPC_ERROR', `RPC ${redactUrl(rpcUrl)} failed during start-up verification: ${redactUrlsIn(reason).split('\n')[0]}`);
    }
  }
  const settings: ClientSettings = {
    receiptTimeoutMs: options.receiptTimeoutMs ?? 60_000,
    pollMs: options.pollMs ?? 250,
    maxFeePerGasCap: options.maxFeePerGasCap,
    deadlineSeconds,
    apiKey: options.apiKey,
  };
  const api = options.api === undefined ? null : options.api;
  return new MercurifiClient(book, publicClient, api, settings, options.onWarning ?? ((m) => console.warn(`[mercurifi] ${m}`)));
};
