import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../src/errors.js';
import {
  applySlippageFloor, formatUsdc6, parseTokens, parseUsdc, resolveTokenAmount, resolveUsdc6,
  slippageToBps, weiToUsdc6Ceil, weiToUsdc6Floor,
} from '../src/units.js';

const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/units.json', import.meta.url), 'utf8'));

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as InvalidInputError).code).toBe(code); return; }
  throw new Error('expected an error');
};

describe('units vectors', () => {
  it.each<{ in: string; out?: string; error?: string }>(v.parseUsdc)('parseUsdc %j', (c) => {
    if (c.error) expectCode(() => parseUsdc(c.in), c.error);
    else expect(parseUsdc(c.in)).toBe(BigInt(c.out!));
  });
  it.each<{ in: string; out: string }>(v.parseTokens)('parseTokens %j', (c) => expect(parseTokens(c.in)).toBe(BigInt(c.out)));
  it.each<{ in: string; out: string }>(v.formatUsdc6)('formatUsdc6 %j', (c) => expect(formatUsdc6(BigInt(c.in))).toBe(c.out));
  it.each<{ in: number; out?: number; error?: string }>(v.slippageToBps)('slippageToBps %j', (c) => {
    if (c.error) expectCode(() => slippageToBps(c.in), c.error);
    else expect(slippageToBps(c.in)).toBe(c.out);
  });
  it.each<{ amount: string; bps: number; out: string }>(v.applySlippageFloor)('applySlippageFloor %j', (c) =>
    expect(applySlippageFloor(BigInt(c.amount), c.bps)).toBe(BigInt(c.out)));
  it.each<{ wei: string; floor: string; ceil: string }>(v.weiToUsdc6)('wei→usdc6 %j', (c) => {
    expect(weiToUsdc6Floor(BigInt(c.wei))).toBe(BigInt(c.floor));
    expect(weiToUsdc6Ceil(BigInt(c.wei))).toBe(BigInt(c.ceil));
  });
});

describe('amount forms', () => {
  it('rejects a number in a human field (Review Focus 1)', () => {
    const err = (() => { try { resolveUsdc6({ usdc: 25 as unknown as string }); } catch (e) { return e as InvalidInputError; } return null; })();
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err!.message).toContain('decimal string');
    expect(err!.message).toContain('usdc6');
  });
  it('rejects a non-bigint base-unit field', () => {
    expect(() => resolveUsdc6({ usdc6: 25 as unknown as bigint })).toThrow(/usdc6 must be a bigint/);
  });
  it('requires exactly one of usdc and usdc6', () => {
    expect(() => resolveUsdc6({})).toThrow(/exactly one/);
    expect(() => resolveUsdc6({ usdc: '1', usdc6: 1n })).toThrow(/exactly one/);
    expect(resolveUsdc6({ usdc6: 7n })).toBe(7n);
  });
  it('resolves token amounts including all', () => {
    expect(resolveTokenAmount({ amount: 'all' })).toBe('all');
    expect(resolveTokenAmount({ amount: '1' })).toBe(10n ** 18n);
    expect(resolveTokenAmount({ amountWei: 5n })).toBe(5n);
  });
});
