import { decodeErrorResult, hexToString, isHex, size, slice, type Abi, type Hex } from 'viem';

import {
  agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi, bondingCurveAbi, feeManagerAbi, graduationManagerAbi,
  launchFactoryAbi, launchHookAbi, launchTokenAbi, universalRouterAbi, v4QuoterAbi,
} from './abi/index.js';
import { neutralizeUntrusted, preBound, truncateChars } from './redact.js';
import { MercurifiError } from './errors.js';
import { POLICY_FIELDS } from './policy.js';
import { formatUsdc6 } from './units.js';

export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
  /** First ABI, in the order below, that declares the error; identical selectors share one message. */
  source: string;
  selector: Hex;
  /** The full revert data as returned by the node ('0x' when none). */
  data: Hex;
  message: string;
}

/** The three agent ABIs first (merged: a trade can revert from the account or the registry), then Launch and Uniswap. */
const SOURCES: readonly (readonly [string, Abi])[] = [
  ['AgentAccount', agentAccountAbi], ['AgentPolicyRegistry', agentPolicyRegistryAbi], ['AgentAccountFactory', agentAccountFactoryAbi],
  ['BondingCurve', bondingCurveAbi], ['LaunchFactory', launchFactoryAbi], ['FeeManager', feeManagerAbi],
  ['GraduationManager', graduationManagerAbi], ['LaunchHook', launchHookAbi], ['LaunchToken', launchTokenAbi],
  ['UniversalRouter', universalRouterAbi], ['V4Quoter', v4QuoterAbi],
];

const usdc = (v: unknown): string => `${formatUsdc6(BigInt(v as bigint))} USDC`;
const field = (v: unknown): string => {
  if (typeof v === 'number' || typeof v === 'bigint') return POLICY_FIELDS[Number(v)] ?? `field #${String(v)}`;
  if (typeof v === 'string' && v.startsWith('0x')) return hexToString(v as Hex, { size: 32 }).replace(/\0+$/, '');
  return String(v);
};
const time = (v: unknown): string => new Date(Number(v) * 1000).toISOString();

/** Readable explanations, keyed by Solidity error name. Every AgentAccount, AgentPolicyRegistry and factory error must be present. */
export const ERROR_MESSAGES: Readonly<Record<string, (args: readonly unknown[]) => string>> = Object.freeze({
  // Registry — agent preamble (authorize)
  NotAgent: () => 'This key is not an active agent of the account: never added, revoked, or its addition is still queued.',
  AgentExpired: () => 'This agent key has expired. The owner can extend it (a queued change) or add a new key.',
  MissingPermission: () => 'This agent key does not have the permission this action needs.',
  Paused: () => 'Agent actions are paused, by the account owner or by the platform guardian pause (at most 72 h).',
  DeadlineOutOfRange: () => 'The deadline is outside [now, now + maxDeadlineSeconds]. The SDK builds deadlines from chain time; a custom deadline must respect the account limit.',
  ActionLimit: () => 'The account has used all its actions for this period (maxActionsPerPeriod).',
  // Registry — period caps (record)
  PeriodSpendExceeded: (a) => `Above the period spend cap. Remaining this period: ${usdc(a[0])}.`,
  PeriodSellExceeded: (a) => `Above the period sell cap. Sells are valued at the higher of the average and the high-water cost basis. Remaining this period: ${usdc(a[0])}.`,
  TokenCapExceeded: (a) => `Above the per-token period cap. Remaining for this token: ${usdc(a[0])}.`,
  LaunchLimit: () => 'The account has used all its launches for this period (launchesPerPeriod).',
  // Registry — owner side, agents and queue
  NotOwner: () => 'Only the account owner can do this.',
  NotAccount: () => 'The caller is not a registered agent account of this factory.',
  NotFactory: () => 'Only the agent account factory can do this.',
  AlreadyInitialized: () => 'This account is already initialised.',
  ZeroAddress: () => 'An address argument is the zero address.',
  PeriodOutOfRange: () => 'The usage period must be between one hour and seven days.',
  DelayOutOfRange: () => 'The widening delay must be at most seven days.',
  InvalidAgent: () => 'The agent key cannot be zero, the owner or the account itself.',
  AgentExpiryOutOfRange: () => 'The agent expiry must be after now and at most 180 days away.',
  InvalidPermissions: () => 'The permissions are empty or contain an unknown bit.',
  BetaCeiling: (a) => `The policy field ${field(a[0])} is above the beta ceiling of this factory.`,
  InvalidPolicy: (a) => `The policy field ${field(a[0])} is out of range (a bps field above 10,000, or a deadline outside 1–600 s).`,
  AgentNotActive: () => 'That address is not an active agent; use addAgent.',
  AgentAlreadyActive: () => 'That agent is already active; use setAgent to change its terms.',
  AgentRetired: () => 'That address was revoked before and can never be an agent of this account again.',
  TooManyAgents: () => 'The account already has eight active agents. Revoke one first.',
  UnknownQueued: (a) => `No queued change has id ${String(a[0])} (never queued, already executed or cancelled).`,
  TooEarly: (a) => `This queued change can run from ${time(a[0])}.`,
  QueuedExpired: () => 'This queued change expired 7 days after its ETA. Cancel it and queue it again.',
  StaleQueued: () => "The subject of this queued change (the agent, the token's allowlist entry or the delay) was changed after it was queued, so it no longer applies. Queue it again.",
  AcceptRequired: () => 'An ownership transfer completes only when the new owner calls acceptOwnership.',
  NotPendingOwner: () => 'Only the proposed new owner of this queued transfer can accept it.',
  InvalidOwner: () => 'The new owner cannot be zero, the account itself or the current owner.',
  // Account — trade checks
  TokenNotRegistered: () => 'The token is not a Mercurifi Launch token on this network.',
  TokenNotAllowed: () => 'The account is in allowlist mode and this token is not on the owner allowlist. Sells stay open.',
  TokenTooNew: () => 'The token is younger than the account minimum token age (minTokenAgeBlocks).',
  SnipeTaxTooHigh: (a) => `The launch snipe tax is ${String(a[0])} bps, above this account limit (maxSnipeBps). Wait for it to decay.`,
  PriceImpactTooHigh: (a) => `This trade would move the price by ${String(a[0])} bps, above maxPriceImpactBps. Trade a smaller size.`,
  ZeroMinOut: () => 'The minimum output must be above zero.',
  ZeroOutput: () => 'The trade would return nothing at the current price.',
  ZeroAmount: () => 'The amount is zero or rounds to zero.',
  AmountTooLarge: () => 'The amount is too large to encode (above uint128 for pool swaps, or overflowing the native scale).',
  TradeTooLarge: (a) => `Above the per-trade limit of ${usdc(a[0])} (maxTradeUsdc). Sells count at cost basis, launches include the launch fee.`,
  NotTrading: () => 'The curve is not trading: it sold out, is graduating, or has graduated. Use swapExactIn once it has graduated.',
  NotGraduated: () => 'The token has not graduated; trade it on its curve with buy or sell.',
  UnexpectedPool: () => 'The graduated pool is not the LaunchHook USDC pool for this token; the account refuses to trade it.',
  UnexpectedSwapDelta: () => 'Safety check: the pool swap moved more or returned less than asked, so the whole swap was reverted. Report this.',
  AllowanceNotCleared: () => 'Safety check: an allowance survived the trade, so the whole trade was reverted. Report this.',
  NativeTransferFailed: () => 'The native USDC transfer to the owner failed (for example a blocklisted owner, or an owner contract that refuses USDC).',
  SelfReferrer: () => 'The referrer cannot be the account itself.',
  ReentrancyGuardReentrantCall: () => 'Reentrant call refused.',
  SafeCastOverflowedUintDowncast: (a) => `A value overflowed ${String(a[0])} bits.`,
  SafeCastOverflowedUintToInt: () => 'A value overflowed int256.',
  SafeERC20FailedOperation: (a) => `A token transfer or approval of ${String(a[0])} failed.`,
  // Factory
  AccountExists: (a) => `An account already exists at ${String(a[0])} for this owner and salt; use another salt.`,
  FailedDeployment: () => 'The account clone could not be deployed.',
  // The factory's error carries two amounts; the Universal Router declares one of the same name with none.
  InsufficientBalance: (a) => (a.length >= 2 ? `Insufficient balance: ${String(a[0])} available, ${String(a[1])} needed.` : 'Insufficient balance.'),
  ImplementationMismatch: () => 'The implementation is not bound to this factory and its registry.',
  InvalidCeiling: (a) => `The beta ceiling for ${field(a[0])} is out of range.`,
  NoActivePause: () => 'There is no active pause to extend.',
  PauseTooLong: (a) => `The pause may last at most until ${time(a[0])}.`,
  NotAdmin: () => 'Only the factory admin (the Launch timelock) can do this.',
  NotGuardian: () => 'Only the guardian can do this.',
  GuardianDisabled: () => 'This factory has no guardian; no pause can be started.',
  PauseCooldown: (a) => `The guardian pause is cooling down until ${time(a[0])}.`,
  // Launch, bubbled through the account
  Slippage: () => 'The price moved past your minimum output. Re-quote and retry, or allow more slippage.',
  Expired: () => 'The deadline passed before the transaction was included.',
  ConfigChanged: () => 'The Launch config changed between the quote and inclusion. Re-read the config and retry.',
  InitialBuyTooLarge: () => 'The initial buy is above the launch cap (maxInitialBuyTokens).',
  InsufficientGasForGraduation: () => 'This buy completes the curve and needs more gas for graduation. The SDK sends at least 1,800,000 gas for such buys.',
  InvalidParams: () => 'The name must be 1–32 bytes, the symbol 1–10 bytes and the metadata URI at most 256 bytes.',
  InsufficientLaunchFee: () => 'The value sent does not cover the launch fee.',
  EnforcedPause: () => 'Launch is paused by governance.',
  NothingToClaim: () => 'There are no fees to claim.',
  PartialFill: () => 'The pool cannot fill this whole amount within its price bounds. Trade a smaller size.',
  V4TooLittleReceived: () => 'The pool output was below the minimum (slippage). Re-quote and retry.',
  ERC20InsufficientBalance: () => 'The account does not hold enough of this token.',
  // Standard
  EmptyRevert: () => 'The call reverted without a reason (often out of gas, or a call to an address without code).',
});

const ERROR_SELECTOR = '0x08c379a0';
const MAX_REASON = 200;

/**
 * Contract-supplied text is untrusted: no control or Unicode format characters (bidi overrides, zero-width), no double
 * quotes, no URLs, bounded length without splitting a surrogate pair. The raw string stays in `args`.
 */
export const untrustedReason = (raw: unknown): string => {
  const text = preBound(typeof raw === 'string' ? raw : String(raw), MAX_REASON).normalize('NFKC');
  const clean = truncateChars(neutralizeUntrusted(text.replace(/"/g, "'")).trim(), MAX_REASON, '...');
  return `Reverted with a contract-supplied reason (untrusted text): "${clean}"`;
};

const emptySelector = '0x' as Hex;

const decoded = (name: string, args: readonly unknown[], source: string, selector: Hex, data: Hex): DecodedRevert => {
  const explain = ERROR_MESSAGES[name];
  return { name, args, source, selector, data, message: explain === undefined ? `Reverted with ${name} (${source}).` : explain(args) };
};

/**
 * Decodes revert data against every ABI the SDK touches, plus Error(string) and Panic(uint256).
 *
 * @param data the revert data, or undefined when the node returned none
 * @returns the decoded error with a readable message; never throws
 */
export const decodeRevert = (data: Hex | undefined): DecodedRevert => {
  if (data === undefined || data === '0x') return decoded('EmptyRevert', [], 'EVM', emptySelector, '0x');
  if (typeof data !== 'string' || !isHex(data, { strict: true }) || data.length % 2 !== 0) {
    return { name: 'MalformedRevert', args: [], source: 'unknown', selector: emptySelector, data: '0x', message: 'The revert data is not valid hex, so it could not be decoded.' };
  }
  if (size(data) < 4) return { name: 'MalformedRevert', args: [], source: 'unknown', selector: emptySelector, data, message: 'The revert data is shorter than a 4-byte selector, so it could not be decoded.' };
  const selector = slice(data, 0, 4);
  for (const [source, abi] of SOURCES) {
    let r: { errorName: string; args?: readonly unknown[] };
    try {
      r = decodeErrorResult({ abi, data });
    } catch {
      continue; // not in this ABI
    }
    if (r.errorName === 'Error') return { name: 'Error', args: r.args ?? [], source: 'Solidity', selector, data, message: untrustedReason(r.args?.[0]) };
    if (r.errorName === 'Panic') return { name: 'Panic', args: r.args ?? [], source: 'Solidity', selector, data, message: `Panic 0x${BigInt(r.args?.[0] as bigint).toString(16)} (arithmetic or assertion failure).` };
    try {
      return decoded(r.errorName, r.args ?? [], source, selector, data);
    } catch {
      return { name: r.errorName, args: r.args ?? [], source, selector, data, message: `Reverted with ${r.errorName} (${source}).` };
    }
  }
  if (selector === ERROR_SELECTOR) return { name: 'MalformedRevert', args: [], source: 'Solidity', selector, data, message: 'The revert carried a malformed Error(string).' };
  return { name: 'UnknownError', args: [], source: 'unknown', selector, data, message: `Reverted with an unknown error ${selector}.` };
};

/** Walks an error's cause chain for JSON-RPC revert data (`data` as hex, or `data.data`). */
export const extractRevertData = (error: unknown): Hex | undefined => {
  const asHex = (v: unknown): Hex | undefined => (typeof v === 'string' && isHex(v, { strict: true }) && v.length % 2 === 0 ? v : undefined);
  const candidates = (o: unknown): (Hex | undefined)[] => {
    const r = o as { data?: unknown; raw?: unknown; error?: { data?: unknown } } | null;
    const d = r?.data as { data?: unknown; originalError?: { data?: unknown } } | undefined | null;
    return [asHex(r?.data), asHex(d?.data), asHex(d?.originalError?.data), asHex(r?.raw), asHex(r?.error?.data)];
  };
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && typeof current === 'object' && depth < 16; depth += 1) {
    const found = candidates(current).find((h) => h !== undefined);
    if (found !== undefined) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** A contract would reject, or did reject in a simulation. Nothing was broadcast. */
export class ContractRevertError extends MercurifiError {
  readonly revert: DecodedRevert;
  readonly phase: 'local' | 'preflight';

  constructor(revert: DecodedRevert, phase: 'local' | 'preflight') {
    super('CONTRACT_REVERT', revert.message);
    this.name = 'ContractRevertError';
    this.revert = revert;
    this.phase = phase;
  }
}

/** The transaction was included and reverted. `revert` is the replayed reason when it reproduces. */
export class TxRevertedError extends MercurifiError {
  readonly hash: Hex;
  readonly revert: DecodedRevert | null;

  constructor(hash: Hex, revert: DecodedRevert | null) {
    super('TX_REVERTED', revert === null ? `Transaction ${hash} reverted; replaying it did not reproduce the reason.` : `Transaction ${hash} reverted: ${revert.message}`);
    this.name = 'TxRevertedError';
    this.hash = hash;
    this.revert = revert;
  }
}

/** The error an on-chain check would raise, produced locally before anything is signed. */
export const localRevert = (name: string, args: readonly unknown[] = []): ContractRevertError =>
  new ContractRevertError(decoded(name, args, 'local check', emptySelector, '0x'), 'local');
