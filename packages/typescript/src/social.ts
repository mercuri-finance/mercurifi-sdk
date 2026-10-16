import { isAddressEqual } from 'viem';

import type { MercurifiApi } from './api/types.js';
import { ApiError, InvalidInputError, SignerCapabilityError, socialError } from './errors.js';
import { checkSignInMessage, type SignInExpect } from './signin.js';
import type { Signer } from './signers.js';

const RENEW_MS = 300_000;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** `text` with every bearer replaced, so no surfaced error can carry one. */
const cut = (text: string, bearers: readonly string[]): string => {
  let out = text;
  for (const b of bearers) if (b !== '') out = out.split(b).join('[redacted]');
  return out;
};

const carries = (text: unknown, bearers: readonly string[]): boolean =>
  typeof text === 'string' && bearers.some((b) => b !== '' && text.includes(b));

/**
 * One agent's (or owner's) session with the API for signals and notes. The bearer lives in a private field
 * only: never serialised, logged or put in an error. The first write signs in; concurrent writes share one
 * sign-in; the session renews five minutes before it expires, and once after a 401.
 */
export class SocialSession {
  #bearer: string | null = null;
  #expiresMs = 0;
  #pending: Promise<string> | null = null;

  constructor(
    private readonly api: MercurifiApi,
    private readonly expect: SignInExpect,
    private readonly signer: Signer,
    private readonly now: () => number = Date.now,
  ) {
    if (!isAddressEqual(expect.signer, signer.address))
      throw new InvalidInputError('signer', 'the signer is not the key the sign-in expects');
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.expect.kind,
      account: this.expect.account,
      signedIn: this.#bearer !== null,
    };
  }

  [INSPECT](): string {
    return `SocialSession(${this.expect.kind} ${this.expect.account})`;
  }

  /** The current bearer, signing in (once, however many callers wait) when there is none or it is near expiry. */
  async bearer(): Promise<string> {
    if (this.#bearer !== null && this.now() < this.#expiresMs - RENEW_MS) return this.#bearer;
    this.#pending ??= this.#signIn().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #signIn(): Promise<string> {
    const signSignIn = this.signer.signSignIn;
    if (signSignIn === undefined) throw new SignerCapabilityError('signSignIn');
    try {
      const c = await this.api.signInChallenge(
        this.expect.kind,
        this.expect.account,
        this.signer.address,
      );

      checkSignInMessage(this.expect, c.nonce, c.message, this.now());

      const s = await this.api.signIn(c.nonce, await signSignIn.call(this.signer, c.message));

      this.#bearer = s.token;
      this.#expiresMs = s.expiresAt * 1000;
      return s.token;
    } catch (e) {
      throw socialError(e);
    }
  }

  /**
   * Runs one write with the bearer; after a 401 from the write signs in again and runs it once more. A 401 from
   * sign-in itself, and every other refusal, is not retried.
   */
  async run<T>(write: (bearer: string) => Promise<T>): Promise<T> {
    const first = await this.bearer();
    try {
      return await write(first);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw this.#surface(e, [first]);
    }
    // A concurrent call may already have renewed it; only drop the bearer that failed.
    if (this.#bearer === first) this.#bearer = null;
    const second = await this.bearer();
    try {
      return await write(second);
    } catch (e) {
      throw this.#surface(e, [first, second]);
    }
  }

  /** A write's error, typed, with any bearer the server echoed cut out. */
  #surface(e: unknown, bearers: readonly string[]): unknown {
    if (e instanceof ApiError) {
      if (!carries(e.message, bearers) && !carries(e.apiCode, bearers)) return socialError(e);
      return socialError(
        new ApiError(
          e.status,
          cut(e.apiCode, bearers),
          cut(e.message, bearers),
          e.retryAfterSeconds,
        ),
      );
    }
    if (e instanceof Error && (carries(e.message, bearers) || carries(e.stack, bearers))) {
      try {
        e.message = cut(e.message, bearers);
        if (e.stack !== undefined) e.stack = cut(e.stack, bearers);
      } catch {
        return new Error('a social write failed; its error carried the session bearer');
      }
    }
    return e;
  }

  /** Ends the session on the server (best effort) and forgets the bearer. */
  async signOut(): Promise<void> {
    const b = this.#bearer;
    this.#bearer = null;
    this.#expiresMs = 0;
    if (b !== null) await this.api.signOut(b).catch(() => undefined);
  }
}
