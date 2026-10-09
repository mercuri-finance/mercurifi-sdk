import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../src/errors.js';
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

describe('policy edge cases', () => {
  const U64 = (1n << 64n) - 1n;
  it('treats minTokenAgeBlocks ceiling as a floor, like checkCeilings', () => {
    const ceil = { ...CEILINGS, minTokenAgeBlocks: 5 };
    expect(() => validatePolicy({ ...DEFAULT_POLICY, minTokenAgeBlocks: 4 }, ceil)).toThrow(/minTokenAgeBlocks.*below the beta floor/);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, minTokenAgeBlocks: 5 }, ceil)).not.toThrow();
    expect(() => validatePolicy({ ...DEFAULT_POLICY, minTokenAgeBlocks: 900 }, ceil)).not.toThrow();
    expect(() => validatePolicy({ ...DEFAULT_POLICY, allowlistOnly: false }, { ...CEILINGS, allowlistOnly: true })).not.toThrow();
  });
  it('enforces integer widths at the boundary and one past it', () => {
    expect(mergePolicy(DEFAULT_POLICY, { maxTradeUsdc: '18446744073709.551615' }).maxTradeUsdc).toBe(U64);
    expect(() => mergePolicy(DEFAULT_POLICY, { maxTradeUsdc: '18446744073709.551616' })).toThrow(/maxTradeUsdc/);
    expect(mergePolicy(DEFAULT_POLICY, { launchesPerPeriod: 0xffff }).launchesPerPeriod).toBe(0xffff);
    expect(() => mergePolicy(DEFAULT_POLICY, { launchesPerPeriod: 0x10000 })).toThrow(/launchesPerPeriod/);
    expect(mergePolicy(DEFAULT_POLICY, { maxActionsPerPeriod: 0xffff_ffff }).maxActionsPerPeriod).toBe(0xffff_ffff);
    expect(() => mergePolicy(DEFAULT_POLICY, { maxActionsPerPeriod: 0x1_0000_0000 })).toThrow(/maxActionsPerPeriod/);
    expect(() => mergePolicy(DEFAULT_POLICY, { minTokenAgeBlocks: -1 })).toThrow(/minTokenAgeBlocks/);
  });
  it('validatePolicy applies the same width check to a hand-built policy', () => {
    expect(() => validatePolicy({ ...DEFAULT_POLICY, maxTradeUsdc: U64 + 1n })).toThrow(/maxTradeUsdc/);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, launchesPerPeriod: 0x10000 })).toThrow(/launchesPerPeriod/);
    expect(() => validatePolicy({ ...DEFAULT_POLICY, maxActionsPerPeriod: 1.5 })).toThrow(/maxActionsPerPeriod/);
  });
  it('reports shape errors in contract order: impact, snipe, deadline', () => {
    const bad = { ...DEFAULT_POLICY, maxPriceImpactBps: 10_001, maxSnipeBps: 10_001, maxDeadlineSeconds: 0 };
    expect(() => validatePolicy(bad)).toThrow(/maxPriceImpactBps/);
    expect(() => validatePolicy({ ...bad, maxPriceImpactBps: 0 })).toThrow(/maxSnipeBps/);
    expect(() => validatePolicy({ ...bad, maxPriceImpactBps: 0, maxSnipeBps: 0 })).toThrow(/maxDeadlineSeconds/);
  });
  it('throws a typed error on null or non-object input', () => {
    for (const bad of [null, 5, 'x', []]) {
      try { mergePolicy(DEFAULT_POLICY, bad as never); throw new Error('expected an error'); } catch (e) {
        expect(e).toBeInstanceOf(InvalidInputError);
      }
    }
  });
});
