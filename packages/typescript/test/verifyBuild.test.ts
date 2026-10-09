import { concat, encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { verifyBuiltTx, type BuildExpectation } from '../src/api/verifyBuild.js';
import { BuildMismatchError } from '../src/errors.js';
import { DEFAULT_POLICY } from '../src/policy.js';

const ACCOUNT: Address = '0x00000000000000000000000000000000000000aa';
const TOKEN: Address = '0x00000000000000000000000000000000000000bb';
const WAD = 10n ** 18n;
const buy = (minOut = 980n * WAD, deadline = 1_000n) =>
  encodeFunctionData({ abi: agentAccountAbi, functionName: 'buy', args: [TOKEN, 25_000_000n, minOut, deadline] });
const launch = (deadline: bigint) =>
  encodeFunctionData({
    abi: agentAccountAbi, functionName: 'launch',
    args: [{
      name: 'Robo', symbol: 'ROBO', metadataURI: 'https://x.example/m/ab.json', salt: `0x${'11'.repeat(32)}`,
      expectedConfigHash: `0x${'22'.repeat(32)}`, initialBuyUsdc: 0n, minTokensOut: 0n, deadline,
    }],
  } as never);
const expectation: BuildExpectation = {
  chainId: 5042002, account: ACCOUNT, functionName: 'buy',
  exact: { token: TOKEN, usdcIn: 25_000_000n }, atLeast: { minTokensOut: 980n * WAD }, deadline: { min: 900n, max: 1_100n },
};
const built = (data: Hex = buy(), over: Partial<{ chainId: number; to: Address; value: string; selector: Hex }> = {}) =>
  ({ chainId: 5042002, to: ACCOUNT, data, value: '0', ...over });

describe('verifyBuiltTx', () => {
  it('accepts calldata that matches the request, with or without the server selector', () => {
    expect(verifyBuiltTx(built(), expectation).args).toMatchObject({ token: TOKEN, usdcIn: 25_000_000n });
    expect(verifyBuiltTx(built(buy(), { selector: buy().slice(0, 10) as Hex }), expectation).functionName).toBe('buy');
  });

  it('flattens the launch request and checks its deadline window', () => {
    const e: BuildExpectation = { chainId: 5042002, account: ACCOUNT, functionName: 'launch', exact: { symbol: 'ROBO' }, deadline: { min: 900n, max: 1_100n } };
    expect(verifyBuiltTx(built(launch(1_000n)), e).args).toMatchObject({ name: 'Robo', symbol: 'ROBO', deadline: 1_000n });
    expect(() => verifyBuiltTx(built(launch(5_000n)), e)).toThrow(/deadline/);
  });

  it.each([
    ['another target', built(buy(), { to: '0x00000000000000000000000000000000000000cc' }), /target/],
    ['another chain', built(buy(), { chainId: 5042 }), /chain/],
    ['value attached', built(buy(), { value: '1' }), /value/],
    ['a selector that disagrees with the calldata', built(buy(), { selector: '0xdeadbeef' }), /selector/],
    ['a lowered minimum', built(buy(979n * WAD)), /minTokensOut/],
    ['a far deadline', built(buy(980n * WAD, 5_000n)), /deadline/],
    ['trailing bytes', built(concat([buy(), '0xdeadbeef'])), /trailing/],
    ['an owner function of the account', built(encodeFunctionData({ abi: agentAccountAbi, functionName: 'withdraw', args: [TOKEN, 1n] })), /not an agent trade function/],
    ['a policy registry call', built(encodeFunctionData({ abi: agentPolicyRegistryAbi, functionName: 'setPolicy', args: [ACCOUNT, DEFAULT_POLICY] } as never)), /does not decode against AgentAccount/],
  ])('refuses %s', (_name, b, pattern) => {
    expect(() => verifyBuiltTx(b, expectation)).toThrow(BuildMismatchError);
    expect(() => verifyBuiltTx(b, expectation)).toThrow(pattern);
  });

  it('refuses a deadline expectation on a function that takes none', () => {
    const claim = encodeFunctionData({ abi: agentAccountAbi, functionName: 'claimFees', args: [] });
    expect(() => verifyBuiltTx(built(claim), { chainId: 5042002, account: ACCOUNT, functionName: 'claimFees', deadline: { min: 1n, max: 2n } })).toThrow(/no deadline/);
    expect(verifyBuiltTx(built(claim), { chainId: 5042002, account: ACCOUNT, functionName: 'claimFees' }).functionName).toBe('claimFees');
  });

  it('compares addresses case-insensitively without throwing on a bad checksum, and refuses names the function lacks', () => {
    const mixed = `0x00000000000000000000000000000000000000Bb` as Address;
    expect(verifyBuiltTx(built(buy(), { to: '0x00000000000000000000000000000000000000AA' }), { ...expectation, exact: { token: mixed, usdcIn: 25_000_000n } }).functionName).toBe('buy');
    expect(() => verifyBuiltTx(built(), { ...expectation, exact: { nope: 1n } })).toThrow(/no argument nope/);
    expect(() => verifyBuiltTx(built(), { ...expectation, atLeast: { token: 1n } })).toThrow(/no numeric argument/);
    expect(() => verifyBuiltTx(built(), { ...expectation, functionName: 'sell' })).toThrow(/built buy, asked for sell/);
    expect(() => verifyBuiltTx(built(), { ...expectation, functionName: 'withdraw' as never })).toThrow(/not an agent trade function/);
    expect(() => verifyBuiltTx(built(buy(), { value: '-1' }), expectation)).toThrow(BuildMismatchError);
    expect(() => verifyBuiltTx({ ...built(), data: '0x12' as Hex }, expectation)).toThrow(BuildMismatchError);
  });

  it('pins the launch config hash and refuses a changed one', () => {
    const e: BuildExpectation = { chainId: 5042002, account: ACCOUNT, functionName: 'launch', exact: { expectedConfigHash: `0x${'22'.repeat(32)}` }, deadline: { min: 900n, max: 1_100n } };
    expect(verifyBuiltTx(built(launch(1_000n)), e).functionName).toBe('launch');
    expect(() => verifyBuiltTx(built(launch(1_000n)), { ...e, exact: { expectedConfigHash: `0x${'33'.repeat(32)}` } })).toThrow(/expectedConfigHash/);
  });
});
