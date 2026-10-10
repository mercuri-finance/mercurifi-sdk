import { InvalidInputError } from './errors.js';

export const USDC_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;
/** Native USDC wei per usdc6 unit (18 − 6 decimals). */
export const SCALE = 10n ** 12n;
/** Largest accepted slippage fraction (exclusive). A larger value is almost always a percent typed as a fraction. */
export const MAX_SLIPPAGE = 0.5;

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
/** ASCII whitespace only, the set Python's units.py strips; Unicode spaces and U+FEFF are refused, not trimmed. */
const ASCII_EDGE_WHITESPACE = /^[ \t\n\r]+|[ \t\n\r]+$/g;

const MAX_DECIMAL_TEXT = 80;

/**
 * Parses a human decimal string into base units.
 *
 * @param value a decimal string such as "25" or "0.5"; numbers are refused because they lose precision
 * @param decimals base-unit decimals of the asset
 * @param field the caller's field name, used in the error
 * @param baseUnitHint the base-unit alternative named in the error (default `<field>6`)
 * @returns the amount in base units
 * @throws {InvalidInputError} for anything that is not a plain non-negative decimal string with at most `decimals` places
 */
export const parseDecimal = (
  value: unknown,
  decimals: number,
  field: string,
  baseUnitHint = `${field}6`,
): bigint => {
  if (typeof value !== 'string') {
    throw new InvalidInputError(
      field,
      `${field} must be a decimal string such as "25" or "0.5" (got ${typeof value}). For base units use ${baseUnitHint} with a bigint.`,
    );
  }
  const text = value.replace(ASCII_EDGE_WHITESPACE, '');
  // Same bound as Python (units._MAX_TEXT): no real amount needs more, and BigInt work stays small.
  if (text.length > MAX_DECIMAL_TEXT) throw new InvalidInputError(field, `${field} is too long`);
  if (!DECIMAL.test(text))
    throw new InvalidInputError(
      field,
      `${field} must be a plain decimal string such as "25" or "0.5"`,
    );
  const [whole = '0', frac = ''] = text.split('.');
  if (frac.length > decimals)
    throw new InvalidInputError(field, `${field} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
};

/** Formats base units as a decimal string without trailing zeros. */
export const formatDecimal = (value: bigint, decimals: number): string => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

export const parseUsdc = (value: unknown, field = 'usdc'): bigint =>
  parseDecimal(value, USDC_DECIMALS, field);
export const formatUsdc6 = (value: bigint): string => formatDecimal(value, USDC_DECIMALS);
export const parseTokens = (value: unknown, field = 'amount'): bigint =>
  parseDecimal(value, TOKEN_DECIMALS, field, 'amountWei');
export const formatTokens = (value: bigint): string => formatDecimal(value, TOKEN_DECIMALS);

/** usdc6 → native wei; exact. */
export const usdc6ToWei = (usdc6: bigint): bigint => usdc6 * SCALE;
/** native wei → usdc6, rounded down (the rule for USDC received). */
export const weiToUsdc6Floor = (wei: bigint): bigint => wei / SCALE;
/** native wei → usdc6, rounded up (the rule for USDC spent). */
export const weiToUsdc6Ceil = (wei: bigint): bigint => (wei + SCALE - 1n) / SCALE;

/**
 * Slippage as a fraction (0.02 = 2%) to whole basis points.
 *
 * @throws {InvalidInputError} outside [0, 0.5) or not a whole number of basis points
 */
export const slippageToBps = (slippage: unknown): number => {
  if (
    typeof slippage !== 'number' ||
    !Number.isFinite(slippage) ||
    slippage < 0 ||
    slippage >= MAX_SLIPPAGE
  ) {
    throw new InvalidInputError(
      'slippage',
      'slippage is a fraction: 0.02 means 2%. It must be at least 0 and below 0.5.',
    );
  }
  if (slippage === 0) return 0; // normalises -0
  const bps = Math.round(slippage * 10_000);
  if (Math.abs(bps - slippage * 10_000) > 1e-6)
    throw new InvalidInputError(
      'slippage',
      'slippage must be a whole number of basis points (steps of 0.0001)',
    );
  return bps;
};

/** The minimum acceptable output for a quote, rounded down, matching the web app. */
export const applySlippageFloor = (amount: bigint, bps: number): bigint => {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000)
    throw new InvalidInputError('slippage', 'bps must be an integer from 0 to 10000');
  return (amount * BigInt(10_000 - bps)) / 10_000n;
};

/** Exactly one of `usdc` (human string) or `usdc6` (bigint base units). */
export const resolveUsdc6 = (input: { usdc?: string; usdc6?: bigint }, field = 'usdc'): bigint => {
  const hasHuman = input.usdc !== undefined;
  const hasBase = input.usdc6 !== undefined;
  if (hasHuman === hasBase)
    throw new InvalidInputError(
      field,
      `pass exactly one of ${field} (decimal string) or ${field}6 (bigint)`,
    );
  if (hasBase) {
    if (typeof input.usdc6 !== 'bigint' || input.usdc6 < 0n)
      throw new InvalidInputError(
        `${field}6`,
        `${field}6 must be a bigint of base units (1 USDC = 1000000n)`,
      );
    return input.usdc6;
  }
  return parseUsdc(input.usdc, field);
};

/** Exactly one of `amount` (human string or 'all') or `amountWei` (bigint, 18 decimals). */
export const resolveTokenAmount = (input: {
  amount?: string;
  amountWei?: bigint;
}): bigint | 'all' => {
  const hasHuman = input.amount !== undefined;
  const hasBase = input.amountWei !== undefined;
  if (hasHuman === hasBase)
    throw new InvalidInputError(
      'amount',
      "pass exactly one of amount (decimal string or 'all') or amountWei (bigint)",
    );
  if (hasBase) {
    if (typeof input.amountWei !== 'bigint' || input.amountWei < 0n)
      throw new InvalidInputError(
        'amountWei',
        'amountWei must be a bigint of 18-decimal base units',
      );
    return input.amountWei;
  }
  return input.amount === 'all' ? 'all' : parseTokens(input.amount, 'amount');
};
