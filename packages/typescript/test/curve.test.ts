import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buyImpactBps,
  isSellOutQuote,
  mayGraduateBuy,
  sellImpactBps,
  quoteFreshBuy,
  type LaunchConfigValue,
} from '../src/curve.js';

const v = JSON.parse(
  readFileSync(new URL('../../../fixtures/vectors/curve.json', import.meta.url), 'utf8'),
);
const c = v.config;
const config: LaunchConfigValue = {
  virtualUsdc: BigInt(c.virtualUsdc),
  virtualTokens: BigInt(c.virtualTokens),
  curveSupply: BigInt(c.curveSupply),
  poolSupply: BigInt(c.poolSupply),
  launchFee: BigInt(c.launchFee),
  maxInitialBuyTokens: BigInt(c.maxInitialBuyTokens),
  tradeFeeBps: c.tradeFeeBps,
  creatorShareBps: c.creatorShareBps,
  referrerShareBps: c.referrerShareBps,
  snipeStartBps: c.snipeStartBps,
  snipeBlocks: c.snipeBlocks,
};

describe('curve maths', () => {
  it.each(v.freshBuy as never[])(
    'fresh buy %j',
    (x: { valueWei: string; tokensOut: string; usdcUsed: string; fee: string }) =>
      expect(quoteFreshBuy(config, BigInt(x.valueWei))).toEqual({
        tokensOut: BigInt(x.tokensOut),
        usdcUsed: BigInt(x.usdcUsed),
        fee: BigInt(x.fee),
      }),
  );
  it.each(v.sellOut as never[])(
    'sell-out %j',
    (x: {
      usdcIn: string;
      usdcUsed: string;
      tokensOut: string;
      tokensRemaining: string;
      out: boolean;
    }) =>
      expect(
        isSellOutQuote({
          usdcIn: BigInt(x.usdcIn),
          usdcUsed: BigInt(x.usdcUsed),
          tokensOut: BigInt(x.tokensOut),
          tokensRemaining: BigInt(x.tokensRemaining),
        }),
      ).toBe(x.out),
  );

  it('mirrors AgentPolicyLib impact rounding (both against the trade)', () => {
    // avg = ceil(24.75e18 * 1e18 / 1e24) = 24.75e12; impact = ceil(14.75e12 * 1e4 / 1e13) = 14750
    expect(buyImpactBps(24_750_000_000_000_000_000n, 10n ** 24n, 10n ** 13n)).toBe(14_750n);
    expect(buyImpactBps(24_750_000_000_000_000_000n, 10n ** 24n, 25_000_000_000_000n)).toBe(0n);
    // avg = floor(10e18 * 1e18 / 5e18) = 2e18; price 4e18 -> impact 5000
    expect(sellImpactBps(10n * 10n ** 18n, 5n * 10n ** 18n, 4n * 10n ** 18n)).toBe(5_000n);
    expect(sellImpactBps(10n * 10n ** 18n, 5n * 10n ** 18n, 2n * 10n ** 18n)).toBe(0n);
    // ceil: a 1 wei shortfall still costs one basis point
    expect(sellImpactBps(10n * 10n ** 18n - 1n, 5n * 10n ** 18n, 2n * 10n ** 18n)).toBe(1n);
  });
});

describe('mayGraduateBuy', () => {
  const base = { usdcIn: 100n, usdcUsed: 100n, tokensOut: 10n, tokensRemaining: 100n };
  it('adds the half-of-remaining rule to the exact sell-out test', () => {
    expect(mayGraduateBuy(base)).toBe(false);
    expect(mayGraduateBuy({ ...base, tokensOut: 49n })).toBe(false);
    expect(mayGraduateBuy({ ...base, tokensOut: 50n })).toBe(true);
    expect(mayGraduateBuy({ ...base, tokensOut: 100n })).toBe(true);
    expect(mayGraduateBuy({ ...base, usdcUsed: 99n })).toBe(true);
  });
});

describe('shared impact and graduation vectors', () => {
  it.each(v.impact.buy as never[])(
    'buy impact %j',
    (x: { net: string; tokensOut: string; price: string; bps: string }) =>
      expect(buyImpactBps(BigInt(x.net), BigInt(x.tokensOut), BigInt(x.price))).toBe(BigInt(x.bps)),
  );
  it.each(v.impact.sell as never[])(
    'sell impact %j',
    (x: { gross: string; tokensIn: string; price: string; bps: string }) =>
      expect(sellImpactBps(BigInt(x.gross), BigInt(x.tokensIn), BigInt(x.price))).toBe(
        BigInt(x.bps),
      ),
  );
  it.each(v.mayGraduate as never[])(
    'may graduate %j',
    (x: {
      usdcIn: string;
      usdcUsed: string;
      tokensOut: string;
      tokensRemaining: string;
      may: boolean;
    }) =>
      expect(
        mayGraduateBuy({
          usdcIn: BigInt(x.usdcIn),
          usdcUsed: BigInt(x.usdcUsed),
          tokensOut: BigInt(x.tokensOut),
          tokensRemaining: BigInt(x.tokensRemaining),
        }),
      ).toBe(x.may),
  );
});
