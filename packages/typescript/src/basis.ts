import type { Address, PublicClient } from 'viem';

import { readAccount } from './reads.js';
import { SCALE } from './units.js';

/** Scale of `Basis.highWater`: usdc6 per token unit × 1e36 (AgentTypes.sol HIGH_WATER_SCALE). */
export const HIGH_WATER_SCALE = 10n ** 36n;

/** The account's recorded cost basis in one token (`AgentAccount.basis(token)`). */
export interface Basis {
  /** USDC paid for `tokens`, usdc6. */
  costUsdc6: bigint;
  /** Tokens bought and still held, 18-decimal units. */
  tokens: bigint;
  /** Highest average cost the open position has had, usdc6 per token unit × 1e36 (stored rounded up); 0 once closed. */
  highWater: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export const readBasis = async (client: PublicClient, account: Address, token: Address): Promise<Basis> => {
  const [costUsdc, tokens, highWater] = await readAccount<readonly [bigint, bigint, bigint]>(client, account, 'basis', [token]);
  return { costUsdc6: BigInt(costUsdc), tokens: BigInt(tokens), highWater: BigInt(highWater) };
};

/**
 * Cost-basis value of the recorded part of a sell, exactly as `AgentAccount._recordedValue`: the higher of the average
 * cost rounded up and the high-water cost rounded down, so a crash buy cannot stretch the sell cap and a single lot sold
 * whole is charged exactly what it cost.
 */
export const recordedSellValue6 = (b: Basis, tokensIn: bigint): { recorded: bigint; value6: bigint } => {
  const recorded = tokensIn < b.tokens ? tokensIn : b.tokens;
  if (recorded <= 0n) return { recorded: 0n, value6: 0n };
  const average = ceilDiv(recorded * b.costUsdc6, b.tokens);
  const highWater = (recorded * b.highWater) / HIGH_WATER_SCALE;
  return { recorded, value6: average > highWater ? average : highWater };
};

/** A curve sell's value: the recorded part plus the unrecorded excess at its curve quote, rounded up to usdc6. */
export const curveSellValue6 = (b: Basis, tokensIn: bigint, excessOutWei: bigint): bigint =>
  recordedSellValue6(b, tokensIn).value6 + ceilDiv(excessOutWei, SCALE);

/**
 * A pool sell's value: the recorded part plus the excess's share of the quoted output (usdc6), rounded up. Advisory: the
 * contract values the excess at the output it measures after the swap.
 */
export const poolSellValue6 = (b: Basis, amountIn: bigint, quotedOut6: bigint): bigint => {
  const { recorded, value6 } = recordedSellValue6(b, amountIn);
  if (amountIn <= recorded) return value6;
  return value6 + ceilDiv(quotedOut6 * (amountIn - recorded), amountIn);
};
