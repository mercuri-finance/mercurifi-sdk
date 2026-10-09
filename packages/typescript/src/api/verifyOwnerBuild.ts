import { decodeFunctionData, encodeFunctionData, getAbiItem, isAddress, isHex, type Abi, type AbiFunction, type AbiParameter, type Address } from 'viem';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../abi/index.js';
import { BuildMismatchError, InvalidInputError } from '../errors.js';
import { encodePermissions, type Permission } from '../permissions.js';
import type { BuiltTx, OwnerBuildFunction } from './types.js';

/**
 * Owner, pending-owner and permissionless functions POST /v1/tx/build encodes. `withdraw` and `withdrawMany` go to the
 * account; every other one goes to the AgentPolicyRegistry paired with the account's factory, with the account first.
 */
export type OwnerFunction = OwnerBuildFunction;

/**
 * Argument names as the API takes them (server names), in contract order after the leading `account`. The contract's
 * own names differ for a few (`a`, `oldA`, `newA`, `d`, `p`); they are mapped by position, never by name.
 */
const OWNER_FUNCTIONS: Readonly<Record<OwnerFunction, { onRegistry: boolean; args: readonly string[] }>> = Object.freeze({
  withdraw: { onRegistry: false, args: ['token', 'amount'] },
  withdrawMany: { onRegistry: false, args: ['tokens'] },
  addAgent: { onRegistry: true, args: ['agent', 'expiresAt', 'permissions'] },
  setAgent: { onRegistry: true, args: ['agent', 'expiresAt', 'permissions'] },
  revokeAgent: { onRegistry: true, args: ['agent'] },
  rotateAgent: { onRegistry: true, args: ['oldAgent', 'newAgent', 'expiresAt', 'permissions'] },
  setPolicy: { onRegistry: true, args: ['policy'] },
  setTokenAllowed: { onRegistry: true, args: ['token', 'allowed'] },
  setIncreaseDelay: { onRegistry: true, args: ['delay'] },
  transferOwnership: { onRegistry: true, args: ['newOwner'] },
  acceptOwnership: { onRegistry: true, args: ['id'] },
  executeQueued: { onRegistry: true, args: ['id'] },
  cancelQueued: { onRegistry: true, args: ['id'] },
  pauseAgents: { onRegistry: true, args: ['paused'] },
});

export interface OwnerBuildExpectation {
  chainId: number;
  /** Your Agent Account. Registry calls must carry it as their first argument; withdrawals must target it. */
  account: Address;
  /**
   * The AgentPolicyRegistry paired with the account's factory: the network book's `agentRegistry` (it is also
   * `factory.registry()`). Required for every function except `withdraw` and `withdrawMany`.
   */
  registry?: Address;
  functionName: OwnerFunction;
  /**
   * Every argument, by its API name (the account is not one: it is forced). Addresses compare case-insensitively;
   * numbers are a bigint, a safe non-negative integer or a decimal string; `permissions` may also be a list of
   * permission names; `policy` is an object with every Policy field; `tokens` is the exact ordered list.
   */
  exact: Record<string, unknown>;
}

const NUM = /^\d+$/;
const show = (v: unknown): string => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  const s = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? 'an object' : String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copies exact (and nested arrays and objects) once, so a getter cannot show one value to validation and another to comparison. */
const snapshot = (v: unknown, depth = 0): unknown => {
  if (depth > 2) throw new InvalidInputError('exact', 'exact is nested too deeply');
  if (Array.isArray(v)) return Array.from(v, (x) => snapshot(x, depth + 1));
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, snapshot(x, depth + 1)]));
  return v;
};

const toBig = (path: string, want: unknown): bigint => {
  if (typeof want === 'bigint' && want >= 0n) return want;
  if (typeof want === 'number' && Number.isSafeInteger(want) && want >= 0) return BigInt(want);
  if (typeof want === 'string' && NUM.test(want)) return BigInt(want);
  throw new InvalidInputError('exact', `${path} must be a non-negative bigint, safe integer or decimal string`);
};

const toAddr = (path: string, want: unknown): string => {
  if (typeof want !== 'string' || !isAddress(want, { strict: false })) throw new InvalidInputError('exact', `${path} must be an address`);
  return want.toLowerCase();
};

const mismatch = (fn: string, path: string, got: unknown, want: unknown) => new BuildMismatchError(`${path} of ${fn} is ${show(got)}, asked for ${show(want)}`);

/** Compares one decoded argument with its expectation by the ABI type; any type it does not know is refused. */
const compare = (fn: string, path: string, param: AbiParameter, got: unknown, want: unknown): void => {
  const t = param.type;
  if (t === 'address') {
    if (typeof got !== 'string' || got.toLowerCase() !== toAddr(path, want)) throw mismatch(fn, path, got, want);
    return;
  }
  if (t === 'address[]') {
    if (!Array.isArray(want)) throw new InvalidInputError('exact', `${path} must be a list of addresses`);
    const w = want.map((x, i) => toAddr(`${path}[${i}]`, x));
    if (!Array.isArray(got) || got.length !== w.length || got.some((g, i) => typeof g !== 'string' || g.toLowerCase() !== w[i])) throw mismatch(fn, path, got, want);
    return;
  }
  if (t === 'bool') {
    if (typeof want !== 'boolean') throw new InvalidInputError('exact', `${path} must be a boolean`);
    if (got !== want) throw mismatch(fn, path, got, want);
    return;
  }
  if (/^uint\d+$/.test(t)) {
    const w = path === 'permissions' && Array.isArray(want) ? BigInt(encodePermissions(want as Permission[])) : toBig(path, want);
    if ((typeof got !== 'bigint' && typeof got !== 'number') || BigInt(got) !== w) throw mismatch(fn, path, got, want);
    return;
  }
  if (t === 'tuple' && 'components' in param) {
    if (!isPlainObject(want)) throw new InvalidInputError('exact', `${path} must be an object with every field`);
    if (!isPlainObject(got)) throw new BuildMismatchError(`${path} of ${fn} did not decode as a struct`);
    const names = param.components.map((c) => c.name ?? '');
    for (const n of names) if (!Object.hasOwn(want, n)) throw new BuildMismatchError(`${path}.${n} of ${fn} is not covered by your expectation`);
    for (const k of Object.keys(want)) if (!names.includes(k)) throw new BuildMismatchError(`${fn} has no argument ${path}.${show(k)}`);
    param.components.forEach((c) => compare(fn, `${path}.${c.name ?? ''}`, c, got[c.name ?? ''], want[c.name ?? '']));
    return;
  }
  throw new BuildMismatchError(`${path} of ${fn} has type ${t}, which this verifier does not check`);
};

/**
 * Decodes owner or registry calldata the API built (POST /v1/tx/build) and checks it against what you asked for,
 * before anything is signed. It mirrors {@link verifyBuiltTx} for agent calls and fails closed: the
 * function must be one of {@link OwnerFunction}; the target must be your account (`withdraw`, `withdrawMany`) or the
 * registry you name (every other function), whose first argument must be your account; value 0; your chain; the
 * server's selector (when sent) matching the calldata; canonical encoding with no trailing bytes; and every argument
 * covered by `exact`, with no argument left over on either side.
 *
 * The expectation must come from your own request, never from the build response or from the `args` this returns.
 */
export const verifyBuiltOwnerTx = (built: BuiltTx, expectation: OwnerBuildExpectation): { functionName: OwnerFunction; args: Record<string, unknown> } => {
  const fn = expectation.functionName;
  const chainId = expectation.chainId;
  const account = expectation.account;
  const registry = expectation.registry;
  const exact = snapshot(expectation.exact);
  if (typeof fn !== 'string' || !Object.hasOwn(OWNER_FUNCTIONS, fn)) throw new InvalidInputError('functionName', `${show(fn)} is not an owner function`);
  const spec = OWNER_FUNCTIONS[fn];
  if (typeof account !== 'string' || !isAddress(account, { strict: false })) throw new InvalidInputError('account', 'account is not an address');
  if (spec.onRegistry && (typeof registry !== 'string' || !isAddress(registry, { strict: false }))) {
    throw new InvalidInputError('registry', `${fn} goes to the AgentPolicyRegistry: pass its address (the network book's agentRegistry)`);
  }
  if (!isPlainObject(exact)) throw new InvalidInputError('exact', 'exact must be an object with every argument');

  if (typeof built !== 'object' || built === null) throw new BuildMismatchError('the built transaction is not an object');
  const { chainId: bChain, to, value, data, selector } = built;
  const bFunction: unknown = (built as { function?: unknown }).function;
  if (bChain !== chainId) throw new BuildMismatchError(typeof bChain === 'number' ? `chain ${bChain} is not ${chainId}` : `chainId is a ${typeof bChain}, not a number`);
  const target = spec.onRegistry ? (registry as Address) : account;
  if (typeof to !== 'string' || !isAddress(to, { strict: false }) || to.toLowerCase() !== target.toLowerCase()) {
    throw new BuildMismatchError(spec.onRegistry ? `target is not the agent policy registry ${target}` : `target is not your account ${account}`);
  }
  if (typeof value !== 'string' || !NUM.test(value) || BigInt(value) !== 0n) throw new BuildMismatchError('owner calls never carry value');
  if (typeof data !== 'string' || !isHex(data) || data.length < 10 || data.length % 2 !== 0) throw new BuildMismatchError('calldata is not hex');
  if (selector !== undefined && (typeof selector !== 'string' || selector.toLowerCase() !== data.slice(0, 10).toLowerCase())) {
    throw new BuildMismatchError(`the server's selector ${show(selector)} does not match the calldata`);
  }

  const abi = (spec.onRegistry ? agentPolicyRegistryAbi : agentAccountAbi) as Abi;
  const contract = spec.onRegistry ? 'AgentPolicyRegistry' : 'AgentAccount';
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi, data }) as unknown as { functionName: string; args: readonly unknown[] };
  } catch {
    throw new BuildMismatchError(`calldata does not decode against ${contract}`);
  }
  const name = decoded.functionName;
  if (!Object.hasOwn(OWNER_FUNCTIONS, name) || OWNER_FUNCTIONS[name as OwnerFunction].onRegistry !== spec.onRegistry) {
    throw new BuildMismatchError(`${name} is not an owner function of ${contract}`);
  }
  if (name !== fn) throw new BuildMismatchError(`built ${name}, asked for ${fn}`);
  if (bFunction !== undefined && bFunction !== name) throw new BuildMismatchError(`the server's function ${show(bFunction)} does not match the calldata`);
  const reencoded = encodeFunctionData({ abi, functionName: name, args: decoded.args } as never);
  if (reencoded.toLowerCase() !== data.toLowerCase()) throw new BuildMismatchError('calldata has trailing or non-canonical bytes');

  const item = getAbiItem({ abi, name } as never) as AbiFunction;
  const lead = spec.onRegistry ? 1 : 0;
  // A changed ABI (an argument added, removed or retyped at the front) is refused, never guessed.
  if (item.inputs.length !== lead + spec.args.length || (spec.onRegistry && (item.inputs[0]?.type !== 'address' || item.inputs[0]?.name !== 'account'))) {
    throw new BuildMismatchError(`the ${name} ABI does not have the arguments this verifier checks`);
  }
  if (spec.onRegistry) {
    const first = decoded.args[0];
    if (typeof first !== 'string' || first.toLowerCase() !== account.toLowerCase()) throw new BuildMismatchError(`the registry call is not for your account ${account} (it names ${show(first)})`);
  }
  for (const k of spec.args) if (!Object.hasOwn(exact, k)) throw new BuildMismatchError(`${k} of ${name} is not covered by your expectation`);
  for (const k of Object.keys(exact)) if (!spec.args.includes(k)) throw new BuildMismatchError(`${name} has no argument ${show(k)}`);
  const args: Record<string, unknown> = {};
  spec.args.forEach((k, i) => {
    const param = item.inputs[lead + i] as AbiParameter;
    compare(name, k, param, decoded.args[lead + i], exact[k]);
    args[k] = decoded.args[lead + i];
  });
  return { functionName: name as OwnerFunction, args };
};
