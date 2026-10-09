import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { feesWithFloor, gasLimitFor, GRADUATION_GAS_LIMIT, MIN_MAX_FEE_PER_GAS } from '../src/gas.js';

interface Out { maxFeePerGas: string; maxPriorityFeePerGas: string }
const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/gas.json', import.meta.url), 'utf8')) as {
  fees: { baseFee: string; priority: string; out: Out }[];
  cappedFees: { baseFee: string; priority: string; cap: string; out?: Out; error?: string }[];
  gasLimit: { estimate: string; mayGraduate: boolean; out: string }[];
};
const big = (o: Out) => ({ maxFeePerGas: BigInt(o.maxFeePerGas), maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas) });

describe('gas policy', () => {
  it('keeps the pinned floors', () => {
    expect(MIN_MAX_FEE_PER_GAS).toBe(20_000_000_000n);
    expect(GRADUATION_GAS_LIMIT).toBe(1_800_000n);
  });
  it.each(v.fees)('fees %j', (c) =>
    expect(feesWithFloor(BigInt(c.baseFee), BigInt(c.priority))).toEqual(big(c.out)));
  it.each(v.cappedFees)('capped %j', (c) => {
    const run = () => feesWithFloor(BigInt(c.baseFee), BigInt(c.priority), BigInt(c.cap));
    if (c.error) expect(run).toThrow(expect.objectContaining({ code: c.error }));
    else expect(run()).toEqual(big(c.out!));
  });
  it.each(v.gasLimit)('gasLimit %j', (c) =>
    expect(gasLimitFor(BigInt(c.estimate), c.mayGraduate)).toBe(BigInt(c.out)));
});
