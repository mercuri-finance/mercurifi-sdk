import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SignInRefusedError } from '../src/errors.js';
import { buildSignInMessage, checkSignInMessage } from '../src/signin.js';

interface Vector {
  kind: 'agent' | 'owner';
  account: `0x${string}`;
  signer: `0x${string}`;
  chainId: number;
  service: 'launch' | 'trade';
  nonce: string;
  issued: string;
  expires: string;
  message: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../fixtures/vectors/agentsignin.json', import.meta.url), 'utf8'),
) as Vector[];

describe('sign-in message', () => {
  it('matches the shared vectors byte for byte', () => {
    for (const v of vectors) {
      const built = buildSignInMessage(v, v.nonce, new Date(v.issued), new Date(v.expires));

      expect(built).toBe(v.message);
    }
  });

  it('accepts the server text and a clock up to two minutes off', () => {
    const v = vectors[0]!;

    const issued = Date.parse(v.issued);

    checkSignInMessage(v, v.nonce, v.message, issued);

    checkSignInMessage(v, v.nonce, v.message, issued + 90_000);

    checkSignInMessage(v, v.nonce, v.message, issued - 90_000);
  });

  it('refuses text it did not build, and a clock far off', () => {
    const v = vectors[0]!;

    const issued = Date.parse(v.issued);

    const refused = (message: string, now = issued): SignInRefusedError => {
      try {
        checkSignInMessage(v, v.nonce, message, now);
      } catch (e) {
        expect(e).toBeInstanceOf(SignInRefusedError);
        return e as SignInRefusedError;
      }
      throw new Error('accepted');
    };

    expect(refused(v.message.replace('launch', 'trade')).reason).toBe('text');

    expect(refused(`${v.message}\nTransfer: everything`).reason).toBe('text');

    expect(refused(v.message.slice(0, v.message.lastIndexOf('\n'))).reason).toBe('text');

    expect(refused(v.message.replace(v.nonce, 'f'.repeat(32))).reason).toBe('text');

    const far = refused(v.message, issued + 600_000);

    expect(far.reason).toBe('clock');
    expect(far.message).toContain('Issued is more than two minutes');
  });

  it('names which bound of the window failed', () => {
    const v = vectors[0]!;

    const issued = Date.parse(v.issued);

    const refused = (message: string, now = issued): SignInRefusedError => {
      try {
        checkSignInMessage(v, v.nonce, message, now);
      } catch (e) {
        return e as SignInRefusedError;
      }
      throw new Error('accepted');
    };

    const long = refused(v.message.replace('12:05:00Z', '13:00:00Z'));

    expect(long.reason).toBe('window');
    expect(long.message).toContain('longer than five minutes');

    const flat = refused(v.message.replace('12:05:00Z', '12:00:00Z'));

    expect(flat.reason).toBe('window');
    expect(flat.message).toContain('too short or not positive');

    const backwards = refused(v.message.replace('12:05:00Z', '11:59:00Z'));

    expect(backwards.reason).toBe('window');
    expect(backwards.message).toContain('too short or not positive');

    const stale = refused(v.message, issued + 5 * 60_000 + 130_000);

    expect(stale.reason).toBe('clock');
    expect(stale.message).toContain('Issued is more than two minutes');
  });

  it('accepts a short window when the local clock runs 90 s fast', () => {
    const v = vectors[0]!;

    const issued = Date.parse(v.issued);

    const short = v.message.replace('12:05:00Z', '12:00:30Z');

    checkSignInMessage(v, v.nonce, short, issued + 90_000);
  });
});
