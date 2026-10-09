import { encodeAbiParameters, isAddressEqual, type Address, type PublicClient } from 'viem';

import { graduationManagerAbi, v4QuoterAbi } from './abi/index.js';
import { MercurifiError } from './errors.js';
import type { NetworkBook } from './networks.js';

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export const UINT128_MAX = (1n << 128n) - 1n;

const pin = (blockNumber: bigint | undefined): { blockNumber?: bigint } => (blockNumber === undefined ? {} : { blockNumber });

/**
 * The graduated pool, derived exactly as the account derives it: the GraduationManager's key for the token, which
 * must go through LaunchHook and pair the token with USDC. Never supplied by a caller.
 */
export const readPoolKey = async (client: PublicClient, book: NetworkBook, token: Address, blockNumber?: bigint): Promise<PoolKey> => {
  const raw = (await client.readContract({
    address: book.launch.graduationManager, abi: graduationManagerAbi, functionName: 'poolKey', args: [token], ...pin(blockNumber),
  } as never)) as PoolKey;
  const key: PoolKey = { currency0: raw.currency0, currency1: raw.currency1, fee: Number(raw.fee), tickSpacing: Number(raw.tickSpacing), hooks: raw.hooks };
  const pair = (a: Address, b: Address) => isAddressEqual(key.currency0, a) && isAddressEqual(key.currency1, b);
  if (!isAddressEqual(key.hooks, book.launch.launchHook)) {
    throw new MercurifiError('POOL_KEY_MISMATCH', `The pool for ${token} is not hooked by LaunchHook; refusing to quote or trade it.`);
  }
  if (!pair(book.launch.usdc, token) && !pair(token, book.launch.usdc)) {
    throw new MercurifiError('POOL_KEY_MISMATCH', `The pool for ${token} does not pair the token with USDC; refusing to quote or trade it.`);
  }
  return key;
};

/**
 * V4Quoter exact-in quote with the same hookData the account sends (its own address). The pool's USDC side is the
 * 6-decimal ERC-20 view, so USDC amounts in and out are usdc6. Advisory: the minimum is enforced on-chain.
 */
export const quoteExactIn = async (
  client: PublicClient, book: NetworkBook, key: PoolKey, zeroForOne: boolean, amountIn: bigint, account: Address, blockNumber?: bigint,
): Promise<bigint> => {
  const { result } = await client.simulateContract({
    address: book.launch.v4Quoter, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: encodeAbiParameters([{ type: 'address' }], [account]) }],
    ...pin(blockNumber),
  } as never);
  return (result as unknown as readonly [bigint, bigint])[0];
};

const WAD = 10n ** 18n;

/**
 * Approximate price impact of a swap in basis points, from the quoter alone: the trade's execution price against a probe a
 * thousandth of its size gives k > 1, the execution-price ratio. For a constant-product pool the sqrt price moves with it, so
 * the price rises by k^2 - 1 (token1 -> token0 buys) or falls by 1 - 1/k^2 (`zeroForOne`), matching the direction rule of the
 * account's own measure. `null` when the probe gives no answer. Approximate and for a warning only: the preflight and the
 * account enforce the real limit.
 */
export const estimatePoolImpactBps = async (
  client: PublicClient, book: NetworkBook, key: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOut: bigint, account: Address, blockNumber?: bigint,
): Promise<bigint | null> => {
  const probeIn = amountIn / 1000n;
  if (probeIn === 0n || amountOut === 0n) return null;
  let probeOut: bigint;
  try {
    probeOut = await quoteExactIn(client, book, key, zeroForOne, probeIn, account, blockNumber);
  } catch {
    return null;
  }
  if (probeOut === 0n) return null;
  const k = (probeOut * amountIn * WAD) / (amountOut * probeIn);
  if (k <= WAD) return 0n;
  const k2 = (k * k) / WAD;
  return zeroForOne ? ((WAD - (WAD * WAD) / k2) * 10_000n) / WAD : ((k2 - WAD) * 10_000n) / WAD;
};
