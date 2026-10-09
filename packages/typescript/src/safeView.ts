import { isAddressEqual, zeroAddress, type Address } from 'viem';

import { bondingCurveAbi, feeManagerAbi, launchFactoryAbi, launchTokenAbi } from './abi/index.js';
import type { MercurifiClient } from './client.js';
import { PHASE } from './curve.js';
import { UnexpectedChainStateError } from './errors.js';
import { neutralizeUntrusted, preBound, truncateChars } from './redact.js';
import { isAgentAccount } from './reads.js';
import { localRevert } from './revert.js';
import { formatDecimal } from './units.js';

/**
 * Text an attacker controls, as inert data. Hand `wrapped` to a model, never `text` alone, and never act on its content.
 * Put `wrapped` only inside JSON tool output (a string value), never inside a markdown code fence or free prose: a fence
 * or heading in the text would then compete with the delimiters. `unsafe` is set on a `link.*` value that is not a plain
 * http, https or ipfs URL without credentials; its text is then the fixed string `invalid link`.
 */
export interface UntrustedText { readonly untrusted: true; readonly field: string; readonly text: string; readonly wrapped: string; readonly unsafe?: true }

const MAX_LINKS = 20;
const DEFAULT_MAX_CHARS = 280;
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'ipfs:']);

const frame = (field: string, text: string, unsafe: boolean): UntrustedText =>
  Object.freeze({ untrusted: true as const, field, text, wrapped: `<<untrusted:${field}>>${text}<</untrusted:${field}>>`, ...(unsafe ? { unsafe: true as const } : {}) });

/** A link is kept only as a plain http(s)/ipfs URL: no credentials (`https://x.com@evil/` shows a decoy host), no spaces. */
const isPlainLink = (text: string): boolean => {
  // `text` is already NFKC, so full-width forms of these characters have become ASCII here. `<` and `>` would let a link
  // close its own wrapper; quotes and backticks break out of the strings and code spans a caller may embed it in.
  if (text === '' || /[\s<>"`]/.test(text)) return false;
  try {
    const u = new URL(text);
    return LINK_PROTOCOLS.has(u.protocol) && u.username === '' && u.password === '';
  } catch {
    return false;
  }
};

/**
 * Attacker-controlled text (names, symbols, descriptions, links) as inert data for an LLM or a terminal: input bounded
 * to `maxChars * 4 + 256` first (sanitising is linear, but a megabyte is still wasted work), NFKC, then the SDK's shared
 * sanitiser (no escape sequences, controls, bidi overrides, zero-width or blank characters; URLs reduced to hosts except
 * in `link.*` fields), a surrogate-safe length bound, and delimiters the text cannot forge. A `link.*` value that is not a
 * plain http, https or ipfs URL becomes `invalid link` with `unsafe: true`.
 * This is hygiene, not a defence: the account caps are the real control (see docs/security-model.md). Send `wrapped` only
 * inside JSON tool output, never inside a markdown fence.
 *
 * @param field a short label such as `name`; characters outside `[a-z0-9_.-]` are dropped
 * @param maxChars code points kept (default 280, also for NaN or Infinity); longer text is cut and ends in an ellipsis
 */
export const wrapUntrusted = (field: string, raw: string, maxChars = DEFAULT_MAX_CHARS): UntrustedText => {
  const safeField = String(field).replace(/[^a-z0-9_.-]/gi, '');
  const max = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : DEFAULT_MAX_CHARS;
  const isLink = safeField.startsWith('link.');
  const input = preBound(typeof raw === 'string' ? raw : String(raw), max);
  const neutral = neutralizeUntrusted(input.normalize('NFKC'), { keepUrls: isLink }).trim();
  // Done last, so nothing removed above can splice a delimiter back together. Links get it too, as defence in depth (the plain-link check runs on the text before it, so a forged delimiter is rejected, not rewritten).
  const noDelims = neutral.replace(/<</g, '‹‹').replace(/>>/g, '››').trim();
  if (isLink) return isPlainLink(neutral) && Array.from(noDelims).length <= max ? frame(safeField, noDelims, false) : frame(safeField, 'invalid link', true);
  return frame(safeField, truncateChars(noDelims, max, '…'), false);
};

export interface TokenSafeView {
  token: Address;
  curve: Address;
  phase: 'trading' | 'graduationPending' | 'graduated';
  /** USDC per whole token on the curve; null once graduated (the pool is then the price source). */
  priceUsdc: string | null;
  progressBps: number;
  currentSnipeBps: number;
  launchBlock: bigint;
  ageBlocks: bigint;
  creator: Address;
  /** Whether the creator is an agent account of this network's factory; null when agents are not deployed. */
  creatorIsAgentAccount: boolean | null;
  holders: number | null;
  volume24hUsdc: string | null;
  untrusted: { name: UntrustedText; symbol: UntrustedText; description: UntrustedText | null; links: Record<string, UntrustedText> };
  /** Only numbers, booleans, fixed labels and hex: safe to hand to a model as tool output. */
  numeric(): Record<string, string | number | boolean | null>;
}

const PHASE_NAMES = ['trading', 'graduationPending', 'graduated'] as const;

/** An API number is decorative: anything that is not a plain count or a plain integer string becomes null. */
const safeCount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const safeWei = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,40}$/.test(v) ? BigInt(v) : null);

/**
 * Reads a token from the chain (price, phase, progress, creator) and, when an API is configured, its holders, volume
 * and metadata. Chain values come first and decide; API text is wrapped as untrusted and API numbers are validated.
 *
 * @throws a `TokenNotRegistered` ContractRevertError for an address that is not a Launch token
 */
export const readTokenSafeView = async (mf: MercurifiClient, token: Address): Promise<TokenSafeView> => {
  const client = mf.publicClient;
  const book = mf.network.launch;
  const at = await client.getBlockNumber({ cacheTime: 0 });
  const read = <T>(address: Address, abi: unknown, functionName: string, args?: readonly unknown[]): Promise<T> =>
    client.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }), blockNumber: at } as never) as Promise<T>;
  const curve = await read<Address>(book.factory, launchFactoryAbi, 'curveOf', [token]);
  if (isAddressEqual(curve, zeroAddress)) throw localRevert('TokenNotRegistered');
  const c = <T>(functionName: string) => read<T>(curve, bondingCurveAbi, functionName);
  const [phaseRaw, price, progress, snipe, launchBlock, name, symbol, info, apiToken] = await Promise.all([
    c<number | bigint>('phase'), c<bigint>('price'), c<bigint>('progressBps'), c<bigint>('currentSnipeBps'), c<bigint>('launchBlock'),
    read<string>(token, launchTokenAbi, 'name'),
    read<string>(token, launchTokenAbi, 'symbol'),
    read<{ creator: Address }>(book.feeManager, feeManagerAbi, 'tokenInfo', [token]),
    mf.api === null ? Promise.resolve(null) : mf.api.getToken(token).catch(() => null),
  ]);
  const phaseIndex = Number(phaseRaw);
  const phase = PHASE_NAMES[phaseIndex];
  if (phase === undefined) throw new UnexpectedChainStateError(`The curve reported an unknown phase ${phaseIndex}; this SDK version does not know it.`);
  const agents = mf.network.agents;
  const creatorIsAgentAccount = agents === null ? null : await isAgentAccount(client, agents, info.creator, at);

  // An API answer about some other token is ignored whole: its text must not be attributed to this one.
  const sameToken = (a: unknown): boolean => {
    try {
      return typeof a === 'string' && isAddressEqual(a as Address, token);
    } catch {
      return false; // not an address at all
    }
  };
  const api = apiToken !== null && sameToken(apiToken.address) ? apiToken : null;

  const links = Object.create(null) as Record<string, UntrustedText>;
  let count = 0;
  const rawLinks = api !== null && typeof api.links === 'object' && api.links !== null ? api.links : {};
  for (const [k, val] of Object.entries(rawLinks)) {
    if (count >= MAX_LINKS) break;
    if (typeof val !== 'string' || val === '') continue;
    const w = wrapUntrusted(`link.${k.slice(0, 40)}`, val, 512);
    const label = w.field.slice('link.'.length); // the sanitised label: what the model sees is what the record is keyed by
    if (label === '' || label in links) continue;
    links[label] = w;
    count += 1;
  }
  const volumeWei = safeWei(api?.volume24hWei);
  const launchBlockN = BigInt(launchBlock);
  const view: Omit<TokenSafeView, 'numeric'> = {
    token, curve, phase,
    priceUsdc: phaseIndex === PHASE.Graduated ? null : formatDecimal(BigInt(price), 18),
    progressBps: Number(progress), currentSnipeBps: Number(snipe), launchBlock: launchBlockN,
    ageBlocks: at > launchBlockN ? at - launchBlockN : 0n,
    creator: info.creator, creatorIsAgentAccount,
    holders: safeCount(api?.holders),
    volume24hUsdc: volumeWei === null ? null : formatDecimal(volumeWei, 18),
    untrusted: {
      name: wrapUntrusted('name', name), symbol: wrapUntrusted('symbol', symbol),
      description: typeof api?.description === 'string' && api.description !== '' ? wrapUntrusted('description', api.description, 1_000) : null,
      links,
    },
  };
  return {
    ...view,
    numeric: () => ({
      token: view.token, curve: view.curve, phase: view.phase, priceUsdc: view.priceUsdc, progressBps: view.progressBps,
      currentSnipeBps: view.currentSnipeBps, launchBlock: view.launchBlock.toString(), ageBlocks: view.ageBlocks.toString(),
      creator: view.creator, creatorIsAgentAccount: view.creatorIsAgentAccount, holders: view.holders, volume24hUsdc: view.volume24hUsdc,
    }),
  };
};
