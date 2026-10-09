import { InvalidInputError } from './errors.js';
import { formatUsdc6, parseUsdc } from './units.js';

/** On-chain Policy. USDC fields are usdc6. */
export interface ChainPolicy {
  maxTradeUsdc: bigint;
  periodSpendCap: bigint;
  perTokenPeriodCap: bigint;
  periodSellCap: bigint;
  maxActionsPerPeriod: number;
  launchesPerPeriod: number;
  maxPriceImpactBps: number;
  maxSnipeBps: number;
  minTokenAgeBlocks: number;
  maxDeadlineSeconds: number;
  allowlistOnly: boolean;
}

/** Human policy input: USDC fields as decimal strings. Omitted fields keep the base value. */
export interface PolicyInput {
  maxTradeUsdc?: string;
  periodSpendCap?: string;
  perTokenPeriodCap?: string;
  periodSellCap?: string;
  maxActionsPerPeriod?: number;
  launchesPerPeriod?: number;
  maxPriceImpactBps?: number;
  maxSnipeBps?: number;
  minTokenAgeBlocks?: number;
  maxDeadlineSeconds?: number;
  allowlistOnly?: boolean;
}

export type PolicyField = keyof ChainPolicy;

/** Struct order of `Policy`; also the index order a `BetaCeiling(uint8)` refers to. */
export const POLICY_FIELDS: readonly PolicyField[] = [
  'maxTradeUsdc', 'periodSpendCap', 'perTokenPeriodCap', 'periodSellCap', 'maxActionsPerPeriod', 'launchesPerPeriod',
  'maxPriceImpactBps', 'maxSnipeBps', 'minTokenAgeBlocks', 'maxDeadlineSeconds', 'allowlistOnly',
];

const USDC_FIELDS = new Set<PolicyField>(['maxTradeUsdc', 'periodSpendCap', 'perTokenPeriodCap', 'periodSellCap']);
const INT_LIMITS: Partial<Record<PolicyField, number>> = {
  maxActionsPerPeriod: 0xffff_ffff, launchesPerPeriod: 0xffff, maxPriceImpactBps: 0xffff, maxSnipeBps: 0xffff,
  minTokenAgeBlocks: 0xffff_ffff, maxDeadlineSeconds: 0xffff_ffff,
};
const UINT64_MAX = (1n << 64n) - 1n;

export const DEFAULT_POLICY: ChainPolicy = Object.freeze({
  maxTradeUsdc: 100_000_000n,
  periodSpendCap: 500_000_000n,
  perTokenPeriodCap: 100_000_000n,
  periodSellCap: 500_000_000n,
  maxActionsPerPeriod: 500,
  launchesPerPeriod: 3,
  maxPriceImpactBps: 300,
  maxSnipeBps: 0,
  minTokenAgeBlocks: 0,
  maxDeadlineSeconds: 120,
  allowlistOnly: false,
});

export const DEFAULT_PERIOD_SECONDS = 86_400;
export const MIN_PERIOD_SECONDS = 3_600;
export const MAX_PERIOD_SECONDS = 604_800;
export const DEFAULT_INCREASE_DELAY = 3_600;
export const MAX_INCREASE_DELAY = 604_800;
export const MAX_AGENTS = 8;
export const DEFAULT_AGENT_DAYS = 30;
export const MAX_AGENT_DAYS = 180;
export const MAX_DEADLINE_SECONDS = 600;
export const QUEUE_TTL_SECONDS = 604_800;

/** Applies human input over a base policy, checking types and integer ranges. */
export const mergePolicy = (base: ChainPolicy, input: PolicyInput): ChainPolicy => {
  const out: ChainPolicy = { ...base };
  const set = out as unknown as Record<PolicyField, unknown>;
  for (const [key, raw] of Object.entries(input) as [PolicyField, unknown][]) {
    if (raw === undefined) continue;
    if (!POLICY_FIELDS.includes(key)) throw new InvalidInputError(`policy.${key}`, `unknown policy field ${key}`);
    if (USDC_FIELDS.has(key)) {
      const v = parseUsdc(raw, `policy.${key}`);
      if (v > UINT64_MAX) throw new InvalidInputError(`policy.${key}`, `policy.${key} is too large`);
      set[key] = v;
    } else if (key === 'allowlistOnly') {
      if (typeof raw !== 'boolean') throw new InvalidInputError('policy.allowlistOnly', 'policy.allowlistOnly must be a boolean');
      out.allowlistOnly = raw;
    } else {
      const max = INT_LIMITS[key] ?? 0;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
        throw new InvalidInputError(`policy.${key}`, `policy.${key} must be an integer in 0..${max}`);
      }
      set[key] = raw;
    }
  }
  return out;
};

const show = (field: PolicyField, value: ChainPolicy[PolicyField]): string =>
  typeof value === 'bigint' ? formatUsdc6(value) : String(value);

/**
 * Local mirror of the contract's policy validation (AgentPolicyLib.validate plus the factory ceilings).
 * The contract stays authoritative; this only explains a failure before anything is signed.
 */
export const validatePolicy = (p: ChainPolicy, ceilings?: ChainPolicy): void => {
  if (p.maxDeadlineSeconds < 1 || p.maxDeadlineSeconds > MAX_DEADLINE_SECONDS) {
    throw new InvalidInputError('policy.maxDeadlineSeconds', `policy.maxDeadlineSeconds must be in 1..${MAX_DEADLINE_SECONDS}`);
  }
  if (p.maxPriceImpactBps > 10_000) throw new InvalidInputError('policy.maxPriceImpactBps', 'policy.maxPriceImpactBps must be at most 10000');
  if (p.maxSnipeBps > 10_000) throw new InvalidInputError('policy.maxSnipeBps', 'policy.maxSnipeBps must be at most 10000');
  if (ceilings === undefined) return;
  for (const field of POLICY_FIELDS) {
    if (field === 'allowlistOnly' || field === 'minTokenAgeBlocks') continue;
    if ((p[field] as bigint | number) > (ceilings[field] as bigint | number)) {
      throw new InvalidInputError(`policy.${field}`, `policy.${field} = ${show(field, p[field])} is above the beta ceiling of ${show(field, ceilings[field])}`);
    }
  }
};

/** Per-field direction, identical to AgentPolicyLib.isNarrowing. */
export const fieldDirection = (field: PolicyField, current: ChainPolicy, next: ChainPolicy): 'same' | 'narrow' | 'widen' => {
  const a = current[field] as bigint | number | boolean;
  const b = next[field] as bigint | number | boolean;
  if (a === b) return 'same';
  if (typeof a === 'boolean' || typeof b === 'boolean') return b ? 'narrow' : 'widen';
  if (field === 'minTokenAgeBlocks') return b > a ? 'narrow' : 'widen';
  return b < a ? 'narrow' : 'widen';
};

export interface PolicyPreview {
  changes: { field: PolicyField; current: string; next: string; direction: 'narrow' | 'widen' }[];
  immediate: PolicyField[];
  queued: PolicyField[];
  outcome: 'none' | 'immediate' | 'queued' | 'mixed';
  /** The policy in force right after the transaction: narrowed fields applied, widened ones not yet. */
  immediatePolicy: ChainPolicy;
  /** The full requested policy, which the queued item applies after the delay (field-wise merge). */
  target: ChainPolicy;
}

export const previewPolicyChange = (current: ChainPolicy, next: ChainPolicy): PolicyPreview => {
  const immediatePolicy: ChainPolicy = { ...current };
  const changes: PolicyPreview['changes'] = [];
  const immediate: PolicyField[] = [];
  const queued: PolicyField[] = [];
  for (const field of POLICY_FIELDS) {
    const direction = fieldDirection(field, current, next);
    if (direction === 'same') continue;
    changes.push({ field, current: show(field, current[field]), next: show(field, next[field]), direction });
    if (direction === 'narrow') {
      immediate.push(field);
      (immediatePolicy as unknown as Record<PolicyField, unknown>)[field] = next[field];
    } else {
      queued.push(field);
    }
  }
  const outcome = changes.length === 0 ? 'none' : queued.length === 0 ? 'immediate' : immediate.length === 0 ? 'queued' : 'mixed';
  return { changes, immediate, queued, outcome, immediatePolicy, target: { ...next } };
};
