import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, parseTransaction, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { metadataUriProblem } from '../src/agent.js';
import { estimatePoolImpactBps } from '../src/pool.js';
import { agentAccountAbi, agentAccountFactoryAbi, graduationManagerAbi, launchFactoryAbi, v4QuoterAbi } from '../src/abi/index.js';
import type { MercurifiApi } from '../src/api/types.js';
import { BuildMismatchError, InvalidInputError, MercurifiError } from '../src/errors.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { ContractRevertError } from '../src/revert.js';
import { localKey } from '../src/signers.js';
import { agentActionLog, eventLog, FACTORY, LAUNCH_FACTORY, mockAccount, mockCurve, type AccountMockOptions, type CurveMockOptions } from './helpers/account.js';
import { A, ACCOUNT, AGENT_KEY, CURVE, localClient, localRpc, TOKEN } from './helpers/local.js';

const signer = localKey(AGENT_KEY);
const WAD = 10n ** 18n;
const SALT = `0x${'cd'.repeat(32)}` as Hex;
const HASH = `0x${'92'.repeat(32)}` as Hex;
const USDC = '0x3600000000000000000000000000000000000000';
const ZERO = '0x0000000000000000000000000000000000000000';
const CONFIG = {
  virtualUsdc: 6_000n * WAD, virtualTokens: 1_066_666_666_666_666_666_666_666_666n, curveSupply: 800_000_000n * WAD, poolSupply: 200_000_000n * WAD,
  launchFee: WAD, maxInitialBuyTokens: 50_000_000n * WAD, tradeFeeBps: 100, creatorShareBps: 5_000, referrerShareBps: 2_000, snipeStartBps: 9_900, snipeBlocks: 120,
};
const poolKey = { currency0: TOKEN, currency1: USDC, fee: 0, tickSpacing: 60, hooks: A(4) };
const refused = async (run: Promise<unknown>, name: string) => {
  const err = (await run.catch((e: unknown) => e)) as ContractRevertError;
  expect(err).toBeInstanceOf(ContractRevertError);
  expect(err.revert.name).toBe(name);
  expect(err.phase).toBe('local');
  return err;
};

const setup = async (curve: CurveMockOptions = {}, api: MercurifiApi | null = null, action = 3, account: Partial<AccountMockOptions> = {}) => {
  const rpc = localRpc();
  mockAccount(rpc, { owner: A(0x99), agent: signer.address, ...account });
  mockCurve(rpc, curve);
  rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'config', CONFIG);
  rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'configHash', HASH);
  rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'paused', false);
  for (const fn of ['launch', 'claimFees', 'sweepToOwner', 'swapExactIn']) rpc.read(ACCOUNT, agentAccountAbi, fn, fn === 'launch' ? [TOKEN, CURVE] : fn === 'sweepToOwner' ? undefined : 0n);
  rpc.receiptLogs = [
    agentActionLog({ agent: signer.address, action, token: TOKEN, usdcSpent: 11_000_000n, tokenDelta: 1_757_100n * WAD, periodId: 19_637n }),
    eventLog(launchFactoryAbi, LAUNCH_FACTORY, 'TokenCreated', { token: TOKEN, curve: CURVE, creator: ACCOUNT }),
  ];
  const mf = await localClient(rpc, { api });
  return { rpc, agent: await mf.agent({ account: ACCOUNT, signer, slippage: 0.02 }) };
};
const sentCall = (rpc: { sent: Hex[] }) => decodeFunctionData({ abi: agentAccountAbi, data: parseTransaction(rpc.sent[0]!).data! });
const big = { ...DEFAULT_POLICY, maxTradeUsdc: 1_000_000_000n, periodSpendCap: 5_000_000_000n, perTokenPeriodCap: 2_000_000_000n };

describe('AgentClient.launch', () => {
  it.each(['0x12', `0x${'zz'.repeat(32)}`, '11'.repeat(32), `0x${'11'.repeat(33)}`, '', 5])('refuses a malformed salt: %j', async (bad) => {
    const { rpc, agent } = await setup();
    await expect(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', salt: bad as never })).rejects.toThrow(InvalidInputError);
    expect(rpc.sent).toEqual([]);
  });

  it('pins the config hash, quotes the initial buy exactly, sets a chain-time deadline and returns the new token', async () => {
    const { rpc, agent } = await setup();
    const fill = await agent.launch({ name: 'Example', symbol: 'EX', metadataURI: 'ipfs://m', initialBuyUsdc: '10', salt: SALT });
    const { functionName, args } = sentCall(rpc);
    expect(functionName).toBe('launch');
    expect(args![0]).toEqual({
      name: 'Example', symbol: 'EX', metadataURI: 'ipfs://m', salt: SALT, expectedConfigHash: HASH,
      initialBuyUsdc: 10_000_000n, minTokensOut: 1_757_100_783_706_883_641_990_715n, deadline: rpc.block.timestamp + 60n,
    });
    expect(fill.action).toBe('launch');
    expect(fill.launched).toEqual({ token: TOKEN, curve: CURVE });
  });

  it('checks byte lengths, the trade cap, the initial-buy cap and the period caps before signing', async () => {
    const { rpc, agent } = await setup();
    await expect(agent.launch({ name: 'é'.repeat(17), symbol: 'EX', metadataURI: '' })).rejects.toThrow(/1–32 bytes/);
    await expect(agent.launch({ name: 'Ok', symbol: 'TOOLONGSYMB', metadataURI: '' })).rejects.toThrow(/1–10 bytes/);
    await expect(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: `https://${'x'.repeat(250)}` })).rejects.toThrow(/longer than 256 bytes/);
    // The account checks maxTradeUsdc (initial buy + fee) before the factory checks maxInitialBuyTokens.
    await refused(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '100' }), 'TradeTooLarge');
    await refused(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '10000' }), 'TradeTooLarge');
    const roomy = await setup({}, null, 3, { policy: big });
    await refused(roomy.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '900' }), 'InitialBuyTooLarge');
    const spent = await setup({}, null, 3, { headroom: [5_000_000n, 500_000_000n, 499, 3] });
    expect((await refused(spent.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '10' }), 'PeriodSpendExceeded')).revert.args).toEqual([5_000_000n]);
    const none = await setup({}, null, 3, { headroom: [400_000_000n, 500_000_000n, 499, 0] });
    await refused(none.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' }), 'LaunchLimit');
    expect(rpc.sent.length + roomy.rpc.sent.length + spent.rpc.sent.length + none.rpc.sent.length).toBe(0);
  });

  it('reports LaunchLimit first when a launch is also over maxTradeUsdc and the spend cap (registry preamble order)', async () => {
    const both = await setup({}, null, 3, { headroom: [5_000_000n, 500_000_000n, 499, 0] });
    await refused(both.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '10000' }), 'LaunchLimit');
    // ActionLimit still comes before it.
    const neither = await setup({}, null, 3, { headroom: [5_000_000n, 500_000_000n, 0, 0] });
    await refused(neither.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc: '10000' }), 'ActionLimit');
    expect(both.rpc.sent.length + neither.rpc.sent.length).toBe(0);
  });

  it('refuses a launch the agent may not do, while paused, or while Launch is paused', async () => {
    await refused((await setup({}, null, 3, { agentPermissions: 1 })).agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' }), 'MissingPermission');
    const paused = await setup();
    paused.rpc.read(FACTORY, agentAccountFactoryAbi, 'isPaused', true);
    await refused(paused.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' }), 'Paused');
    const launchPaused = await setup();
    launchPaused.rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'paused', true);
    await refused(launchPaused.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' }), 'EnforcedPause');
  });

  it('uploads metadata through the API, or refuses chain-only', async () => {
    const chainOnly = await setup();
    await expect(chainOnly.agent.launch({ name: 'Ok', symbol: 'OK', description: 'hello' })).rejects.toThrow(InvalidInputError);
    expect(chainOnly.rpc.sent).toHaveLength(0);
    const upload = vi.fn(async () => ({ metadataURI: 'https://api.example/v1/metadata/abc', imageStatus: null }));
    const withApi = await setup({}, { uploadLaunchMetadata: upload } as unknown as MercurifiApi);
    const image = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' as const };
    await withApi.agent.launch({ name: 'Ok', symbol: 'OK', description: 'hello', links: { x: 'https://x.com/ok' }, image });
    expect(upload).toHaveBeenCalledWith({ description: 'hello', links: { x: 'https://x.com/ok' } }, image);
    expect((sentCall(withApi.rpc).args![0] as { metadataURI: string }).metadataURI).toBe('https://api.example/v1/metadata/abc');
    await expect(withApi.agent.launch({ name: 'Ok', symbol: 'OK', description: 'hello', metadataURI: 'ipfs://m' })).rejects.toThrow(/either metadataURI or/);
  });

  it('does not upload when a check would refuse the launch', async () => {
    const upload = vi.fn(async () => ({ metadataURI: 'https://api.example/v1/metadata/abc', imageStatus: null }));
    const { agent } = await setup({}, { uploadLaunchMetadata: upload } as unknown as MercurifiApi);
    await refused(agent.launch({ name: 'Ok', symbol: 'OK', description: 'hello', initialBuyUsdc: '100' }), 'TradeTooLarge');
    expect(upload).not.toHaveBeenCalled();
  });

  it('fails the fill when the receipt has no TokenCreated for the launched token from this account', async () => {
    const { rpc, agent } = await setup();
    rpc.receiptLogs = [rpc.receiptLogs[0]!, eventLog(launchFactoryAbi, LAUNCH_FACTORY, 'TokenCreated', { token: TOKEN, curve: CURVE, creator: A(0x55) })];
    await expect(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' })).rejects.toMatchObject({ code: 'FILL_NOT_FOUND' });
  });
});

describe('AgentClient pool swaps', () => {
  const quoter = (rpc: Awaited<ReturnType<typeof setup>>['rpc'], f: (args: { zeroForOne: boolean; exactAmount: bigint }) => bigint) => {
    rpc.read(A(3), graduationManagerAbi, 'poolKey', poolKey);
    rpc.read(A(8), v4QuoterAbi, 'quoteExactInputSingle', (args) => [f(args[0] as { zeroForOne: boolean; exactAmount: bigint }), 120_000n]);
  };
  const warnings = async (curve: CurveMockOptions, account: Partial<AccountMockOptions> = {}) => {
    const rpc = localRpc();
    mockAccount(rpc, { owner: A(0x99), agent: signer.address, ...account });
    mockCurve(rpc, curve);
    rpc.receiptLogs = [agentActionLog({ agent: signer.address, action: 4, token: TOKEN, usdcSpent: 10_000_000n, tokenDelta: 5n * WAD, periodId: 1n })];
    rpc.read(ACCOUNT, agentAccountAbi, 'swapExactIn', 0n);
    const seen: string[] = [];
    const mf = await localClient(rpc, { onWarning: (m) => seen.push(m) });
    return { rpc, seen, agent: await mf.agent({ account: ACCOUNT, signer, slippage: 0.02 }) };
  };

  it('swaps a graduated token through the derived LaunchHook pool', async () => {
    const { rpc, agent } = await setup({ phase: 2 }, null, 4);
    rpc.read(A(3), graduationManagerAbi, 'poolKey', poolKey);
    rpc.read(A(8), v4QuoterAbi, 'quoteExactInputSingle', (args) => {
      const p = args[0] as { zeroForOne: boolean; exactAmount: bigint };
      expect(p.zeroForOne).toBe(false);
      return [p.exactAmount === 10_000_000n ? 5_000n * WAD : 5n * WAD, 120_000n];
    });
    const fill = await agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '10' });
    expect(sentCall(rpc).args).toEqual([TOKEN, true, 10_000_000n, 4_900n * WAD, rpc.block.timestamp + 60n]);
    expect(fill.action).toBe('poolBuy');
  });

  it('refuses a pool not hooked by LaunchHook, a wrong pair, and a token still on its curve', async () => {
    const { rpc, agent } = await setup({ phase: 2 });
    rpc.read(A(3), graduationManagerAbi, 'poolKey', { ...poolKey, hooks: A(0x666) });
    await expect(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1' })).rejects.toThrow(/LaunchHook/);
    rpc.read(A(3), graduationManagerAbi, 'poolKey', { ...poolKey, currency1: A(0x777) });
    await expect(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1' })).rejects.toMatchObject({ code: 'POOL_KEY_MISMATCH' });
    const trading = await setup({ phase: 0 });
    await refused(trading.agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1' }), 'NotGraduated');
    expect(rpc.sent.length + trading.rpc.sent.length).toBe(0);
  });

  it('applies the allowlist to buys only', async () => {
    const listed = await setup({ phase: 2, balance: 5n * WAD }, null, 4, { policy: { ...DEFAULT_POLICY, allowlistOnly: true } });
    quoter(listed.rpc, ({ zeroForOne }) => (zeroForOne ? 1_000_000n : 5n * WAD));
    await refused(listed.agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1' }), 'TokenNotAllowed');
    await listed.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: WAD });
    expect(listed.rpc.sent).toHaveLength(1);
  });

  it('refuses a pool buy above maxTradeUsdc, the spend headroom and the per-token cap locally', async () => {
    const { rpc, agent } = await setup({ phase: 2 }, null, 4);
    quoter(rpc, () => 5_000n * WAD);
    await refused(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '150' }), 'TradeTooLarge');
    const low = await setup({ phase: 2 }, null, 4, { headroom: [5_000_000n, 500_000_000n, 499, 3] });
    quoter(low.rpc, () => 5_000n * WAD);
    expect((await refused(low.agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '10' }), 'PeriodSpendExceeded')).revert.args).toEqual([5_000_000n]);
    expect(rpc.sent.length + low.rpc.sent.length).toBe(0);
  });

  it('requires a positive amount and refuses amounts above uint128', async () => {
    const { rpc, agent } = await setup({ phase: 2 }, null, 4);
    quoter(rpc, () => 5n * WAD);
    await expect(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '0' })).rejects.toThrow(/above zero/);
    await refused(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc6: 1n << 128n }), 'AmountTooLarge');
    await expect(agent.swapExactIn({ token: TOKEN, side: 'sell', amount: 'all' })).rejects.toThrow(/holds none/);
    await expect(agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1', amount: '1' })).rejects.toThrow(InvalidInputError);
    expect(rpc.sent).toHaveLength(0);
  });

  it('values a pool sell at the high-water cost before it even quotes, and refuses above maxTradeUsdc', async () => {
    // Recorded 2,000 tokens at the 0.1 USDC high-water = 200 USDC, above the 100 USDC per-trade limit (the 20 USDC average does not count).
    const { rpc, agent } = await setup({ phase: 2, balance: 11_000n * WAD }, null, 5, { basis: [110_000_000n, 11_000n * WAD, 10n ** 23n] });
    rpc.read(A(3), graduationManagerAbi, 'poolKey', poolKey);
    const err = await refused(agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 2_000n * WAD }), 'TradeTooLarge');
    expect(err.revert.args).toEqual([100_000_000n]);
    expect(rpc.methods('eth_call').filter((c) => (c[0] as { to: string }).to.toLowerCase() === A(8).toLowerCase())).toHaveLength(0);
    expect(rpc.sent).toHaveLength(0);
  });

  it('adds the excess share of the quoted proceeds to a pool sell and checks the sell headroom', async () => {
    // 500 recorded tokens cost 50 USDC at the high-water; 300 excess tokens carry 300/800 of 120 USDC proceeds = 45 -> 95 total.
    const basis = [50_000_000n, 500n * WAD, 10n ** 23n] as const;
    const fits = await setup({ phase: 2, balance: 800n * WAD }, null, 5, { basis });
    quoter(fits.rpc, () => 120_000_000n);
    await fits.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 800n * WAD });
    expect(sentCall(fits.rpc).args).toEqual([TOKEN, false, 800n * WAD, 117_600_000n, fits.rpc.block.timestamp + 60n]);
    const over = await setup({ phase: 2, balance: 800n * WAD }, null, 5, { basis });
    quoter(over.rpc, () => 200_000_000n); // 50 + 75 = 125 > 100
    await refused(over.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 800n * WAD }), 'TradeTooLarge');
    const short = await setup({ phase: 2, balance: 800n * WAD }, null, 5, { basis, headroom: [400_000_000n, 90_000_000n, 499, 3] });
    quoter(short.rpc, () => 120_000_000n);
    expect((await refused(short.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 800n * WAD }), 'PeriodSellExceeded')).revert.args).toEqual([90_000_000n]);
    expect(over.rpc.sent.length + short.rpc.sent.length).toBe(0);
  });

  it('sells into the pool with a usdc6 minimum when the value fits, and never sends a zero minimum', async () => {
    const { rpc, agent } = await setup({ phase: 2, balance: 500n * WAD }, null, 5, { basis: [110_000_000n, 11_000n * WAD, 10n ** 23n] });
    quoter(rpc, () => 50_000_000n);
    await agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 500n * WAD });
    expect(sentCall(rpc).args).toEqual([TOKEN, false, 500n * WAD, 49_000_000n, rpc.block.timestamp + 60n]);
    const dust = await setup({ phase: 2, balance: 5n * WAD }, null, 5);
    quoter(dust.rpc, () => 1n);
    await dust.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 5n * WAD });
    expect(sentCall(dust.rpc).args![3]).toBe(1n);
    const none = await setup({ phase: 2, balance: 5n * WAD }, null, 5);
    quoter(none.rpc, () => 0n);
    await expect(none.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 5n * WAD })).rejects.toThrow(/below 1 micro-USDC/);
    expect(none.rpc.sent).toHaveLength(0);
  });

  it('refuses a sell larger than the balance with a plain message, before valuing it', async () => {
    const { rpc, agent } = await setup({ phase: 2, balance: WAD }, null, 5);
    quoter(rpc, () => 1_000n);
    await expect(agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 2n * WAD })).rejects.toThrow(/holds less/);
  });

  it('warns when the quoted price impact is above the policy, and stays quiet when it is small', async () => {
    // Constant product with 1,000 USDC of reserve: out(a) = a * R / (R + a) -> a 100 USDC buy moves the price by about 21%.
    const R = 1_000_000_000n;
    const heavy = await warnings({ phase: 2 }, { policy: { ...DEFAULT_POLICY, maxPriceImpactBps: 300 } });
    quoter(heavy.rpc, ({ exactAmount }) => (exactAmount * R * WAD) / (R + exactAmount) / 1_000_000n);
    await heavy.agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '100' });
    expect(heavy.seen.join(' ')).toMatch(/move the pool price by about 2\d{3} bps/);
    expect(heavy.rpc.sent).toHaveLength(1);
    const light = await warnings({ phase: 2 });
    quoter(light.rpc, ({ exactAmount }) => (exactAmount * (100n * R) * WAD) / (100n * R + exactAmount) / 1_000_000n);
    await light.agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '10' });
    expect(light.seen).toEqual([]);
  });
});

describe('AgentClient claims and sweeps', () => {
  it('claims fees without a deadline', async () => {
    const { rpc, agent } = await setup({}, null, 6);
    const fill = await agent.claimFees();
    expect(sentCall(rpc).functionName).toBe('claimFees');
    expect(sentCall(rpc).args).toBeUndefined();
    expect(fill.action).toBe('claim');
  });

  it('sweeps native USDC in wei to the owner, or all of it', async () => {
    const { rpc, agent } = await setup({}, null, 7);
    await agent.sweepToOwner({ usdc: '2' });
    expect(sentCall(rpc).args).toEqual([ZERO, 2n * WAD]);
    const all = await setup({}, null, 7);
    await all.agent.sweepToOwner({ all: true });
    expect(sentCall(all.rpc).args).toEqual([ZERO, 1_000n * WAD]);
    await expect(agent.sweepToOwner({ all: true, usdc: '1' })).rejects.toThrow(/cannot be combined/);
    await expect(agent.sweepToOwner({ usdc: '0' })).rejects.toThrow(/Nothing to sweep/);
  });

  it('sweeps only registered Launch tokens, all or an amount', async () => {
    const { rpc, agent } = await setup({ balance: 7n * WAD }, null, 7);
    await refused(agent.sweepToOwner({ token: A(0xdd), amount: '1' }), 'TokenNotRegistered');
    await agent.sweepToOwner({ token: TOKEN, amount: 'all' });
    expect(sentCall(rpc).args).toEqual([TOKEN, 7n * WAD]);
    const some = await setup({ balance: 7n * WAD }, null, 7);
    await some.agent.sweepToOwner({ token: TOKEN, amount: '2.5' });
    expect(sentCall(some.rpc).args).toEqual([TOKEN, 25n * WAD / 10n]);
    const empty = await setup({ balance: 0n }, null, 7);
    await expect(empty.agent.sweepToOwner({ token: TOKEN, all: true })).rejects.toThrow(/Nothing to sweep/);
    await expect(agent.sweepToOwner({ token: TOKEN, usdc: '1' })).rejects.toThrow(InvalidInputError);
  });

  it('checks the claim and sweep permissions and the pause locally', async () => {
    await refused((await setup({}, null, 6, { agentPermissions: 1 })).agent.claimFees(), 'MissingPermission');
    await refused((await setup({}, null, 7, { agentPermissions: 1 })).agent.sweepToOwner({ usdc: '1' }), 'MissingPermission');
    const paused = await setup({}, null, 6);
    paused.rpc.read(FACTORY, agentAccountFactoryAbi, 'isPaused', true);
    await refused(paused.agent.claimFees(), 'Paused');
  });
});

describe('metadata URI validation, expiry margin, ordering and balances', () => {
  const bad = ['', 'javascript:alert(1)', 'data:text/plain;base64,AAAA', 'http://insecure.example/m', 'https://exa\u202Emple/m', 'https://a b/m', `https://${'x'.repeat(249)}`, 'https://user:pass@example.com/m.json', 'ipfs://tok@host/m', `https://x.example/${'é'.repeat(120)}`];
  const launchWith = async (uri: unknown) => {
    const upload = vi.fn(async () => ({ metadataURI: uri as string, imageStatus: null }));
    const t = await setup({}, { uploadLaunchMetadata: upload } as unknown as MercurifiApi);
    return { ...t, run: t.agent.launch({ name: 'Ok', symbol: 'OK', description: 'hi' }) };
  };

  it.each([undefined, ...bad])('treats an uploaded URI as untrusted: %j', async (uri) => {
    const t = await launchWith(uri);
    const err = await t.run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MercurifiError);
    expect((err as MercurifiError).code).toBe('API_BAD_RESPONSE');
    for (const secret of ['javascript', 'alert', 'insecure', 'user:pass', 'pass@', 'tok@', 'exa', 'x'.repeat(20), 'é']) expect(String((err as Error).message)).not.toContain(secret);
    expect(t.rpc.sent).toHaveLength(0);
  });

  it('counts bytes, not characters, at the 256-byte boundary', async () => {
    expect(new TextEncoder().encode(`https://x.example/${'é'.repeat(119)}`).length).toBe(256);
    expect(new TextEncoder().encode(`https://x.example/${'é'.repeat(120)}`).length).toBe(258);
    const { agent, rpc } = await setup();
    await agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: `https://x.example/${'é'.repeat(119)}` });
    expect(rpc.sent).toHaveLength(1);
    await expect(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: `https://x.example/${'é'.repeat(120)}` })).rejects.toThrow(/longer than 256 bytes/);
  });

  it('warns when the user supplies an empty metadataURI', async () => {
    const rpc = localRpc();
    mockAccount(rpc, { owner: A(0x99), agent: signer.address });
    mockCurve(rpc, {});
    rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'config', CONFIG);
    rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'configHash', HASH);
    rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'paused', false);
    rpc.read(ACCOUNT, agentAccountAbi, 'launch', [TOKEN, CURVE]);
    rpc.receiptLogs = [
      agentActionLog({ agent: signer.address, action: 3, token: TOKEN, usdcSpent: 11_000_000n, tokenDelta: 1n * WAD, periodId: 19_637n }),
      eventLog(launchFactoryAbi, LAUNCH_FACTORY, 'TokenCreated', { token: TOKEN, curve: CURVE, creator: ACCOUNT }),
    ];
    const seen: string[] = [];
    const mf = await localClient(rpc, { onWarning: (m) => seen.push(m) });
    const agent = await mf.agent({ account: ACCOUNT, signer });
    await agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' });
    expect(seen.some((m) => /hidden from the .*board/.test(m))).toBe(true);
  });

  it('accepts https and ipfs URIs at the byte limit, and rejects bad user-supplied ones', async () => {
    const ok = await launchWith(`ipfs://${'x'.repeat(249)}`);
    await ok.run;
    expect(ok.rpc.sent).toHaveLength(1);
    const { agent, rpc } = await setup();
    for (const uri of bad.slice(1).filter((u) => u !== `https://x.example/${'é'.repeat(120)}`)) await expect(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: uri })).rejects.toThrow(InvalidInputError);
    await agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: 'https://example.com/m.json' });
    expect(rpc.sent).toHaveLength(1);
  });

  it('refuses a key that expires before the transaction can land (latest + 1 >= expiresAt)', async () => {
    const soon = await setup({}, null, 3, { agentExpiresAt: 1_700_000_001 });
    await refused(soon.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' }), 'AgentExpired');
    const fine = await setup({}, null, 3, { agentExpiresAt: 1_700_000_002 });
    await fine.agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '' });
    expect(fine.rpc.sent).toHaveLength(1);
  });

  it('checks TradeTooLarge before AmountTooLarge on a launch', async () => {
    const { agent } = await setup();
    await refused(agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: '', initialBuyUsdc6: 1n << 250n }), 'TradeTooLarge');
  });

  it('estimates a falling price as 1 - 1/k^2 when selling token0', async () => {
    const t = await setup({ phase: 2 });
    const R = 1_000n * WAD;
    t.rpc.read(A(8), v4QuoterAbi, 'quoteExactInputSingle', (args) => {
      const a = (args[0] as { exactAmount: bigint }).exactAmount;
      return [(a * R) / (R + a), 0n];
    });
    const mf = await localClient(t.rpc);
    const key = { currency0: TOKEN, currency1: USDC, fee: 0, tickSpacing: 60, hooks: A(4) } as const;
    const amountIn = 500n * WAD; // x = 0.5 of the reserve: the sqrt price moves by 1/1.5, the price by 1 - 1/2.25
    const out = (amountIn * R) / (R + amountIn);
    const down = await estimatePoolImpactBps(mf.publicClient, mf.network, key, true, amountIn, out, ACCOUNT);
    expect(Number(down)).toBeGreaterThan(5_400);
    expect(Number(down)).toBeLessThan(5_600);
    const up = await estimatePoolImpactBps(mf.publicClient, mf.network, key, false, amountIn, out, ACCOUNT);
    expect(Number(up)).toBeGreaterThan(12_000);
  });

  it('checks explicit amounts against the balance first, with a plain message', async () => {
    const basis = [110_000_000n, 11_000n * WAD, 10n ** 23n] as const;
    const pool = await setup({ phase: 2, balance: WAD }, null, 5, { basis });
    pool.rpc.read(A(3), graduationManagerAbi, 'poolKey', poolKey);
    await expect(pool.agent.swapExactIn({ token: TOKEN, side: 'sell', amountWei: 2_000n * WAD })).rejects.toThrow(/holds less of this token/);
    const native = await setup({}, null, 7);
    await expect(native.agent.sweepToOwner({ usdc: '5000' })).rejects.toThrow(/holds 1000 USDC, less than/);
    const token = await setup({ balance: WAD }, null, 7);
    await expect(token.agent.sweepToOwner({ token: TOKEN, amount: '2' })).rejects.toThrow(/holds less of this token/);
    expect(pool.rpc.sent.length + native.rpc.sent.length + token.rpc.sent.length).toBe(0);
  });
});

describe('AgentClient.sendBuilt', () => {
  const claim = encodeFunctionData({ abi: agentAccountAbi, functionName: 'claimFees', args: [] });
  const buyData = (over: Partial<{ token: Hex; min: bigint; dl: bigint }> = {}, ts = 1_700_000_000n) =>
    encodeFunctionData({ abi: agentAccountAbi, functionName: 'buy', args: [over.token ?? TOKEN, 25_000_000n, over.min ?? 900n, over.dl ?? ts + 60n] } as never);
  const buyE = { functionName: 'buy' as const, exact: { token: TOKEN, usdcIn: 25_000_000n }, atLeast: { minTokensOut: 900n } };
  const LAUNCH_FIELDS = { name: 'Ok', symbol: 'OK', metadataURI: 'ipfs://m', salt: SALT, initialBuyUsdc: 0n, minTokensOut: 0n };
  const launchData = (over: Record<string, unknown> = {}, ts = 1_700_000_000n) =>
    encodeFunctionData({ abi: agentAccountAbi, functionName: 'launch', args: [{ ...LAUNCH_FIELDS, expectedConfigHash: HASH, deadline: ts + 60n, ...over }] } as never);
  const tx = (data: Hex) => ({ chainId: 31337, to: ACCOUNT, data, value: '0' });

  it('signs API-built calldata only after it verifies against the expectation', async () => {
    const { agent, rpc } = await setup();
    await expect(agent.sendBuilt({ ...tx(claim), to: A(0x77) }, { functionName: 'claimFees' })).rejects.toThrow(BuildMismatchError);
    await expect(agent.sendBuilt({ ...tx(claim), chainId: 5042002 }, { functionName: 'claimFees' })).rejects.toThrow(BuildMismatchError);
    await expect(agent.sendBuilt(tx(claim), { functionName: 'sweepToOwner' })).rejects.toThrow(BuildMismatchError);
    expect(rpc.sent).toHaveLength(0);
    await agent.sendBuilt(tx(claim), { functionName: 'claimFees' });
    expect(rpc.sent).toHaveLength(1);
    expect(sentCall(rpc).functionName).toBe('claimFees');
  });

  it('refuses a buy unless every argument is named and matches', async () => {
    const { agent, rpc } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'buy', 0n);
    const refusedBuy = (data: Hex, e: Parameters<typeof agent.sendBuilt>[1] = buyE) => expect(agent.sendBuilt(tx(data), e)).rejects.toThrow(BuildMismatchError);
    await refusedBuy(buyData(), { functionName: 'buy' });
    await refusedBuy(buyData({ min: 1n }));
    await refusedBuy(buyData({ token: A(0xcc) }));
    await refusedBuy(buyData({ dl: 1_700_000_000n + 61n }));
    await refusedBuy(buyData({ dl: 1_700_000_000n + 3_000n }), { ...buyE, deadline: { min: 0n, max: 9_999_999_999n } });
    expect(rpc.sent).toHaveLength(0);
  });

  it('signs a matching buy with the graduation gas floor', async () => {
    const { agent, rpc } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'buy', 0n);
    await agent.sendBuilt(tx(buyData()), buyE);
    expect(parseTransaction(rpc.sent[0]!).gas).toBe(1_800_000n);
  });

  it('flips buyToken on a swap: refused', async () => {
    const { agent, rpc } = await setup();
    const swap = encodeFunctionData({ abi: agentAccountAbi, functionName: 'swapExactIn', args: [TOKEN, false, 5n, 4n, 1_700_000_030n] });
    await expect(agent.sendBuilt(tx(swap), { functionName: 'swapExactIn', exact: { token: TOKEN, buyToken: true, amountIn: 5n }, atLeast: { minAmountOut: 4n } })).rejects.toThrow(/buyToken/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('launch: reads the chain configHash and its own deadline window; refuses missing or differing fields', async () => {
    const { agent, rpc } = await setup();
    const e = { functionName: 'launch' as const, exact: LAUNCH_FIELDS };
    await expect(agent.sendBuilt(tx(launchData()), { functionName: 'launch', exact: { name: 'Ok' } })).rejects.toThrow(/not covered/);
    await expect(agent.sendBuilt(tx(launchData({ expectedConfigHash: `0x${'55'.repeat(32)}` })), e)).rejects.toThrow(/expectedConfigHash/);
    await expect(agent.sendBuilt(tx(launchData()), { ...e, exact: { ...LAUNCH_FIELDS, expectedConfigHash: `0x${'55'.repeat(32)}` } })).rejects.toThrow(/configHash/);
    for (const over of [{ metadataURI: 'https://evil.example/x' }, { salt: `0x${'77'.repeat(32)}` }, { initialBuyUsdc: 1n }, { minTokensOut: 0n, deadline: 1_700_000_000n + 61n }]) {
      await expect(agent.sendBuilt(tx(launchData(over)), e)).rejects.toThrow(BuildMismatchError);
    }
    expect(rpc.sent).toHaveLength(0);
    await agent.sendBuilt(tx(launchData()), e);
    expect(rpc.sent).toHaveLength(1);
  });

  it('runs the local permission gate first', async () => {
    const { agent, rpc } = await setup({}, null, 3, { agentPermissions: 1 });
    await expect(agent.sendBuilt(tx(claim), { functionName: 'claimFees' })).rejects.toMatchObject({ revert: { name: 'MissingPermission' } });
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses a launch with a non-zero initial buy and a lowered minimum', async () => {
    const { agent, rpc } = await setup();
    const data = launchData({ initialBuyUsdc: 100_000_000n, minTokensOut: 1n });
    await expect(agent.sendBuilt(tx(data), { functionName: 'launch', exact: { ...LAUNCH_FIELDS, initialBuyUsdc: 10_000_000n } })).rejects.toThrow(/initialBuyUsdc/);
    await expect(agent.sendBuilt(tx(data), { functionName: 'launch', exact: { ...LAUNCH_FIELDS, initialBuyUsdc: 100_000_000n, minTokensOut: 5_000n } })).rejects.toThrow(/minTokensOut/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses inherited property names before any RPC call', async () => {
    const { agent, rpc } = await setup();
    const before = rpc.sent.length;
    await expect(agent.sendBuilt(tx(claim), { functionName: 'toString' as never })).rejects.toThrow(InvalidInputError);
    await expect(agent.sendBuilt(tx(claim), { functionName: 'constructor' as never })).rejects.toThrow(InvalidInputError);
    expect(rpc.sent.length).toBe(before);
  });

  it('refuses a zero-length deadline window before sending', async () => {
    const zeroPolicy = await setup({}, null, 3, { policy: { ...DEFAULT_POLICY, maxDeadlineSeconds: 0 } });
    await expect(zeroPolicy.agent.sendBuilt(tx(claim), { functionName: 'claimFees' })).rejects.toThrow(InvalidInputError);
    expect(zeroPolicy.rpc.sent).toHaveLength(0);
    const rpc = localRpc();
    mockAccount(rpc, { owner: A(0x99), agent: signer.address });
    const mf = await localClient(rpc);
    const agent = await mf.agent({ account: ACCOUNT, signer });
    (agent as unknown as { deadlineSeconds: number }).deadlineSeconds = 0;
    await expect(agent.sendBuilt(tx(claim), { functionName: 'claimFees' })).rejects.toThrow(InvalidInputError);
    expect(rpc.sent).toHaveLength(0);
  });
});

describe('metadataUriProblem: shared metadata vectors', () => {
  const mv = JSON.parse(readFileSync(new URL('../../../fixtures/vectors/metadata.json', import.meta.url), 'utf8')) as { cases: { uri: string; problem: string | null }[] };
  it.each(mv.cases)('%j', (c) => {
    expect(metadataUriProblem(c.uri)).toBe(c.problem);
  });
});
