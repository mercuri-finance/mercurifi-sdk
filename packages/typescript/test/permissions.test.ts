import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PERMISSIONS, decodePermissions, encodePermissions } from '../src/permissions.js';

import { readFileSync } from 'node:fs';
const vec = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/policy.json', import.meta.url), 'utf8'));

describe('permissions', () => {
  it('never preselects sell', () => {
    expect(DEFAULT_AGENT_PERMISSIONS).not.toContain('sell');
    expect(encodePermissions(DEFAULT_AGENT_PERMISSIONS)).toBe(1 | 4 | 8 | 16);
  });
  it('round-trips and rejects unknown or empty sets', () => {
    expect(decodePermissions(63)).toEqual(['buy', 'sell', 'launch', 'swap', 'claim', 'sweep']);
    expect(() => encodePermissions([])).toThrow(/at least one/);
    expect(() => encodePermissions(['withdraw' as never])).toThrow(/unknown permission/);
    expect(() => decodePermissions(64)).toThrow(/unknown permission bits/);
  });
  it('rejects inherited property names', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(() => encodePermissions([name as never])).toThrow(/unknown permission/);
    }
  });
  it('rejects non-integer, negative and oversized bit sets', () => {
    for (const bits of [2 ** 32 + 1, Number.NaN, 1.5, -1, 64, Number.POSITIVE_INFINITY]) {
      expect(() => decodePermissions(bits)).toThrow(/unknown permission bits/);
    }
    expect(decodePermissions(0)).toEqual([]);
  });
  it('matches the shared decode vectors', () => {
    for (const c of vec.permissionsDecode as { in: number; out?: string[]; error?: string }[]) {
      if (c.error) expect(() => decodePermissions(c.in)).toThrow();
      else expect(decodePermissions(c.in)).toEqual(c.out);
    }
  });
});
