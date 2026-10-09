import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, fieldDirection, mergePolicy, previewPolicyChange, validatePolicy, type ChainPolicy, type PolicyField } from '../src/policy.js';

const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/policy.json', import.meta.url), 'utf8'));
const CEILINGS: ChainPolicy = {
  maxTradeUsdc: 1_000_000_000n, periodSpendCap: 10_000_000_000n, perTokenPeriodCap: 2_000_000_000n, periodSellCap: 10_000_000_000n,
  maxActionsPerPeriod: 5_000, launchesPerPeriod: 20, maxPriceImpactBps: 2_000, maxSnipeBps: 9_900,
  minTokenAgeBlocks: 0, maxDeadlineSeconds: 600, allowlistOnly: false,
};

const asValue = (field: string, raw: unknown) => (typeof DEFAULT_POLICY[field as PolicyField] === 'bigint' ? BigInt(raw as string) : raw);

describe('policy', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_POLICY).toEqual({
      maxTradeUsdc: 100_000_000n, periodSpendCap: 500_000_000n, perTokenPeriodCap: 100_000_000n, periodSellCap: 500_000_000n,
      maxActionsPerPeriod: 500, launchesPerPeriod: 3, maxPriceImpactBps: 300, maxSnipeBps: 0,
      minTokenAgeBlocks: 0, maxDeadlineSeconds: 120, allowlistOnly: false,
    });
  });
  it.each<{ field: PolicyField; current: unknown; next: unknown; out: string }>(v.direction)('direction %j', (c) => {
    const current = { ...DEFAULT_POLICY, [c.field]: asValue(c.field, c.current) };
    const next = { ...DEFAULT_POLICY, [c.field]: asValue(c.field, c.next) };
    expect(fieldDirection(c.field, current, next)).toBe(c.out);
  });
  it('merges human input and validates against ceilings', () => {
    const p = mergePolicy(DEFAULT_POLICY, { maxTradeUsdc: '250', maxDeadlineSeconds: 60 });
    expect(p.maxTradeUsdc).toBe(250_000_000n);
    expect(() => validatePolicy(p, CEILINGS)).not.toThrow();
    expect(() => validatePolicy(mergePolicy(DEFAULT_POLICY, { maxTradeUsdc: '1000.000001' }), CEILINGS)).toThrow(/maxTradeUsdc.*beta ceiling/);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, maxDeadlineSeconds: 0 })).toThrow(/maxDeadlineSeconds/);
    expect(() => mergePolicy(DEFAULT_POLICY, { launchesPerPeriod: 1.5 })).toThrow(/launchesPerPeriod/);
    expect(() => mergePolicy(DEFAULT_POLICY, { maxPriceImpactBps: 70_000 })).toThrow(/maxPriceImpactBps/);
  });
  it('previews a mixed change: tighter fields now, wider fields queued', () => {
    const next = { ...DEFAULT_POLICY, maxTradeUsdc: 50_000_000n, periodSpendCap: 900_000_000n };
    const pv = previewPolicyChange(DEFAULT_POLICY, next);
    expect(pv.outcome).toBe('mixed');
    expect(pv.immediate).toEqual(['maxTradeUsdc']);
    expect(pv.queued).toEqual(['periodSpendCap']);
    expect(pv.immediatePolicy.maxTradeUsdc).toBe(50_000_000n);
    expect(pv.immediatePolicy.periodSpendCap).toBe(500_000_000n);
    expect(pv.changes.find((c) => c.field === 'periodSpendCap')).toEqual({ field: 'periodSpendCap', current: '500', next: '900', direction: 'widen' });
    expect(previewPolicyChange(DEFAULT_POLICY, DEFAULT_POLICY).outcome).toBe('none');
  });
});
