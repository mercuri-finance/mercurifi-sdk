import type { Address, Hex } from 'viem';

/** Spec §6.1. Advisory data only: API keys select a rate tier and never authorise funds. USDC strings are usdc6. */
export type QuoteKind = 'curve-buy' | 'curve-sell' | 'pool-swap';
export type BuildFunction =
  'buy' | 'sell' | 'launch' | 'swapExactIn' | 'claimFees' | 'sweepToOwner';

export interface ApiAgentKey {
  agent: Address;
  permissions: string[];
  expiresAt: number;
  state: 'active' | 'expired' | 'revoked';
}
export interface ApiQueued {
  id: string;
  kind: string;
  eta: number;
  expiresAt: number;
  payload: unknown;
}
/** Read from the chain at `asOfBlock` (`?live=1`). */
export interface ApiLive {
  asOfBlock: number;
  periodSeconds: number;
  increaseDelay: number;
  periodId: string;
  spentUsdc: string;
  soldUsdc: string;
  actions: number;
  launches: number;
  headroomSpendUsdc: string;
  headroomSellUsdc: string;
  headroomActions: number;
  headroomLaunches: number;
  ownerPaused: boolean;
  factoryPaused: boolean;
}
export interface ApiAccount {
  account: Address;
  owner: Address;
  referrer: Address;
  factory: Address;
  createdBlock: number;
  createdTime: number;
  createdTx: Hex;
  paused: boolean;
  factoryPausedUntil: number;
  /** usdc6 caps as decimal strings; null before the first PolicyApplied is indexed. */
  policy: Record<string, string | number | boolean> | null;
  agents: ApiAgentKey[];
  allowedTokens: Address[];
  pending: ApiQueued[];
  live: ApiLive | null;
}
export interface ApiAccountSummary {
  account: Address;
  owner: Address;
  factory: Address;
  createdBlock: number;
  createdTime: number;
  paused: boolean;
  activeAgents: number;
}
export interface ApiAction {
  id: string;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
  blockTime: number;
  agent: Address;
  action: string;
  token: Address;
  usdcSpent: string;
  usdcReceived: string;
  /** Signed token wei. */
  tokenDelta: string;
  basisValue: string;
  periodId: number;
}
/** The SDK's page; the API sends a JSON array and the next cursor in the `Next-Cursor` header. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface CurveBuyQuote {
  token: Address;
  usdcIn: string;
}
export interface CurveSellQuote {
  token: Address;
  tokensIn: string;
}
export interface PoolSwapQuote {
  token: Address;
  buyToken: boolean;
  amountIn: string;
  account?: Address;
}
export type QuoteRequest = CurveBuyQuote | CurveSellQuote | PoolSwapQuote;
export interface ApiQuote {
  advisory: true;
  asOfBlock: number;
  [key: string]: unknown;
}
/** Owner, pending-owner and permissionless functions the API also builds (verify them with verifyBuiltOwnerTx). */
export type OwnerBuildFunction =
  | 'withdraw'
  | 'withdrawMany'
  | 'addAgent'
  | 'setAgent'
  | 'revokeAgent'
  | 'rotateAgent'
  | 'setPolicy'
  | 'setTokenAllowed'
  | 'setIncreaseDelay'
  | 'transferOwnership'
  | 'acceptOwnership'
  | 'executeQueued'
  | 'cancelQueued'
  | 'pauseAgents';
/** Strings for numbers and addresses; lists for `permissions` and `tokens`; an object of strings and booleans for `policy`. */
export type BuildArg =
  string | boolean | readonly string[] | Readonly<Record<string, string | boolean>>;
export interface BuildRequest {
  account: Address;
  function: BuildFunction | OwnerBuildFunction;
  args: Record<string, BuildArg>;
}
export interface BuiltTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: string;
  function?: string;
  selector?: Hex;
}
export interface LaunchMetadata {
  description?: string;
  links?: Record<string, string>;
}
export interface ImageUpload {
  bytes: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
  filename?: string;
}
export interface UploadedMetadata {
  metadataURI: string;
  imageStatus: 'clean' | 'review' | null;
}
export interface ApiToken {
  address: Address;
  name: string;
  symbol: string;
  description: string | null;
  links: Record<string, string | null>;
  holders?: number;
  volume24hWei?: string;
  [key: string]: unknown;
}

/** The SDK's only view of the HTTP API; HttpApi implements it and tests substitute fakes. */
export interface MercurifiApi {
  readonly baseUrl: string;
  readonly chainId: number;
  /** `live: true` adds on-chain usage and headroom (needs an API key). */
  getAccount(account: Address, opts?: { live?: boolean }): Promise<ApiAccount>;
  listAccounts(owner: Address): Promise<ApiAccountSummary[]>;
  listActions(account: Address, cursor?: string): Promise<Page<ApiAction>>;
  quote(kind: QuoteKind, body: QuoteRequest): Promise<ApiQuote>;
  buildTx(body: BuildRequest): Promise<BuiltTx>;
  uploadLaunchMetadata(meta: LaunchMetadata, image?: ImageUpload): Promise<UploadedMetadata>;
  /** `null` when the API does not know the token yet (it answers 200 null); fall back to chain reads. */
  getToken(token: Address): Promise<ApiToken | null>;
  streamRequest(topics: readonly string[]): { url: string; headers: Record<string, string> };
}
