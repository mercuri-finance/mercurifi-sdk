import { vi } from 'vitest';
import type { Address } from 'viem';

import { buildSignInMessage, type SignInKind } from '../../src/signin.js';

export interface FakeSocialApiOptions {
  /** Seconds from the clock at sign-in to the session's expiry (default 3600). */
  expiresIn?: number;
  chainId?: number;
  service?: 'launch' | 'trade';
  /** The fake's clock in ms; the challenge is issued at this time. */
  now?: () => number;
}

/**
 * A fake of the sign-in routes. The challenge text is built from the (kind, account, signer) the session sends,
 * on the fake's own chainId, as the API does; each sign-in returns `bearer-<n>` for the n-th session.
 */
export const fakeSocialApi = (opts: FakeSocialApiOptions = {}) => {
  const chainId = opts.chainId ?? 5042002;

  const now = opts.now ?? (() => Date.parse('2026-10-16T12:00:00Z'));

  let challenges = 0;

  let sessions = 0;

  let last: { kind: SignInKind; account: Address } = {
    kind: 'agent',
    account: '0x0000000000000000000000000000000000000000',
  };

  return {
    chainId,
    signInChallenge: vi.fn(async (kind: SignInKind, account: Address, signer: Address) => {
      challenges += 1;
      last = { kind, account };
      const nonce = challenges.toString(16).padStart(32, '0');
      const t = now();
      return {
        nonce,
        message: buildSignInMessage(
          { kind, account, signer, chainId, service: opts.service ?? 'launch' },
          nonce,
          new Date(t),
          new Date(t + 300_000),
        ),
        issuedAt: Math.floor(t / 1000),
        expiresAt: Math.floor(t / 1000) + 300,
      };
    }),
    signIn: vi.fn(async (_nonce: string, _signature: `0x${string}`) => {
      sessions += 1;
      return {
        token: `bearer-${sessions}`,
        kind: last.kind,
        account: last.account,
        expiresAt: Math.floor(now() / 1000) + (opts.expiresIn ?? 3600),
      };
    }),
    signOut: vi.fn(async (_bearer: string) => undefined),
  };
};
