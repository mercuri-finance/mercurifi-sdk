import { decodeFunctionData, encodeFunctionData, getAbiItem, isAddress, isHex, type AbiFunction, type Address } from 'viem';

import { agentAccountAbi } from '../abi/index.js';
import { BuildMismatchError, InvalidInputError } from '../errors.js';
import type { BuildFunction, BuiltTx } from './types.js';

export type AgentFunction = BuildFunction;
const AGENT_FUNCTIONS: readonly string[] = ['buy', 'sell', 'launch', 'swapExactIn', 'claimFees', 'sweepToOwner'];

export interface BuildExpectation {
  chainId: number;
  account: Address;
  functionName: AgentFunction;
  /** Arguments that must equal these values (addresses compare case-insensitively). Launch request fields are flattened. */
  exact?: Record<string, unknown>;
  /** Arguments that must be at least these values (minimum outputs). */
  atLeast?: Record<string, bigint>;
  /** Window for the `deadline` argument (trades and launches; `claimFees` and `sweepToOwner` take none). */
  deadline?: { min: bigint; max: bigint };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' && typeof b === 'string' && ADDRESS.test(a) && ADDRESS.test(b)) return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    try {
      return BigInt(a as bigint) === BigInt(b as bigint);
    } catch {
      return false;
    }
  }
  return a === b;
};

const asBigint = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);

/**
 * Decodes calldata the API built and checks it against what was asked for, before anything is signed:
 * target = own account, chain, zero value, the server's selector (when sent) matching the calldata, an agent trade
 * selector of AgentAccount, the requested arguments and no trailing bytes. Registry calls (owner functions on
 * AgentPolicyRegistry) never decode against AgentAccount and are refused. Only the arguments named in the expectation
 * are compared: name every one that matters (for a launch the creator and referrer are not arguments; the account
 * sets them, but `expectedConfigHash` and `deadline` are).
 */
export const verifyBuiltTx = (built: BuiltTx, e: BuildExpectation): { functionName: AgentFunction; args: Record<string, unknown> } => {
  if (!AGENT_FUNCTIONS.includes(e.functionName)) throw new InvalidInputError('functionName', `${String(e.functionName)} is not an agent trade function`);
  if (typeof built !== 'object' || built === null) throw new BuildMismatchError('the built transaction is not an object');
  if (built.chainId !== e.chainId) throw new BuildMismatchError(`chain ${String(built.chainId)} is not ${e.chainId}`);
  if (typeof built.to !== 'string' || !isAddress(built.to, { strict: false }) || built.to.toLowerCase() !== e.account.toLowerCase()) {
    throw new BuildMismatchError(`target is not your account ${e.account}`);
  }
  if (typeof built.value !== 'string' || !/^\d+$/.test(built.value) || BigInt(built.value) !== 0n) throw new BuildMismatchError('agent calls never carry value');
  if (typeof built.data !== 'string' || !isHex(built.data) || built.data.length < 10) throw new BuildMismatchError('calldata is not hex');
  if (built.selector !== undefined && (typeof built.selector !== 'string' || built.selector.toLowerCase() !== built.data.slice(0, 10).toLowerCase())) {
    throw new BuildMismatchError(`the server's selector ${String(built.selector)} does not match the calldata`);
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: agentAccountAbi, data: built.data }) as unknown as { functionName: string; args: readonly unknown[] };
  } catch {
    throw new BuildMismatchError('calldata does not decode against AgentAccount');
  }
  if (!AGENT_FUNCTIONS.includes(decoded.functionName)) throw new BuildMismatchError(`${decoded.functionName} is not an agent trade function`);
  if (decoded.functionName !== e.functionName) throw new BuildMismatchError(`built ${decoded.functionName}, asked for ${e.functionName}`);
  const reencoded = encodeFunctionData({ abi: agentAccountAbi, functionName: decoded.functionName, args: decoded.args } as never);
  if (reencoded.toLowerCase() !== built.data.toLowerCase()) throw new BuildMismatchError('calldata has trailing or non-canonical bytes');

  const item = getAbiItem({ abi: agentAccountAbi, name: decoded.functionName } as never) as AbiFunction;
  const named: Record<string, unknown> = {};
  item.inputs.forEach((input, i) => {
    const value = decoded.args[i];
    // launch(LaunchRequest): the 8 request fields, deadline last, become top-level names.
    if (input.type === 'tuple' && value !== null && typeof value === 'object') Object.assign(named, value);
    else named[input.name ?? `arg${i}`] = value;
  });
  for (const [k, v] of Object.entries(e.exact ?? {})) {
    if (!Object.hasOwn(named, k)) throw new BuildMismatchError(`${decoded.functionName} has no argument ${k}`);
    if (!same(named[k], v)) throw new BuildMismatchError(`${k} is ${String(named[k])}, asked for ${String(v)}`);
  }
  for (const [k, min] of Object.entries(e.atLeast ?? {})) {
    const got = asBigint(named[k]);
    if (got === null) throw new BuildMismatchError(`${decoded.functionName} has no numeric argument ${k}`);
    if (got < min) throw new BuildMismatchError(`${k} ${got} is below your minimum ${min}`);
  }
  if (e.deadline !== undefined) {
    const d = asBigint(named.deadline);
    if (d === null) throw new BuildMismatchError(`${decoded.functionName} takes no deadline`);
    if (d < e.deadline.min || d > e.deadline.max) throw new BuildMismatchError(`deadline ${d} is outside [${e.deadline.min}, ${e.deadline.max}]`);
  }
  return { functionName: decoded.functionName as AgentFunction, args: named };
};
