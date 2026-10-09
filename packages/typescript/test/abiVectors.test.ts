import { readFileSync } from 'node:fs';
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, getAbiItem, type Abi, type AbiEvent, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';

const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/abi.json', import.meta.url), 'utf8'));
const abis: Record<string, Abi> = { agentAccount: agentAccountAbi as Abi, agentPolicyRegistry: agentPolicyRegistryAbi as Abi };
// Fixture integers are decimal strings.
const revive = (x: unknown): unknown =>
  typeof x === 'string' && /^-?\d+$/.test(x) ? BigInt(x) : Array.isArray(x) ? x.map(revive) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, e]) => [k, revive(e)])) : x;

describe('shared ABI vectors (same bytes as the Python codec)', () => {
  for (const c of v.calls) {
    it(`encodes ${c.fn} identically`, () => {
      const abi = abis[c.contract];
      if (abi === undefined) throw new Error(`unknown contract ${String(c.contract)}`);
      expect(encodeFunctionData({ abi, functionName: c.fn, args: revive(c.args) as never })).toBe(c.data);
    });
  }
  for (const l of v.logs) {
    it(`encodes the ${l.event} log identically`, () => {
      const abi = abis[l.contract];
      if (abi === undefined) throw new Error(`unknown contract ${String(l.contract)}`);
      const values = revive(l.values) as Record<string, unknown>;
      const item = getAbiItem({ abi, name: l.event }) as unknown as AbiEvent;
      const inputs = item.inputs as readonly { name: string; type: string; indexed?: boolean }[];
      const indexedArgs = Object.fromEntries(inputs.filter((i) => i.indexed === true).map((i) => [i.name, values[i.name]]));
      const topics = encodeEventTopics({ abi, eventName: l.event, args: indexedArgs as Record<string, unknown> } as never) as Hex[];
      const plain = inputs.filter((i) => i.indexed !== true);
      const data = encodeAbiParameters(plain as never, plain.map((i) => values[i.name]) as never);
      expect(topics).toEqual(l.topics);
      expect(data).toBe(l.data);
    });
  }
});
