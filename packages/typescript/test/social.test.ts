import { inspect } from 'node:util';

import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentExpiredError,
  ApiError,
  BodyRejectedError,
  ChainUnavailableError,
  InvalidInputError,
  MercurifiError,
  NotAgentError,
  NotOwnerSocialError,
  OwnNoteError,
  PausedError,
  PostingOffError,
  RateLimitedError,
  SignalRequiredError,
  SignerCapabilityError,
  SignInRefusedError,
  socialError,
} from '../src/errors.js';
import { localKey } from '../src/signers.js';
import type { SignInExpect } from '../src/signin.js';
import { SocialSession } from '../src/social.js';
import { fakeSocialApi } from './helpers/socialApi.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const ACCOUNT = '0x000000000000000000000000000000000000001E';

const T0 = Date.parse('2026-10-16T12:00:00Z');

const setup = (opts: { expiresIn?: number } = {}) => {
  const clock = { ms: T0 };

  const now = () => clock.ms;

  const api = fakeSocialApi({ ...opts, now });

  const signer = localKey(KEY);

  // Lowercase on purpose: the challenge echoes checksummed addresses and the check still passes.
  const e: SignInExpect = {
    kind: 'agent',
    account: ACCOUNT.toLowerCase() as `0x${string}`,
    signer: signer.address,
    chainId: api.chainId,
    service: 'launch',
  };

  const s = new SocialSession(api as never, e, signer, now);

  return { api, signer, e, s, clock };
};

const unauth = (msg = 'sign in required') => new ApiError(401, 'unauthenticated', msg, null);

describe('SocialSession', () => {
  it('signs in once for concurrent writes on a cold session and reuses the bearer', async () => {
    const { api, s } = setup();

    const seen = await Promise.all([s.run(async (b) => b), s.run(async (b) => b)]);

    expect(seen).toEqual(['bearer-1', 'bearer-1']);

    expect(api.signInChallenge).toHaveBeenCalledTimes(1);

    expect(api.signIn).toHaveBeenCalledTimes(1);

    expect(await s.run(async (b) => b)).toBe('bearer-1');

    expect(api.signIn).toHaveBeenCalledTimes(1);
  });

  it('signs the challenge with the agent key and the SDK checks it first', async () => {
    const { api, signer, s } = setup();

    await s.bearer();

    const [nonce, signature] = api.signIn.mock.calls[0]!;

    const { message } = await api.signInChallenge.mock.results[0]!.value;

    expect(signature).toBe(await signer.signSignIn!(message));

    expect(nonce).toBe('1'.padStart(32, '0'));
  });

  it('renews five minutes before expiry, not earlier', async () => {
    const { api, s, clock } = setup({ expiresIn: 3600 });

    await s.run(async (b) => b);

    const expiresMs = T0 + 3_600_000;

    clock.ms = expiresMs - 301_000;

    expect(await s.run(async (b) => b)).toBe('bearer-1');

    expect(api.signIn).toHaveBeenCalledTimes(1);

    clock.ms = expiresMs - 299_000;

    expect(await s.run(async (b) => b)).toBe('bearer-2');

    expect(api.signIn).toHaveBeenCalledTimes(2);
  });

  it('signs in again once after a write 401 and retries with the new bearer', async () => {
    const { api, s } = setup();

    const write = vi.fn(async (b: string) => {
      if (b === 'bearer-1') throw unauth();
      return b;
    });

    expect(await s.run(write)).toBe('bearer-2');

    expect(write).toHaveBeenCalledTimes(2);

    expect(api.signIn).toHaveBeenCalledTimes(2);
  });

  it('signs in again once after a 401, then gives up', async () => {
    const { api, s } = setup();

    const write = vi.fn(async () => {
      throw unauth();
    });

    await expect(s.run(write)).rejects.toBeInstanceOf(ApiError);

    expect(write).toHaveBeenCalledTimes(2);

    expect(api.signIn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401 from sign-in itself', async () => {
    const { api, s } = setup();

    api.signIn.mockRejectedValueOnce(unauth('bad signature'));

    const write = vi.fn(async (b: string) => b);

    await expect(s.run(write)).rejects.toMatchObject({ status: 401, apiCode: 'unauthenticated' });

    expect(api.signIn).toHaveBeenCalledTimes(1);

    expect(write).not.toHaveBeenCalled();
  });

  it('a failed sign-in does not poison the next attempt', async () => {
    const { api, s } = setup();

    api.signIn.mockRejectedValueOnce(new ApiError(403, 'not_agent', 'not an agent', null));

    await expect(s.run(async (b) => b)).rejects.toBeInstanceOf(NotAgentError);

    expect(await s.run(async (b) => b)).toBe('bearer-1');
  });

  it('keeps a bearer a concurrent call renewed after a 401', async () => {
    const { api, s } = setup();

    await s.bearer();

    let releaseLate!: () => void;

    const late = new Promise<void>((r) => {
      releaseLate = r;
    });

    // The first write's 401 renews to bearer-2; the second write's 401 for bearer-1 arrives after that and must
    // reuse bearer-2 rather than throw it away.
    const first = s.run(async (b) => {
      if (b === 'bearer-1') throw unauth();
      return b;
    });

    const second = s.run(async (b) => {
      if (b === 'bearer-1') {
        await late;
        throw unauth();
      }
      return b;
    });

    expect(await first).toBe('bearer-2');

    releaseLate();

    expect(await second).toBe('bearer-2');

    expect(api.signIn).toHaveBeenCalledTimes(2);
  });

  it('never retries a 403, and types it', async () => {
    const { s } = setup();

    const write = vi.fn(async () => {
      throw new ApiError(403, 'posting_off', 'off', null);
    });

    await expect(s.run(write)).rejects.toBeInstanceOf(PostingOffError);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('never retries a 429, and keeps retryAfterSeconds', async () => {
    const { s } = setup();

    const write = vi.fn(async () => {
      throw new ApiError(429, 'rate_limited', 'slow down', 30);
    });

    const err = await s.run(write).catch((x: unknown) => x);

    expect(err).toBeInstanceOf(RateLimitedError);

    expect(err).toMatchObject({ status: 429, apiCode: 'rate_limited', retryAfterSeconds: 30 });

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses a signer without signSignIn before any request', async () => {
    const { api, e } = setup();

    const bare = { address: e.signer, signTransaction: async () => '0x' as const };

    const s = new SocialSession(api as never, e, bare as never, () => T0);

    await expect(s.run(async (b) => b)).rejects.toBeInstanceOf(SignerCapabilityError);

    expect(api.signInChallenge).not.toHaveBeenCalled();
  });

  it('refuses a signer that is not the expected key', () => {
    const { api, e } = setup();

    const other = localKey(`0x${'11'.repeat(32)}`);

    expect(() => new SocialSession(api as never, e, other, () => T0)).toThrow(InvalidInputError);
  });

  it('refuses a challenge for another account without signing', async () => {
    const { api, signer, e } = setup();

    const spy = vi.fn(async (m: string) => signer.signSignIn!(m));

    const s = new SocialSession(api as never, e, { ...signer, signSignIn: spy }, () => T0);

    const real = api.signInChallenge.getMockImplementation()!;

    api.signInChallenge.mockImplementationOnce((kind, _account, key) =>
      real(kind, '0x000000000000000000000000000000000000dEaD', key),
    );

    await expect(s.run(async (b) => b)).rejects.toBeInstanceOf(SignInRefusedError);

    expect(spy).not.toHaveBeenCalled();

    expect(api.signIn).not.toHaveBeenCalled();
  });

  it.each<
    [string, Partial<{ kind: 'agent' | 'owner'; account: Address; expiresAt: number }>, RegExp]
  >([
    ['another kind', { kind: 'owner' }, /another account/],
    [
      'another account',
      { account: '0x000000000000000000000000000000000000dEaD' },
      /another account/,
    ],
    ['an expiry inside the renewal window', { expiresAt: T0 / 1000 + 300 }, /expires within/],
  ])('refuses and signs out a session for %s', async (_, patch, why) => {
    const { api, s } = setup();

    const real = api.signIn.getMockImplementation()!;

    api.signIn.mockImplementationOnce(async (nonce, sig) => ({
      ...(await real(nonce, sig)),
      ...patch,
    }));

    const write = vi.fn(async (b: string) => b);

    const err = await s.run(write).catch((x: unknown) => x);

    expect(err).toBeInstanceOf(SignInRefusedError);

    expect((err as Error).message).toMatch(why);

    expect(api.signOut).toHaveBeenCalledWith('bearer-1');

    expect(write).not.toHaveBeenCalled();

    expect(JSON.stringify(s)).toContain('"signedIn":false');

    expect(await s.run(write)).toBe('bearer-2');
  });

  it('never shows the bearer', async () => {
    const { s } = setup();

    await s.run(async (b) => b);

    expect(JSON.stringify(s)).not.toContain('bearer-1');

    expect(inspect(s)).not.toContain('bearer-1');

    expect(inspect(s, { showHidden: true, depth: 10 })).not.toContain('bearer-1');
  });

  it('cuts a bearer the server echoes from the surfaced error', async () => {
    const { s } = setup();

    const write = vi.fn(async (b: string) => {
      throw unauth(`token ${b} is not valid`);
    });

    const err = await s.run(write).catch((x: unknown) => x);

    expect(err).toBeInstanceOf(ApiError);

    expect(String((err as Error).message)).not.toMatch(/bearer-[12]/);

    expect(String((err as Error).stack)).not.toMatch(/bearer-[12]/);

    expect(JSON.stringify(err)).not.toMatch(/bearer-[12]/);

    expect(inspect(err)).not.toMatch(/bearer-[12]/);

    expect((err as ApiError).message).toContain('[redacted]');
  });

  it('cuts the bearer from a typed refusal too', async () => {
    const { s } = setup();

    const err = await s
      .run(async (b) => {
        throw new ApiError(403, 'paused', `paused for ${b}`, null);
      })
      .catch((x: unknown) => x);

    expect(err).toBeInstanceOf(PausedError);

    expect((err as Error).message).not.toContain('bearer-1');
  });

  it('cuts the bearer from an error cause', async () => {
    const { s } = setup();

    const err = await s
      .run(async (b) => {
        throw new Error('write failed', { cause: new Error(`upstream saw ${b}`) });
      })
      .catch((x: unknown) => x);

    expect(String((err as Error).cause)).not.toContain('bearer-1');

    expect(inspect(err, { depth: 10 })).not.toContain('bearer-1');

    expect(String((err as Error).cause)).toContain('[redacted]');
  });

  it('replaces an error it cannot redact with a MercurifiError that has a code', async () => {
    const { s } = setup();

    const err = await s
      .run(async (b) => {
        throw Object.freeze(new Error(`write failed for ${b}`));
      })
      .catch((x: unknown) => x);

    expect(err).toBeInstanceOf(MercurifiError);

    expect((err as MercurifiError).code).toBe('MERCURIFI_ERROR');

    expect(inspect(err, { depth: 10 })).not.toContain('bearer-1');
  });

  it('signs out after an in-flight sign-in completes', async () => {
    const { api, s } = setup();

    let release!: () => void;

    const held = new Promise<void>((r) => {
      release = r;
    });

    const real = api.signIn.getMockImplementation()!;

    api.signIn.mockImplementationOnce(async (nonce, sig) => {
      await held;
      return real(nonce, sig);
    });

    const signingIn = s.bearer();

    await vi.waitFor(() => expect(api.signIn).toHaveBeenCalledTimes(1));

    const out = s.signOut();

    release();

    await out;

    expect(await signingIn).toBe('bearer-1');

    expect(api.signOut).toHaveBeenCalledWith('bearer-1');

    expect(await s.bearer()).toBe('bearer-2');
  });

  it('signs out once and forgets the bearer', async () => {
    const { api, s } = setup();

    await s.bearer();

    await s.signOut();

    expect(api.signOut).toHaveBeenCalledWith('bearer-1');

    await s.signOut();

    expect(api.signOut).toHaveBeenCalledTimes(1);

    expect(await s.bearer()).toBe('bearer-2');
  });
});

describe('socialError', () => {
  const cases = [
    ['signal_required', SignalRequiredError, 403],
    ['body_rejected', BodyRejectedError, 400],
    ['rate_limited', RateLimitedError, 429],
    ['posting_off', PostingOffError, 403],
    ['not_agent', NotAgentError, 403],
    ['agent_expired', AgentExpiredError, 403],
    ['not_owner', NotOwnerSocialError, 403],
    ['paused', PausedError, 403],
    ['chain_unavailable', ChainUnavailableError, 503],
    ['own_note', OwnNoteError, 403],
  ] as const;

  it.each(cases)('maps %s to its class', (code, C, status) => {
    const out = socialError(new ApiError(status, code, 'm', 7));

    expect(out).toBeInstanceOf(C);

    expect(out).toBeInstanceOf(ApiError);

    expect(out).toMatchObject({
      status,
      apiCode: code,
      message: 'm',
      retryAfterSeconds: 7,
      code: 'API_ERROR',
      name: C.name,
    });
  });

  it('leaves forbidden, unknown codes and other errors unchanged', () => {
    const forbidden = new ApiError(403, 'forbidden', 'an owner session can only...', null);

    expect(socialError(forbidden)).toBe(forbidden);

    const proto = new ApiError(400, 'constructor', 'x', null);

    expect(socialError(proto)).toBe(proto);

    const other = new Error('x');

    expect(socialError(other)).toBe(other);
  });
});
