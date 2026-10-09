import type { PublicClient } from 'viem';

import { InvalidInputError } from './errors.js';

/**
 * A deadline from the latest block's timestamp, so a skewed machine clock cannot push it outside the account's
 * `[now, now + maxDeadlineSeconds]` window (Arc timestamps are non-decreasing).
 */
export const chainDeadline = async (client: PublicClient, maxDeadlineSeconds: number, wanted: number): Promise<bigint> => {
  const window = Math.min(wanted, maxDeadlineSeconds);
  if (!Number.isInteger(window) || window < 1) throw new InvalidInputError('deadlineSeconds', 'the deadline window must be at least 1 second');
  const block = await client.getBlock({ blockTag: 'latest' });
  return block.timestamp + BigInt(window);
};
