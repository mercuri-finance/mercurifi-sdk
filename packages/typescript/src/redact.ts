import { MercurifiError } from './errors.js';

/** Host only (no path, query or credentials): RPC URLs often carry an API key in the path. */
export const redactUrl = (url: string): string => {
  try {
    return new URL(url).host || 'invalid URL';
  } catch {
    return 'invalid URL';
  }
};

// Any "scheme://" or "scheme:\\" (ipfs://, file://, https:\\ ...) matches anywhere, with no leading word boundary
// ("x:https://k@h/KEY" must not slip through); data:/javascript: only after a non-alphanumeric so words such as
// "metadata:" are left alone.
const URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:[\\/]{2}|(?<![A-Za-z0-9])(?:data|javascript):)[^\s"'<>)]*/gi;

/** Replaces every URL in a message with its host ("invalid URL" for schemes without one). */
export const redactUrlsIn = (message: string): string => message.replace(URL_PATTERN, (u) => redactUrl(u));

// Terminal escape sequences: CSI, OSC (BEL or ST terminated) and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/**
 * The one sanitiser for text an attacker controls (revert reasons, token names, descriptions, links): escape sequences
 * removed, control characters and line/paragraph separators turned into a single space, Unicode format characters (bidi
 * overrides, zero-width, BOM) removed before URL redaction so "ht\u200Btp://" cannot hide a URL, URLs reduced to hosts
 * unless `keepUrls`, and lone surrogates dropped. Callers add their own quoting, length bound and framing.
 */
export const neutralizeUntrusted = (raw: string, o: { keepUrls?: boolean } = {}): string => {
  const plain = raw
    .replace(ANSI, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
  return o.keepUrls === true ? plain : redactUrlsIn(plain);
};

/** Keeps at most `max` code points (never splits a surrogate pair) and appends `suffix` when it cut. */
export const truncateChars = (text: string, max: number, suffix: string): string => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}${suffix}` : text;
};

/**
 * Turns any non-SDK failure from the RPC path into a credential-free error: viem's `shortMessage` (never the long
 * message, which embeds `URL: …` and request bodies), URLs reduced to hosts, first line only, no cause kept.
 */
export const rpcError = (error: unknown): MercurifiError => {
  if (error instanceof MercurifiError) return error;
  const raw = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
  return new MercurifiError('RPC_ERROR', `The RPC request failed: ${redactUrlsIn(raw).split('\n')[0]}`);
};
