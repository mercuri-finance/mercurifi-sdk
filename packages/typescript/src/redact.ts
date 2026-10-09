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
// The lookbehind anchors a scheme at the start of its run, so a long letter run is scanned once (linear), not once per start.
const URL_PATTERN = /(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:[\\/]{2}|(?<![A-Za-z0-9])(?:data|javascript):)[^\s"'<>)]*/gi;

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
    // Invisible or blank "letters": Hangul fillers, Braille blank, combining grapheme joiner, variation selectors outside
    // emoji sequences (a selector after a pictograph, digit, # or * keeps its emoji/keycap meaning).
    .replace(/[\u034f\u115f\u1160\u2800\u3164\uffa0]|[\u{e0100}-\u{e01ef}]|(?<![\p{Extended_Pictographic}#*0-9])[\ufe00-\ufe0f]/gu, '')
    .replace(/(\p{M}{4})\p{M}+/gu, '$1') // zalgo: at most 4 combining marks in a row
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
  return o.keepUrls === true ? plain : redactUrlsIn(plain);
};

/** How much raw input is worth sanitising for a result of `maxChars` code points: 4x plus a margin (stripping only shrinks the text; NFKC can expand a code point, e.g. U+FDFA to 18, but the result is truncated to `maxChars` afterwards, so the output bound holds). */
export const preBound = (raw: string, maxChars: number): string => raw.slice(0, maxChars * 4 + 256);

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
