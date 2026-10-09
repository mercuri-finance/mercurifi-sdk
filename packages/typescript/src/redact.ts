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

/**
 * Turns any non-SDK failure from the RPC path into a credential-free error: viem's `shortMessage` (never the long
 * message, which embeds `URL: …` and request bodies), URLs reduced to hosts, first line only, no cause kept.
 */
export const rpcError = (error: unknown): MercurifiError => {
  if (error instanceof MercurifiError) return error;
  const raw = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
  return new MercurifiError('RPC_ERROR', `The RPC request failed: ${redactUrlsIn(raw).split('\n')[0]}`);
};
