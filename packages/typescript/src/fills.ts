import { isAddressEqual, parseEventLogs, type Address, type Hex } from 'viem';

import { agentAccountAbi, launchFactoryAbi } from './abi/index.js';
import { MercurifiError } from './errors.js';
import { ACTIONS, type ActionName } from './permissions.js';
import { formatTokens, formatUsdc6 } from './units.js';

/** The final result of one agent action, read from the account's own AgentAction log. */
export interface Fill {
  action: ActionName;
  account: Address;
  agent: Address;
  token: Address;
  usdcSpent6: bigint;
  usdcReceived6: bigint;
  basisValue6: bigint;
  tokenDelta: bigint;
  tokensOut: bigint;
  tokensIn: bigint;
  usdcSpent: string;
  usdcReceived: string;
  tokens: string;
  periodId: bigint;
  txHash: Hex;
  block: bigint;
  gasUsed: bigint;
  gasCostWei: bigint;
  launched: { token: Address; curve: Address } | null;
}

export interface ReceiptLike {
  transactionHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

/** AgentAction is emitted by the account itself (not the registry); a sweep also emits AccountWithdrawn, which is ignored here. */
export const fillFromReceipt = (receipt: ReceiptLike, account: Address, launchFactory: Address): Fill => {
  const own = receipt.logs.filter((l) => isAddressEqual(l.address, account));
  const actions = parseEventLogs({ abi: agentAccountAbi, eventName: 'AgentAction', logs: own } as never) as unknown as {
    args: { agent: Address; action: number; token: Address; usdcSpent: bigint; usdcReceived: bigint; tokenDelta: bigint; basisValue: bigint; periodId: bigint };
  }[];
  if (actions.length !== 1) {
    throw new MercurifiError('FILL_NOT_FOUND', `Expected one AgentAction from ${account} in ${receipt.transactionHash}, found ${actions.length}.`);
  }
  const a = actions[0]!.args;
  const created = parseEventLogs({
    abi: launchFactoryAbi, eventName: 'TokenCreated', logs: receipt.logs.filter((l) => isAddressEqual(l.address, launchFactory)),
  } as never) as unknown as { args: { token: Address; curve: Address } }[];
  const delta = BigInt(a.tokenDelta);
  const abs = delta < 0n ? -delta : delta;
  return {
    action: ACTIONS[Number(a.action)] ?? 'buy',
    account, agent: a.agent, token: a.token,
    usdcSpent6: BigInt(a.usdcSpent), usdcReceived6: BigInt(a.usdcReceived), basisValue6: BigInt(a.basisValue),
    tokenDelta: delta, tokensOut: delta > 0n ? delta : 0n, tokensIn: delta < 0n ? -delta : 0n,
    usdcSpent: formatUsdc6(BigInt(a.usdcSpent)), usdcReceived: formatUsdc6(BigInt(a.usdcReceived)), tokens: formatTokens(abs),
    periodId: BigInt(a.periodId), txHash: receipt.transactionHash, block: receipt.blockNumber,
    gasUsed: receipt.gasUsed, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
    launched: created[0] === undefined ? null : { token: created[0].args.token, curve: created[0].args.curve },
  };
};
