import {
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  isAddress,
  isHex,
  type AbiFunction,
  type Address,
} from 'viem';

import { agentAccountAbi } from '../abi/index.js';
import { BuildMismatchError, InvalidInputError } from '../errors.js';
import type { BuildFunction, BuiltTx } from './types.js';

export type AgentFunction = BuildFunction;
const AGENT_FUNCTIONS: readonly string[] = [
  'buy',
  'sell',
  'launch',
  'swapExactIn',
  'claimFees',
  'sweepToOwner',
];

export interface BuildExpectation {
  chainId: number;
  account: Address;
  functionName: AgentFunction;
  /** Arguments that must equal these values (addresses and bytes32 compare case-insensitively). Launch request fields are flattened. */
  exact?: Record<string, unknown>;
  /** Arguments that must be at least these values; allowed only for minimum-output arguments (`min…Out`). */
  atLeast?: Record<string, bigint>;
  /** Window for the `deadline` argument (required for trades and launches; `claimFees` and `sweepToOwner` take none). */
  deadline?: { min: bigint; max: bigint };
}

const HEX_ID = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/; // addresses and bytes32 values compare case-insensitively
const MIN_OUT = /^min[A-Za-z0-9]*Out$/;

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' && typeof b === 'string' && HEX_ID.test(a) && HEX_ID.test(b))
    return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'bigint') {
    // A numeric expectation is a bigint or a plain decimal string; nothing else is coerced.
    if (typeof b === 'bigint') return a === b;
    if (typeof b === 'string' && /^\d+$/.test(b)) return a === BigInt(b);
    throw new InvalidInputError(
      'exact',
      'a numeric expectation must be a bigint or a decimal string',
    );
  }
  return a === b;
};

const snapshotEntries = (name: string, v: unknown): Record<string, unknown> | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null)
    throw new InvalidInputError(name, `${name} must be an object`);
  return Object.fromEntries(Object.entries(v)); // own enumerable entries, each value read once
};

/**
 * Reads exact, atLeast and deadline from a caller's expectation exactly once each (and each value once) into plain
 * copies, so a getter or proxy cannot show one value to validation and another to comparison.
 */
export const snapshotExpectation = <
  T extends Pick<BuildExpectation, 'exact' | 'atLeast' | 'deadline'>,
>(
  e: T,
): {
  exact?: Record<string, unknown>;
  atLeast?: Record<string, bigint>;
  deadline?: { min: bigint; max: bigint };
} => {
  const exact = snapshotEntries('exact', e.exact);
  const atLeast = snapshotEntries('atLeast', e.atLeast) as Record<string, bigint> | undefined;
  const d = snapshotEntries('deadline', e.deadline);
  const deadline =
    d === undefined ? undefined : ({ min: d.min, max: d.max } as { min: bigint; max: bigint });
  return {
    ...(exact === undefined ? {} : { exact }),
    ...(atLeast === undefined ? {} : { atLeast }),
    ...(deadline === undefined ? {} : { deadline }),
  };
};

const asBigint = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);

/** A chain id: a positive safe integer (never a string, a fraction or a bigint). */
export const isChainId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * Decodes calldata the API built and checks it against what was asked for, before anything is signed:
 * target = own account, chain, zero value, the server's selector (when sent) matching the calldata, an agent trade
 * selector of AgentAccount, the requested arguments and no trailing bytes. Registry calls (owner functions on
 * AgentPolicyRegistry) never decode against AgentAccount and are refused.
 *
 * Verification is total and fails closed: every decoded top-level argument (launch request fields flattened) must be
 * covered by `exact`, by `atLeast` (minimum outputs only) or be `deadline` with a deadline window; an uncovered argument
 * is refused by name. The expectation must come from your own request, never from the build response or from the
 * `args` this function returns (that would only compare the answer with itself). For a launch that means all eight request fields (creator and referrer are not arguments: the
 * account sets them).
 */
export const verifyBuiltTx = (
  built: BuiltTx,
  expectation: BuildExpectation,
): { functionName: AgentFunction; args: Record<string, unknown> } => {
  const e = {
    chainId: expectation.chainId,
    account: expectation.account,
    functionName: expectation.functionName,
    ...snapshotExpectation(expectation),
  };
  if (!isChainId(e.chainId))
    throw new InvalidInputError('chainId', 'chainId must be a positive safe integer');
  if (typeof e.functionName !== 'string' || !AGENT_FUNCTIONS.includes(e.functionName))
    throw new InvalidInputError(
      'functionName',
      `${String(e.functionName)} is not an agent trade function`,
    );
  for (const [k, v] of Object.entries(e.atLeast ?? {})) {
    if (!MIN_OUT.test(k))
      throw new InvalidInputError(
        'atLeast',
        `atLeast applies to minimum-output arguments only, not ${k}`,
      );
    if (typeof v !== 'bigint' || v < 0n)
      throw new InvalidInputError('atLeast', `atLeast.${k} must be a non-negative bigint`);
  }
  if (
    e.deadline !== undefined &&
    (typeof e.deadline.min !== 'bigint' ||
      typeof e.deadline.max !== 'bigint' ||
      e.deadline.min > e.deadline.max)
  ) {
    throw new InvalidInputError('deadline', 'the deadline window needs bigint min <= max');
  }
  if (typeof built !== 'object' || built === null)
    throw new BuildMismatchError('the built transaction is not an object');
  if (!isChainId(built.chainId))
    throw new BuildMismatchError(
      `chainId ${String(built.chainId).slice(0, 40)} is not a positive safe integer`,
    );
  if (built.chainId !== e.chainId)
    throw new BuildMismatchError(`chain ${built.chainId} is not ${e.chainId}`);
  if (
    typeof built.to !== 'string' ||
    !isAddress(built.to, { strict: false }) ||
    built.to.toLowerCase() !== e.account.toLowerCase()
  ) {
    throw new BuildMismatchError(`target is not your account ${e.account}`);
  }
  if (typeof built.value !== 'string' || !/^\d+$/.test(built.value) || BigInt(built.value) !== 0n)
    throw new BuildMismatchError('agent calls never carry value');
  if (typeof built.data !== 'string' || !isHex(built.data) || built.data.length < 10)
    throw new BuildMismatchError('calldata is not hex');
  if (
    built.selector !== undefined &&
    (typeof built.selector !== 'string' ||
      built.selector.toLowerCase() !== built.data.slice(0, 10).toLowerCase())
  ) {
    throw new BuildMismatchError(
      `the server's selector ${String(built.selector)} does not match the calldata`,
    );
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: agentAccountAbi, data: built.data }) as unknown as {
      functionName: string;
      args: readonly unknown[];
    };
  } catch {
    throw new BuildMismatchError('calldata does not decode against AgentAccount');
  }
  if (!AGENT_FUNCTIONS.includes(decoded.functionName))
    throw new BuildMismatchError(`${decoded.functionName} is not an agent trade function`);
  if (decoded.functionName !== e.functionName)
    throw new BuildMismatchError(`built ${decoded.functionName}, asked for ${e.functionName}`);
  const serverFunction: unknown = (built as { function?: unknown }).function;
  if (serverFunction !== undefined && serverFunction !== decoded.functionName) {
    throw new BuildMismatchError(
      `the server's function ${String(serverFunction).slice(0, 40)} does not match the calldata`,
    );
  }
  const reencoded = encodeFunctionData({
    abi: agentAccountAbi,
    functionName: decoded.functionName,
    args: decoded.args,
  } as never);
  if (reencoded.toLowerCase() !== built.data.toLowerCase())
    throw new BuildMismatchError('calldata has trailing or non-canonical bytes');

  const item = getAbiItem({
    abi: agentAccountAbi,
    name: decoded.functionName,
  } as never) as AbiFunction;
  const named: Record<string, unknown> = {};
  item.inputs.forEach((input, i) => {
    const value = decoded.args[i];
    // launch(LaunchRequest): the 8 request fields, deadline last, become top-level names.
    if (input.type === 'tuple' && value !== null && typeof value === 'object')
      Object.assign(named, value);
    else named[input.name ?? `arg${i}`] = value;
  });
  for (const name of Object.keys(named)) {
    const covered =
      Object.hasOwn(e.exact ?? {}, name) ||
      (Object.hasOwn(e.atLeast ?? {}, name) && MIN_OUT.test(name)) ||
      (name === 'deadline' && e.deadline !== undefined);
    if (!covered)
      throw new BuildMismatchError(
        `${name} of ${decoded.functionName} is not covered by your expectation`,
      );
  }
  for (const [k, v] of Object.entries(e.exact ?? {})) {
    if (!Object.hasOwn(named, k))
      throw new BuildMismatchError(`${decoded.functionName} has no argument ${k}`);
    if (!same(named[k], v))
      throw new BuildMismatchError(`${k} is ${String(named[k])}, asked for ${String(v)}`);
  }
  for (const [k, min] of Object.entries(e.atLeast ?? {})) {
    const got = asBigint(named[k]);
    if (got === null)
      throw new BuildMismatchError(`${decoded.functionName} has no numeric argument ${k}`);
    if (got < min) throw new BuildMismatchError(`${k} ${got} is below your minimum ${min}`);
  }
  if (e.deadline !== undefined) {
    const d = asBigint(named.deadline);
    if (d === null) throw new BuildMismatchError(`${decoded.functionName} takes no deadline`);
    if (d < e.deadline.min || d > e.deadline.max)
      throw new BuildMismatchError(
        `deadline ${d} is outside [${e.deadline.min}, ${e.deadline.max}]`,
      );
  }
  return { functionName: decoded.functionName as AgentFunction, args: named };
};
