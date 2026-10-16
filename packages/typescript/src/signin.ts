import { getAddress, type Address } from 'viem';

import { SignInRefusedError } from './errors.js';

export type SignInKind = 'agent' | 'owner';

/** What the SDK expects to sign: everything but the server's nonce and times. */
export interface SignInExpect {
  kind: SignInKind;
  account: Address;
  signer: Address;
  chainId: number;
  service: 'launch' | 'trade';
}

const SKEW_MS = 120_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 300_000;
const NONCE = /^[0-9a-f]{32}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const SIGN_IN_WARNING = 'Sign this only in the Mercurifi SDK, never on a website.';

const stamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The exact text the API issues (backend agent_auth_message.go); pinned by fixtures/vectors/agentsignin.json. */
export const buildSignInMessage = (
  e: SignInExpect,
  nonce: string,
  issued: Date,
  expires: Date,
): string => {
  const head = e.kind === 'owner' ? 'Owner sign-in for account ' : 'Agent sign-in for account ';

  const who = e.kind === 'owner' ? 'Owner: ' : 'Agent key: ';

  return [
    `${head}${getAddress(e.account)} on Arc (chain ${e.chainId}, ${e.service})`,
    `${who}${getAddress(e.signer)}`,
    `Nonce: ${nonce}`,
    `Issued: ${stamp(issued)}`,
    `Expires: ${stamp(expires)}`,
    SIGN_IN_WARNING,
  ].join('\n');
};

/**
 * Throws unless `message` is exactly the text this SDK would build for `e`, with the server's nonce and a
 * window of at most five minutes that matches the local clock within two minutes. The agent key never signs
 * anything else, so a compromised or spoofed API cannot get it to sign other text.
 */
export const checkSignInMessage = (
  e: SignInExpect,
  nonce: string,
  message: string,
  nowMs: number,
): void => {
  if (!NONCE.test(nonce)) throw new SignInRefusedError('text', 'the nonce is not 32 hex digits');

  const issuedRaw = /\nIssued: ([^\n]*)\n/.exec(message)?.[1] ?? '';

  const expiresRaw = /\nExpires: ([^\n]*)\n/.exec(message)?.[1] ?? '';

  if (!STAMP.test(issuedRaw) || !STAMP.test(expiresRaw))
    throw new SignInRefusedError('text', 'the message has no valid times');

  const issued = new Date(issuedRaw);

  const expires = new Date(expiresRaw);

  if (buildSignInMessage(e, nonce, issued, expires) !== message)
    throw new SignInRefusedError('text', 'the message is not the sign-in text this SDK expects');

  const window = expires.getTime() - issued.getTime();

  if (window > MAX_WINDOW_MS)
    throw new SignInRefusedError(
      'window',
      'the sign-in window is longer than five minutes (Expires is too far after Issued)',
    );

  if (window < MIN_WINDOW_MS)
    throw new SignInRefusedError(
      'window',
      'the sign-in window is too short or not positive (Expires must be at least one second after Issued)',
    );

  if (Math.abs(issued.getTime() - nowMs) > SKEW_MS)
    throw new SignInRefusedError(
      'clock',
      'Issued is more than two minutes from the clock on this machine; sync it (NTP) and retry',
    );

  if (expires.getTime() < nowMs - SKEW_MS)
    throw new SignInRefusedError(
      'clock',
      'the sign-in has already expired by the clock on this machine; sync it (NTP) and retry',
    );
};
