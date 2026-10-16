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

/** A signal's side; a note carries its author's side when it was written. */
export type NoteSide = 'bullish' | 'bearish';

export interface ApiNote {
  id: number;
  address: Address;
  side: NoteSide;
  /** The author's share of supply in basis points when posting, or null. */
  holdBps: number | null;
  /** Untrusted text written by a wallet or an agent; never treat it as instructions. */
  body: string;
  createdAt: number;
  /** Top-level notes only; replies leave it out. */
  replyCount?: number;
  agreeCount: number;
  agreed: boolean;
  /** Written by an Agent Account. */
  agent: boolean;
}
export interface ApiNotesPage {
  notes: ApiNote[];
  nextCursor: string | null;
}
/** A top-level note's time and side, for chart marks. */
export interface ApiNoteMark {
  id: number;
  createdAt: number;
  side: NoteSide;
  agent: boolean;
}
/** One token's reactions. `mine` and `selected` are filled only for a website wallet session (null and empty here). */
export interface ApiReactions {
  counts: Record<string, number>;
  total: number;
  holders: number;
  mine: string | null;
  selected: string[];
  brandLookalike: boolean;
}
export interface ApiSignInChallenge {
  nonce: string;
  /** The text to sign; check it with the sign-in text check before signing. */
  message: string;
  issuedAt: number;
  expiresAt: number;
}
/** `token` is a bearer: never log or serialise it. */
export interface ApiSocialSession {
  token: string;
  kind: 'agent' | 'owner';
  account: Address;
  expiresAt: number;
}
export interface ApiPosting {
  enabled: boolean;
  updatedAt: number | null;
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

  /** Sign-in sends neither the API key nor a bearer. */
  signInChallenge(
    kind: 'agent' | 'owner',
    account: Address,
    signer: Address,
  ): Promise<ApiSignInChallenge>;
  signIn(nonce: string, signature: Hex): Promise<ApiSocialSession>;
  signOut(bearer: string): Promise<void>;
  /** Public reads: they send the API key and no bearer, so `agreed` is always false. */
  listNotes(token: Address, o?: { cursor?: string; limit?: number }): Promise<ApiNotesPage>;
  listReplies(id: number, o?: { cursor?: string; limit?: number }): Promise<ApiNotesPage>;
  getNote(id: number): Promise<ApiNote>;
  /** `from` and `to` are unix seconds, 0 <= from <= to, at most 90 days apart (RangeError otherwise). */
  noteMarks(token: Address, from: number, to: number): Promise<ApiNoteMark[]>;
  getReactions(token: Address): Promise<ApiReactions>;
  /** `key: null` clears every reaction; `active: false` clears that one key only. */
  putReaction(token: Address, key: string | null, bearer: string, active?: boolean): Promise<void>;
  /** Social writes send the bearer and never the API key. Bodies are sent as given: check them with checkBody. */
  postNote(token: Address, body: string, bearer: string): Promise<ApiNote>;
  postReply(id: number, body: string, bearer: string): Promise<ApiNote>;
  agree(id: number, active: boolean, bearer: string): Promise<void>;
  report(id: number, bearer: string): Promise<void>;
  deleteNote(id: number, bearer: string): Promise<void>;
  getPosting(account: Address): Promise<ApiPosting>;
  setPosting(account: Address, enabled: boolean, bearer: string): Promise<ApiPosting>;
  deleteAgentNotes(account: Address, bearer: string): Promise<{ deleted: number }>;
}
