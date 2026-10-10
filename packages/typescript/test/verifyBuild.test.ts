import { concat, encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { verifyBuiltTx, type BuildExpectation } from '../src/api/verifyBuild.js';
import { BuildMismatchError, InvalidInputError } from '../src/errors.js';
import { DEFAULT_POLICY } from '../src/policy.js';

const ACCOUNT: Address = '0x00000000000000000000000000000000000000aa';
const TOKEN: Address = '0x00000000000000000000000000000000000000bb';
const WAD = 10n ** 18n;
const buy = (minOut = 980n * WAD, deadline = 1_000n) =>
  encodeFunctionData({
    abi: agentAccountAbi,
    functionName: 'buy',
    args: [TOKEN, 25_000_000n, minOut, deadline],
  });
const launch = (deadline: bigint) =>
  encodeFunctionData({
    abi: agentAccountAbi,
    functionName: 'launch',
    args: [
      {
        name: 'Robo',
        symbol: 'ROBO',
        metadataURI: 'https://x.example/m/ab.json',
        salt: `0x${'11'.repeat(32)}`,
        expectedConfigHash: `0x${'22'.repeat(32)}`,
        initialBuyUsdc: 0n,
        minTokensOut: 0n,
        deadline,
      },
    ],
  } as never);
const LAUNCH_EXACT = {
  name: 'Robo',
  symbol: 'ROBO',
  metadataURI: 'https://x.example/m/ab.json',
  salt: `0x${'11'.repeat(32)}`,
  expectedConfigHash: `0x${'22'.repeat(32)}`,
  initialBuyUsdc: 0n,
  minTokensOut: 0n,
};
const expectation: BuildExpectation = {
  chainId: 5042002,
  account: ACCOUNT,
  functionName: 'buy',
  exact: { token: TOKEN, usdcIn: 25_000_000n },
  atLeast: { minTokensOut: 980n * WAD },
  deadline: { min: 900n, max: 1_100n },
};
const built = (
  data: Hex = buy(),
  over: Partial<{ chainId: number; to: Address; value: string; selector: Hex }> = {},
) => ({ chainId: 5042002, to: ACCOUNT, data, value: '0', ...over });

describe('verifyBuiltTx', () => {
  it('accepts calldata that matches the request, with or without the server selector', () => {
    expect(verifyBuiltTx(built(), expectation).args).toMatchObject({
      token: TOKEN,
      usdcIn: 25_000_000n,
    });
    expect(
      verifyBuiltTx(built(buy(), { selector: buy().slice(0, 10) as Hex }), expectation)
        .functionName,
    ).toBe('buy');
  });

  it('flattens the launch request and checks its deadline window', () => {
    const e: BuildExpectation = {
      chainId: 5042002,
      account: ACCOUNT,
      functionName: 'launch',
      exact: LAUNCH_EXACT,
      deadline: { min: 900n, max: 1_100n },
    };
    expect(verifyBuiltTx(built(launch(1_000n)), e).args).toMatchObject({
      name: 'Robo',
      symbol: 'ROBO',
      deadline: 1_000n,
    });
    expect(() => verifyBuiltTx(built(launch(5_000n)), e)).toThrow(/deadline/);
  });

  it.each([
    [
      'another target',
      built(buy(), { to: '0x00000000000000000000000000000000000000cc' }),
      /target/,
    ],
    ['another chain', built(buy(), { chainId: 5042 }), /chain/],
    ['value attached', built(buy(), { value: '1' }), /value/],
    [
      'a selector that disagrees with the calldata',
      built(buy(), { selector: '0xdeadbeef' }),
      /selector/,
    ],
    ['a lowered minimum', built(buy(979n * WAD)), /minTokensOut/],
    ['a far deadline', built(buy(980n * WAD, 5_000n)), /deadline/],
    ['trailing bytes', built(concat([buy(), '0xdeadbeef'])), /trailing/],
    [
      'an owner function of the account',
      built(
        encodeFunctionData({ abi: agentAccountAbi, functionName: 'withdraw', args: [TOKEN, 1n] }),
      ),
      /not an agent trade function/,
    ],
    [
      'a policy registry call',
      built(
        encodeFunctionData({
          abi: agentPolicyRegistryAbi,
          functionName: 'setPolicy',
          args: [ACCOUNT, DEFAULT_POLICY],
        } as never),
      ),
      /does not decode against AgentAccount/,
    ],
  ])('refuses %s', (_name, b, pattern) => {
    expect(() => verifyBuiltTx(b, expectation)).toThrow(BuildMismatchError);
    expect(() => verifyBuiltTx(b, expectation)).toThrow(pattern);
  });

  it('refuses a deadline expectation on a function that takes none', () => {
    const claim = encodeFunctionData({ abi: agentAccountAbi, functionName: 'claimFees', args: [] });
    expect(() =>
      verifyBuiltTx(built(claim), {
        chainId: 5042002,
        account: ACCOUNT,
        functionName: 'claimFees',
        deadline: { min: 1n, max: 2n },
      }),
    ).toThrow(/no deadline/);
    expect(
      verifyBuiltTx(built(claim), { chainId: 5042002, account: ACCOUNT, functionName: 'claimFees' })
        .functionName,
    ).toBe('claimFees');
  });

  it('compares addresses case-insensitively without throwing on a bad checksum, and refuses names the function lacks', () => {
    const mixed = `0x00000000000000000000000000000000000000Bb` as Address;
    expect(
      verifyBuiltTx(built(buy(), { to: '0x00000000000000000000000000000000000000AA' }), {
        ...expectation,
        exact: { token: mixed, usdcIn: 25_000_000n },
      }).functionName,
    ).toBe('buy');
    expect(() =>
      verifyBuiltTx(built(), { ...expectation, exact: { ...expectation.exact, nope: 1n } }),
    ).toThrow(/no argument nope/);
    expect(() => verifyBuiltTx(built(), { ...expectation, atLeast: { token: 1n } })).toThrow(
      /minimum-output/,
    );
    expect(() => verifyBuiltTx(built(), { ...expectation, functionName: 'sell' })).toThrow(
      /built buy, asked for sell/,
    );
    expect(() =>
      verifyBuiltTx(built(), { ...expectation, functionName: 'withdraw' as never }),
    ).toThrow(/not an agent trade function/);
    expect(() => verifyBuiltTx(built(buy(), { value: '-1' }), expectation)).toThrow(
      BuildMismatchError,
    );
    expect(() => verifyBuiltTx({ ...built(), data: '0x12' as Hex }, expectation)).toThrow(
      BuildMismatchError,
    );
  });

  it('pins the launch config hash and refuses a changed one', () => {
    const e: BuildExpectation = {
      chainId: 5042002,
      account: ACCOUNT,
      functionName: 'launch',
      exact: LAUNCH_EXACT,
      deadline: { min: 900n, max: 1_100n },
    };
    expect(verifyBuiltTx(built(launch(1_000n)), e).functionName).toBe('launch');
    expect(() =>
      verifyBuiltTx(built(launch(1_000n)), {
        ...e,
        exact: { ...LAUNCH_EXACT, expectedConfigHash: `0x${'33'.repeat(32)}` },
      }),
    ).toThrow(/expectedConfigHash/);
    expect(
      verifyBuiltTx(built(launch(1_000n)), {
        ...e,
        exact: {
          ...LAUNCH_EXACT,
          expectedConfigHash: `0x${'22'.repeat(32)}`.toUpperCase().replace('0X', '0x'),
        },
      }).functionName,
    ).toBe('launch');
  });

  const buyFull: BuildExpectation = { ...expectation };
  it('fails closed: every argument must be covered, by name', () => {
    const { exact: _e, atLeast: _a, ...bare } = expectation;
    for (const e of [
      { ...bare },
      { ...bare, deadline: expectation.deadline },
      { ...expectation, exact: { usdcIn: 25_000_000n } }, // token uncovered
      { ...expectation, atLeast: undefined }, // minTokensOut uncovered
      { ...expectation, deadline: undefined }, // deadline uncovered
    ] as BuildExpectation[]) {
      expect(() => verifyBuiltTx(built(), e)).toThrow(BuildMismatchError);
      expect(() => verifyBuiltTx(built(), e)).toThrow(/not covered by your expectation/);
    }
    expect(() => verifyBuiltTx(built(), { ...bare })).toThrow(/token of buy/);
    expect(verifyBuiltTx(built(), buyFull).functionName).toBe('buy');
  });

  it('refuses hostile buys: another token, a floor of 1, a longer deadline', () => {
    const other = encodeFunctionData({
      abi: agentAccountAbi,
      functionName: 'buy',
      args: ['0x00000000000000000000000000000000000000cc', 25_000_000n, 980n * WAD, 1_000n],
    });
    expect(() => verifyBuiltTx(built(other), buyFull)).toThrow(/token is/);
    expect(() => verifyBuiltTx(built(buy(1n)), buyFull)).toThrow(/minTokensOut/);
    expect(() => verifyBuiltTx(built(buy(980n * WAD, 1_101n)), buyFull)).toThrow(/deadline/);
  });

  it('covers swapExactIn (flipped buyToken) and sweepToOwner', () => {
    const swap = (buyToken: boolean) =>
      encodeFunctionData({
        abi: agentAccountAbi,
        functionName: 'swapExactIn',
        args: [TOKEN, buyToken, 5n, 4n, 1_000n],
      });
    const e: BuildExpectation = {
      chainId: 5042002,
      account: ACCOUNT,
      functionName: 'swapExactIn',
      exact: { token: TOKEN, buyToken: true, amountIn: 5n },
      atLeast: { minAmountOut: 4n },
      deadline: expectation.deadline,
    };
    expect(verifyBuiltTx(built(swap(true)), e).functionName).toBe('swapExactIn');
    expect(() => verifyBuiltTx(built(swap(false)), e)).toThrow(/buyToken/);
    const sweep = encodeFunctionData({
      abi: agentAccountAbi,
      functionName: 'sweepToOwner',
      args: [TOKEN, 7n],
    });
    const w: BuildExpectation = {
      chainId: 5042002,
      account: ACCOUNT,
      functionName: 'sweepToOwner',
      exact: { token: TOKEN, amount: 7n },
    };
    expect(verifyBuiltTx(built(sweep), w).functionName).toBe('sweepToOwner');
    expect(() => verifyBuiltTx(built(sweep), { ...w, exact: { token: TOKEN } })).toThrow(
      /amount of sweepToOwner/,
    );
    expect(() =>
      verifyBuiltTx(built(sweep), { ...w, exact: { token: TOKEN, amount: 8n } }),
    ).toThrow(/amount/);
  });

  it('requires all eight launch fields', () => {
    for (const k of Object.keys(LAUNCH_EXACT)) {
      const { [k]: _drop, ...rest } = LAUNCH_EXACT as Record<string, unknown>;
      expect(() =>
        verifyBuiltTx(built(launch(1_000n)), {
          chainId: 5042002,
          account: ACCOUNT,
          functionName: 'launch',
          exact: rest,
          deadline: expectation.deadline,
        }),
      ).toThrow(new RegExp(`${k} of launch is not covered`));
    }
    expect(() =>
      verifyBuiltTx(built(launch(1_000n)), {
        chainId: 5042002,
        account: ACCOUNT,
        functionName: 'launch',
        exact: LAUNCH_EXACT,
      }),
    ).toThrow(/deadline of launch is not covered/);
    for (const [k, v] of [
      ['metadataURI', 'https://evil.example/x'],
      ['salt', `0x${'99'.repeat(32)}`],
      ['initialBuyUsdc', 5n],
    ] as const) {
      expect(() =>
        verifyBuiltTx(built(launch(1_000n)), {
          chainId: 5042002,
          account: ACCOUNT,
          functionName: 'launch',
          exact: { ...LAUNCH_EXACT, [k]: v },
          deadline: expectation.deadline,
        }),
      ).toThrow(new RegExp(k));
    }
  });

  it('validates its own inputs: atLeast only for min…Out, a sane window', () => {
    expect(() => verifyBuiltTx(built(), { ...expectation, atLeast: { usdcIn: 1n } })).toThrow(
      InvalidInputError,
    );
    expect(() =>
      verifyBuiltTx(built(), { ...expectation, deadline: { min: 5n, max: 1n } }),
    ).toThrow(InvalidInputError);
  });

  it.each([undefined, null, '', 'abc', -1n, 5, '5'])(
    'rejects a non-bigint or negative atLeast value: %s',
    (v) => {
      expect(() =>
        verifyBuiltTx(built(), { ...expectation, atLeast: { minTokensOut: v as never } }),
      ).toThrow(InvalidInputError);
    },
  );

  it.each([
    '',
    ' 25000000',
    '25000000 ',
    '-1',
    '0x10',
    'abc',
    false,
    [],
    null,
    undefined,
    25_000_000,
    1.5,
  ])('rejects a bad numeric exact value: %j', (v) => {
    expect(() =>
      verifyBuiltTx(built(), { ...expectation, exact: { token: TOKEN, usdcIn: v } }),
    ).toThrow(InvalidInputError);
  });

  it('accepts a decimal string for a numeric exact value', () => {
    expect(
      verifyBuiltTx(built(), { ...expectation, exact: { token: TOKEN, usdcIn: '25000000' } })
        .functionName,
    ).toBe('buy');
    expect(() =>
      verifyBuiltTx(built(), { ...expectation, exact: { token: TOKEN, usdcIn: '25000001' } }),
    ).toThrow(BuildMismatchError);
  });

  it('reads each expectation field once: a getter that changes between reads cannot split validation from comparison', () => {
    const reads = { exact: 0, atLeast: 0, deadline: 0, usdcIn: 0 };
    const exact = {
      token: TOKEN,
      get usdcIn() {
        return reads.usdcIn++ === 0 ? 25_000_000n : 1n;
      },
    };
    const e = {
      chainId: 5042002,
      account: ACCOUNT,
      functionName: 'buy' as const,
      get exact() {
        reads.exact++;
        return exact;
      },
      get atLeast() {
        reads.atLeast++;
        return { minTokensOut: 980n * WAD };
      },
      get deadline() {
        reads.deadline++;
        return { min: 900n, max: 1_100n };
      },
    } as BuildExpectation;
    expect(verifyBuiltTx(built(), e).functionName).toBe('buy');
    expect(reads).toEqual({ exact: 1, atLeast: 1, deadline: 1, usdcIn: 1 });
  });
});
