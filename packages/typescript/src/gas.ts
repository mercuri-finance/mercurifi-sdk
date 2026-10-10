import { GasPriceTooHighError, InvalidInputError } from './errors.js';

/** Arc drops transactions whose maxFeePerGas is under 20 gwei, without a receipt (spec Q6). */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n;
/**
 * A buy that completes a curve graduates inline and needs ≥1M gas left at graduation (spec Q19, §4.11). Through the
 * account the contracts measure ≥ ~1.3M call gas (contracts `AgentGas.t.sol`); the SDK keeps 1.8M as its floor for margin.
 */
export const GRADUATION_GAS_LIMIT = 1_800_000n;
/** Default ceiling on the priority fee the SDK will pay: a node quoting a runaway tip cannot drain the account's gas. */
export const MAX_PRIORITY_FEE_PER_GAS = 100_000_000_000n;
const MARGIN_PERCENT = 120n;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * EIP-1559 fees with headroom for one base-fee doubling, never under Arc's floor, priority never above max.
 *
 * @throws {GasPriceTooHighError} when `baseFee + priority` exceeds `cap`
 * @throws {InvalidInputError} when `cap` is under the 20 gwei floor
 */
export const feesWithFloor = (baseFee: bigint, priority: bigint, cap?: bigint): Fees => {
  let maxFeePerGas = baseFee * 2n + priority;
  if (maxFeePerGas < MIN_MAX_FEE_PER_GAS) maxFeePerGas = MIN_MAX_FEE_PER_GAS;
  let maxPriorityFeePerGas = priority > maxFeePerGas ? maxFeePerGas : priority;
  if (cap !== undefined) {
    if (cap < MIN_MAX_FEE_PER_GAS)
      throw new InvalidInputError(
        'maxFeePerGasCap',
        'maxFeePerGasCap is below the Arc floor of 20 gwei',
      );
    const required = baseFee + maxPriorityFeePerGas;
    if (required > cap) throw new GasPriceTooHighError(required, cap);
    if (maxFeePerGas > cap) maxFeePerGas = cap;
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
};

/** Estimate plus 20%; a buy that may complete the curve gets at least GRADUATION_GAS_LIMIT. */
export const gasLimitFor = (estimate: bigint, mayGraduate: boolean): bigint => {
  const withMargin = (estimate * MARGIN_PERCENT) / 100n;
  return mayGraduate && withMargin < GRADUATION_GAS_LIMIT ? GRADUATION_GAS_LIMIT : withMargin;
};
