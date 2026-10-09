import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PERMISSIONS, decodePermissions, encodePermissions } from '../src/permissions.js';

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
});
