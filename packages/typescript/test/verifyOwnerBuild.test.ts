import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import type { BuiltTx } from '../src/api/types.js';
import {
  verifyBuiltOwnerTx,
  type OwnerBuildExpectation,
  type OwnerFunction,
} from '../src/api/verifyOwnerBuild.js';
import { BuildMismatchError, InvalidInputError } from '../src/errors.js';

interface Vec {
  name: string;
  function: OwnerFunction;
  exact: Record<string, unknown>;
  built: BuiltTx & Record<string, unknown>;
}
interface Refuse {
  name: string;
  base: string;
  built?: Record<string, unknown>;
  exactDrop?: string[];
  exactSet?: Record<string, unknown>;
  error: string;
}
const v = JSON.parse(
  readFileSync(new URL('../../../fixtures/vectors/ownerbuild.json', import.meta.url), 'utf8'),
) as {
  chainId: number;
  account: Address;
  registry: Address;
  accept: Vec[];
  refuse: Refuse[];
};
const OTHER: Address = '0x00000000000000000000000000000000deadbeef';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const expectationOf = (vec: Vec, exact = clone(vec.exact)): OwnerBuildExpectation => ({
  chainId: v.chainId,
  account: v.account,
  registry: v.registry,
  functionName: vec.function,
  exact,
});
const base = (name: string): Vec => {
  const found = v.accept.find((a) => a.name === name);
  if (!found) throw new Error(`no accept vector ${name}`);
  return clone(found);
};
const setPath = (o: Record<string, unknown>, path: string, value: unknown) => {
  const [head, tail] = path.split('.', 2) as [string, string | undefined];
  if (tail === undefined) o[head] = value;
  else (o[head] as Record<string, unknown>)[tail] = value;
};
const dropPath = (o: Record<string, unknown>, path: string) => {
  const [head, tail] = path.split('.', 2) as [string, string | undefined];
  if (tail === undefined) delete o[head];
  else delete (o[head] as Record<string, unknown>)[tail];
};
const refused = (built: unknown, e: OwnerBuildExpectation, pattern: RegExp) => {
  let err: unknown;
  try {
    verifyBuiltOwnerTx(built as BuiltTx, e);
  } catch (x) {
    err = x;
  }
  expect(err, 'was accepted').toBeInstanceOf(BuildMismatchError);
  expect((err as Error).message).toMatch(pattern);
};

describe('verifyBuiltOwnerTx: shared owner-build vectors', () => {
  it('covers every owner function, including the API vectors', () => {
    expect(new Set(v.accept.map((a) => a.function)).size).toBe(14);
    expect(
      v.accept.filter((a) => (a as unknown as { source: string }).source === 'api').length,
    ).toBe(3);
  });

  for (const vec of v.accept) {
    it(`accepts ${vec.name}`, () => {
      expect(verifyBuiltOwnerTx(vec.built, expectationOf(vec)).functionName).toBe(vec.function);
    });

    it(`refuses every generic tamper of ${vec.name}`, () => {
      const onRegistry = vec.built.to.toLowerCase() === v.registry.toLowerCase();
      const e = expectationOf(vec);
      refused({ ...vec.built, chainId: v.chainId + 1 }, e, /chain/);
      refused({ ...vec.built, chainId: String(v.chainId) }, e, /chainId/);
      refused({ ...vec.built, to: onRegistry ? v.account : v.registry }, e, /target/);
      refused({ ...vec.built, to: OTHER }, e, /target/);
      refused({ ...vec.built, value: '1' }, e, /value/);
      refused({ ...vec.built, value: '0x0' }, e, /value/);
      refused({ ...vec.built, selector: '0x00000000' }, e, /selector/);
      refused({ ...vec.built, data: `${vec.built.data}00` }, e, /hex|trailing/);
      refused({ ...vec.built, data: `${vec.built.data}${'00'.repeat(32)}` }, e, /trailing/);
      refused({ ...vec.built, function: 'buy' }, e, /function/);
      if (onRegistry) {
        const data =
          `${vec.built.data.slice(0, 10)}${'0'.repeat(24)}${OTHER.slice(2)}${vec.built.data.slice(74)}` as Hex;
        refused({ ...vec.built, data }, e, /not for your account/);
      }
      for (const k of Object.keys(vec.exact)) {
        const exact = clone(vec.exact);
        delete exact[k];
        refused(
          vec.built,
          expectationOf(vec, exact),
          new RegExp(`${k} of ${vec.function} is not covered`),
        );
      }
      refused(
        vec.built,
        expectationOf(vec, { ...clone(vec.exact), extra: '1' }),
        /has no argument extra/,
      );
      const other = v.accept.find(
        (a) => a.function !== vec.function && a.built.to === vec.built.to,
      )!;
      refused(
        vec.built,
        { ...expectationOf(other), functionName: other.function },
        /asked for|not covered|has no argument/,
      );
    });
  }

  for (const r of v.refuse) {
    it(`refuses: ${r.name}`, () => {
      const vec = base(r.base);
      const built = { ...vec.built, ...(r.built ?? {}) };
      const exact = clone(vec.exact);
      for (const p of r.exactDrop ?? []) dropPath(exact, p);
      for (const [p, val] of Object.entries(r.exactSet ?? {})) setPath(exact, p, val);
      refused(built, expectationOf(vec, exact), new RegExp(r.error, 'i'));
    });
  }
});

describe('verifyBuiltOwnerTx: inputs', () => {
  const pause = base('pauseAgents (registry)');
  const add = base('addAgent');
  const withdraw = base('withdraw (owner)');

  it('refuses functions it does not verify, including agent trades', () => {
    expect(() =>
      verifyBuiltOwnerTx(pause.built, { ...expectationOf(pause), functionName: 'buy' as never }),
    ).toThrow(InvalidInputError);
    expect(() =>
      verifyBuiltOwnerTx(pause.built, {
        ...expectationOf(pause),
        functionName: 'toString' as never,
      }),
    ).toThrow(InvalidInputError);
  });

  it('needs the registry for registry calls, but not for withdrawals', () => {
    const { registry: _r, ...noRegistry } = expectationOf(pause);
    expect(() => verifyBuiltOwnerTx(pause.built, noRegistry)).toThrow(/agentRegistry/);
    const { registry: _w, ...noRegistryW } = expectationOf(withdraw);
    expect(verifyBuiltOwnerTx(withdraw.built, noRegistryW).functionName).toBe('withdraw');
  });

  it('takes permissions as names or a bitmask, numbers as bigint, safe integers or decimal strings', () => {
    const exact = { ...add.exact, permissions: 29, expiresAt: 1_800_086_400n };
    expect(verifyBuiltOwnerTx(add.built, expectationOf(add, exact)).args.permissions).toBe(29);
    expect(() =>
      verifyBuiltOwnerTx(
        add.built,
        expectationOf(add, { ...add.exact, permissions: ['buy', 'nope'] }),
      ),
    ).toThrow(InvalidInputError);
    expect(() =>
      verifyBuiltOwnerTx(add.built, expectationOf(add, { ...add.exact, expiresAt: 1.5 })),
    ).toThrow(InvalidInputError);
    expect(() =>
      verifyBuiltOwnerTx(add.built, expectationOf(add, { ...add.exact, expiresAt: '0x6b4b2400' })),
    ).toThrow(InvalidInputError);
    expect(() => verifyBuiltOwnerTx(pause.built, expectationOf(pause, { paused: 'true' }))).toThrow(
      InvalidInputError,
    );
  });

  it('reads the expectation once', () => {
    let reads = 0;
    const exact = {
      get paused() {
        reads += 1;
        return reads === 1;
      },
    };
    expect(verifyBuiltOwnerTx(pause.built, expectationOf(pause, exact as never)).functionName).toBe(
      'pauseAgents',
    );
    expect(reads).toBe(1);
  });
});
