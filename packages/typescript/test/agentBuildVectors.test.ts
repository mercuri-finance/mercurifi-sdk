import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import type { BuiltTx } from '../src/api/types.js';
import { verifyBuiltTx, type AgentFunction, type BuildExpectation } from '../src/api/verifyBuild.js';
import { verifyBuiltOwnerTx } from '../src/api/verifyOwnerBuild.js';
import { BuildMismatchError, InvalidInputError } from '../src/errors.js';

interface Vec { name: string; function: AgentFunction; exact: Record<string, unknown>; atLeast: Record<string, string>; deadline?: [string, string]; built: BuiltTx & Record<string, unknown> }
interface Refuse { name: string; base: string; built?: Record<string, unknown>; exactDrop?: string[]; exactSet?: Record<string, unknown>; error: string }
const v = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/agentbuild.json', import.meta.url), 'utf8')) as {
  chainId: number; account: Address; registry: Address; accept: Vec[]; refuse: Refuse[];
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const expectationOf = (vec: Vec, exact = clone(vec.exact)): BuildExpectation => ({
  chainId: v.chainId, account: v.account, functionName: vec.function, exact,
  atLeast: Object.fromEntries(Object.entries(vec.atLeast).map(([k, x]) => [k, BigInt(x)])),
  ...(vec.deadline ? { deadline: { min: BigInt(vec.deadline[0]), max: BigInt(vec.deadline[1]) } } : {}),
});
const refused = (built: unknown, e: BuildExpectation, pattern: RegExp) => {
  let err: unknown;
  try {
    verifyBuiltTx(built as BuiltTx, e);
  } catch (x) {
    err = x;
  }
  expect(err, 'was accepted').toBeInstanceOf(BuildMismatchError);
  expect((err as Error).message).toMatch(pattern);
};

describe('verifyBuiltTx: shared agent-build vectors', () => {
  for (const vec of v.accept) {
    it(`accepts ${vec.name}`, () => {
      expect(verifyBuiltTx(vec.built, expectationOf(vec)).functionName).toBe(vec.function);
    });
    it(`refuses the generic tampers of ${vec.name}`, () => {
      const e = expectationOf(vec);
      refused({ ...vec.built, chainId: v.chainId + 1 }, e, /chain/);
      refused({ ...vec.built, chainId: 0 }, e, /positive safe integer/);
      refused({ ...vec.built, chainId: 2 ** 53 }, e, /positive safe integer/);
      refused({ ...vec.built, to: v.registry }, e, /not your account/);
      refused({ ...vec.built, value: '1' }, e, /value/);
      refused({ ...vec.built, selector: '0x00000000' }, e, /selector/);
      refused({ ...vec.built, data: `${vec.built.data}${'00'.repeat(32)}` as Hex }, e, /trailing/);
      refused({ ...vec.built, function: 'withdraw' }, e, /function/);
      // The owner verifier never accepts an agent call.
      expect(() => verifyBuiltOwnerTx(vec.built, { chainId: v.chainId, account: v.account, registry: v.registry, functionName: vec.function as never, exact: {} })).toThrow(InvalidInputError);
    });
  }
  for (const r of v.refuse) {
    it(`refuses: ${r.name}`, () => {
      const vec = clone(v.accept.find((a) => a.name === r.base)!);
      const built: Record<string, unknown> = { ...vec.built, ...(r.built ?? {}) };
      for (const [k, x] of Object.entries(r.built ?? {})) if (x === null) delete built[k];
      const exact = clone(vec.exact);
      for (const k of r.exactDrop ?? []) delete exact[k];
      Object.assign(exact, r.exactSet ?? {});
      refused(built, expectationOf(vec, exact), new RegExp(r.error, 'i'));
    });
  }
  it('refuses an expectation chainId that is not a positive safe integer', () => {
    const vec = v.accept[0]!;
    for (const chainId of [0, -1, 1.5, 2 ** 53, Number.NaN, '5042002' as never]) {
      expect(() => verifyBuiltTx(vec.built, { ...expectationOf(vec), chainId })).toThrow(InvalidInputError);
      expect(() => verifyBuiltOwnerTx(vec.built, { chainId, account: v.account, registry: v.registry, functionName: 'pauseAgents', exact: { paused: true } })).toThrow(InvalidInputError);
    }
  });
});
