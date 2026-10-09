const BPS = 10_000n;
const mulDivUp = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

/** BondingCurve.Phase, in declaration order. */
export const PHASE = Object.freeze({ Trading: 0, GraduationPending: 1, Graduated: 2 });

/** LaunchFactory.config() (LaunchTypes.sol). Native amounts are 18-decimal wei. */
export interface LaunchConfigValue {
  virtualUsdc: bigint;
  virtualTokens: bigint;
  curveSupply: bigint;
  poolSupply: bigint;
  launchFee: bigint;
  maxInitialBuyTokens: bigint;
  tradeFeeBps: number;
  creatorShareBps: number;
  referrerShareBps: number;
  snipeStartBps: number;
  snipeBlocks: number;
}

/** True when a quoteBuy result is the buy that completes the curve (and so graduates inline). Same rule as the web app. */
export const isSellOutQuote = (i: { usdcIn: bigint; usdcUsed: bigint; tokensOut: bigint; tokensRemaining: bigint }): boolean =>
  i.usdcUsed < i.usdcIn || i.tokensOut >= i.tokensRemaining;

/**
 * BondingCurve._quoteBuy on a fresh curve with no tax: the launch's initial buy, which runs tax-exempt in the launch
 * block before any other trade, so the result is exact (the config hash pins the parameters).
 */
export const quoteFreshBuy = (config: LaunchConfigValue, valueWei: bigint): { tokensOut: bigint; usdcUsed: bigint; fee: bigint } => {
  const feeBps = BigInt(config.tradeFeeBps);
  let fee = (valueWei * feeBps) / BPS;
  const net = valueWei - fee;
  const x = config.virtualUsdc;
  const y = config.virtualTokens;
  const remaining = config.curveSupply;
  let usdcUsed = valueWei;
  let tokensOut = (net * y) / (x + net);
  if (tokensOut >= remaining) {
    tokensOut = remaining;
    const cost = mulDivUp(x, remaining, y - remaining);
    const gross = mulDivUp(cost, BPS * BPS, (BPS - feeBps) * BPS);
    if (gross < valueWei) {
      usdcUsed = gross;
      fee = (gross * feeBps) / BPS;
    }
  }
  return { tokensOut, usdcUsed, fee };
};

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;

/**
 * AgentPolicyLib.buyImpactBps: `avg = ceil(net × 1e18 / tokensOut)`, impact `ceil((avg − price) × 10,000 / price)`, zero when
 * `avg` is not above `price`. `net` is the quote's used amount minus fee and tax. Both roundings are against the trade.
 */
export const buyImpactBps = (net: bigint, tokensOut: bigint, price: bigint): bigint => {
  const avg = mulDivUp(net, 10n ** 18n, tokensOut);
  return avg > price ? mulDivUp(avg - price, BPS, price) : 0n;
};

/** AgentPolicyLib.sellImpactBps: `avg = floor(gross × 1e18 / tokensIn)`, impact `ceil((price − avg) × 10,000 / price)`, zero when `avg` is not below `price`. */
export const sellImpactBps = (gross: bigint, tokensIn: bigint, price: bigint): bigint => {
  const avg = mulDiv(gross, 10n ** 18n, tokensIn);
  return price > avg ? mulDivUp(price - avg, BPS, price) : 0n;
};
