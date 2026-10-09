import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { canonical, digestOf, SOURCES } from '../../../scripts/gen-abis.mjs';
import { ABI_DIGEST, agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';

const names = (abi: readonly { type: string; name?: string }[], type: string): string[] =>
  abi.filter((i) => i.type === type).map((i) => i.name ?? '');

describe('generated ABIs', () => {
  it('agree with the digest and with the Python copies', () => {
    expect(() => execFileSync('node', ['../../scripts/gen-abis.mjs', '--verify-digest'], { stdio: 'pipe' })).not.toThrow();
    expect(ABI_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(SOURCES).toHaveLength(11);
  });

  it('carry the account members the SDK relies on', () => {
    expect(names(agentAccountAbi, 'function')).toEqual(
      expect.arrayContaining(['buy', 'sell', 'launch', 'swapExactIn', 'claimFees', 'sweepToOwner', 'basis', 'withdraw', 'withdrawMany', 'REGISTRY']),
    );
    expect(names(agentAccountAbi, 'event')).toEqual(expect.arrayContaining(['AgentAction', 'AccountWithdrawn']));
    // Configuration lives in the registry, not on the account.
    expect(names(agentAccountAbi, 'function')).not.toContain('setPolicy');
  });

  it('carry the registry members the SDK relies on', () => {
    expect(names(agentPolicyRegistryAbi, 'function')).toEqual(
      expect.arrayContaining(['queued', 'epoch', 'headroom', 'usage', 'setPolicy', 'policyWrite', 'agentWrite', 'tokenWrite', 'delayWrite', 'acceptOwnership']),
    );
    expect(names(agentPolicyRegistryAbi, 'event')).toEqual(expect.arrayContaining(['AgentQueued', 'PolicyQueued', 'AccountOwnerChanged']));
    expect(names(agentAccountFactoryAbi, 'function')).toEqual(expect.arrayContaining(['createAccount', 'predictAccount', 'isAccount', 'ceilings', 'registry']));
  });

  it('canonicalises key order before hashing', () => {
    expect(canonical([{ b: 1, a: [{ d: 2, c: 3 }] }])).toBe('[{"a":[{"c":3,"d":2}],"b":1}]');
    expect(digestOf([['x', []], ['a', []]])).toBe(digestOf([['a', []], ['x', []]]));
  });
});
