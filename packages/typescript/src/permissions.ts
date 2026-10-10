import { InvalidInputError } from './errors.js';

export const PERMISSIONS = { buy: 1, sell: 2, launch: 4, swap: 8, claim: 16, sweep: 32 } as const;
export type Permission = keyof typeof PERMISSIONS;
const ORDER: readonly Permission[] = ['buy', 'sell', 'launch', 'swap', 'claim', 'sweep'];

/** `sell` is opt-in and never preselected. */
export const DEFAULT_AGENT_PERMISSIONS: readonly Permission[] = Object.freeze([
  'buy',
  'launch',
  'swap',
  'claim',
]);

export const SELL_RISK_WARNING =
  'You are giving this agent key the sell permission. A stolen key with sell can dump the account holdings into a price an attacker pushed down; the loss is bounded by periodSellCap at cost basis per period, not prevented. Keep holdings small and sweep profits to the owner.';

export const encodePermissions = (list: readonly Permission[]): number => {
  if (list.length === 0)
    throw new InvalidInputError('permissions', 'grant at least one permission');
  let bits = 0;
  for (const p of list) {
    if (typeof p !== 'string' || !Object.hasOwn(PERMISSIONS, p))
      throw new InvalidInputError(
        'permissions',
        `unknown permission ${String(p)}; expected one of ${ORDER.join(', ')}`,
      );
    bits |= PERMISSIONS[p];
  }
  return bits;
};

export const decodePermissions = (bits: number): Permission[] => {
  if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 0 || bits > 63)
    throw new InvalidInputError('permissions', `unknown permission bits in ${bits}`);
  return ORDER.filter((p) => (bits & PERMISSIONS[p]) !== 0);
};

export type ActionName = 'buy' | 'sell' | 'launch' | 'poolBuy' | 'poolSell' | 'claim' | 'sweep';
/** AgentAction.action ids (contracts plan, AgentTypes.sol). */
export const ACTIONS: Readonly<Record<number, ActionName>> = Object.freeze({
  1: 'buy',
  2: 'sell',
  3: 'launch',
  4: 'poolBuy',
  5: 'poolSell',
  6: 'claim',
  7: 'sweep',
});
