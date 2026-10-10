import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { curveSellValue6, poolSellValue6, recordedSellValue6, type Basis } from '../src/basis.js';

const v = JSON.parse(
  readFileSync(new URL('../../../fixtures/vectors/basis.json', import.meta.url), 'utf8'),
);
const basisOf = (x: { costUsdc: string; tokens: string; highWater: string }): Basis => ({
  costUsdc6: BigInt(x.costUsdc),
  tokens: BigInt(x.tokens),
  highWater: BigInt(x.highWater),
});

describe('sell valuation (AgentAccount._recordedValue)', () => {
  it.each(v.recorded as never[])(
    '$name',
    (x: {
      costUsdc: string;
      tokens: string;
      highWater: string;
      tokensIn: string;
      recorded: string;
      value6: string;
    }) =>
      expect(recordedSellValue6(basisOf(x), BigInt(x.tokensIn))).toEqual({
        recorded: BigInt(x.recorded),
        value6: BigInt(x.value6),
      }),
  );
  it.each(v.curveExcess as never[])(
    'curve: $name',
    (x: {
      costUsdc: string;
      tokens: string;
      highWater: string;
      tokensIn: string;
      excessOutWei: string;
      value6: string;
    }) =>
      expect(curveSellValue6(basisOf(x), BigInt(x.tokensIn), BigInt(x.excessOutWei))).toBe(
        BigInt(x.value6),
      ),
  );
  it.each(v.poolExcess as never[])(
    'pool: $name',
    (x: {
      costUsdc: string;
      tokens: string;
      highWater: string;
      amountIn: string;
      quotedOutWei: string;
      value6: string;
    }) =>
      expect(poolSellValue6(basisOf(x), BigInt(x.amountIn), BigInt(x.quotedOutWei))).toBe(
        BigInt(x.value6),
      ),
  );
});
