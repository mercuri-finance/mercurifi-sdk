import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient, type Transport } from 'viem';

import { AgentClient } from './agent.js';
import { HttpApi } from './api/http.js';
import type { MercurifiApi } from './api/types.js';
import { InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError } from './errors.js';
import { isLoopbackUrl, LOCAL_CHAIN_ID, NETWORKS, type AgentBook, type NetworkBook } from './networks.js';
import { MAX_PRIORITY_FEE_PER_GAS } from './gas.js';
import { MAX_DEADLINE_SECONDS } from './policy.js';
import { NonceManager } from './nonce.js';
import { OwnerClient } from './owner.js';
import { redactUrl, redactUrlsIn } from './redact.js';
import type { Signer } from './signers.js';
import { TxSender } from './tx.js';
import { isAgentAccount } from './reads.js';
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
    rpcUrls: { default: { http: [rpcUrl] } },
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
    this.nonces = new NonceManager((address) => publicClient.getTransactionCount({ address, blockTag: 'pending' }));
    this.sender = new TxSender({
      client: publicClient, chainId: network.chainId, nonces: this.nonces,
      receiptTimeoutMs: settings.receiptTimeoutMs, pollMs: settings.pollMs, maxFeePerGasCap: settings.maxFeePerGasCap,
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
  async agent(o: { account: Address; signer: Signer; slippage?: number; deadlineSeconds?: number }): Promise<AgentClient> {
    const agents = this.requireAgents();
    if (!(await isAgentAccount(this.publicClient, agents, o.account))) {
      throw new InvalidInputError('account', `${o.account} is not a Mercurifi agent account on ${this.network.name}`);
    }
    const deadlineSeconds = o.deadlineSeconds ?? this.settings.deadlineSeconds;
    return new AgentClient(this, agents, o.account, o.signer, slippageToBps(o.slippage ?? 0.01), deadlineSeconds);
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
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  for (const [field, value] of [['receiptTimeoutMs', receiptTimeoutMs], ['pollMs', pollMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new InvalidInputError(field, `${field} must be a positive integer (milliseconds)`);
  }
  const maxPriorityFeePerGas = options.maxPriorityFeePerGas ?? MAX_PRIORITY_FEE_PER_GAS;
  if (typeof maxPriorityFeePerGas !== 'bigint' || maxPriorityFeePerGas < 1n) {
    throw new InvalidInputError('maxPriorityFeePerGas', 'maxPriorityFeePerGas must be a positive bigint (wei per gas)');
  }
  const publicClient = createPublicClient({
    chain: arcChain(book, rpcUrl),
    transport: options.transport ?? http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
  }) as PublicClient;
  const onWarning = options.onWarning ?? ((m) => console.warn(`[mercurifi] ${m}`));
  // Skipping start-up verification is for the loopback book only; on Arc the chain check is unconditional.
  if (options.verify === false && book.name !== 'local') {
    onWarning(`verify: false is ignored on ${book.name}; start-up verification always runs outside the local book.`);
  }
  if (options.verify !== false || book.name !== 'local') {
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
    receiptTimeoutMs,
    pollMs,
    maxFeePerGasCap: options.maxFeePerGasCap,
    maxPriorityFeePerGas,
    deadlineSeconds,
    hasApiKey: options.apiKey !== undefined,
  };
  const apiBaseUrl = options.apiBaseUrl ?? book.apiBaseUrl;
  const api = options.api !== undefined
    ? options.api
    : apiBaseUrl === null ? null : new HttpApi({ baseUrl: apiBaseUrl, chainId: book.chainId, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) });
  return new MercurifiClient(book, publicClient, api, settings, onWarning);
};
