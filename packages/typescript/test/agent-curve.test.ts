import {
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  parseTransaction,
  toFunctionSelector,
} from 'viem';
import { describe, expect, it } from 'vitest';

import {
  agentAccountAbi,
  agentAccountFactoryAbi,
  agentPolicyRegistryAbi,
  bondingCurveAbi,
} from '../src/abi/index.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { InvalidInputError } from '../src/errors.js';
import { ContractRevertError } from '../src/revert.js';
import { localKey } from '../src/signers.js';
import {
  agentActionLog,
  eventLog,
  FACTORY,
  mockAccount,
  mockCurve,
  type AccountMockOptions,
  type CurveMockOptions,
} from './helpers/account.js';
import {
  A,
  ACCOUNT,
  AGENT_KEY,
  CURVE,
  localClient,
  localRpc,
  REGISTRY,
  TOKEN,
} from './helpers/local.js';

const signer = localKey(AGENT_KEY);
const WAD = 10n ** 18n;

const setup = async (curve: CurveMockOptions = {}, account: Partial<AccountMockOptions> = {}) => {
  const rpc = localRpc();
  mockAccount(rpc, { owner: A(0x99), agent: signer.address, ...account });
  mockCurve(rpc, curve);
  rpc.read(ACCOUNT, agentAccountAbi, 'buy', 0n);
  rpc.read(ACCOUNT, agentAccountAbi, 'sell', 0n);
  rpc.receiptLogs = [
    agentActionLog({
      agent: signer.address,
      action: 1,
      token: TOKEN,
      usdcSpent: 25_000_000n,
      tokenDelta: 1_000_000n * WAD,
      periodId: 19_637n,
    }),
  ];
  const mf = await localClient(rpc);
  return { rpc, mf, agent: await mf.agent({ account: ACCOUNT, signer, slippage: 0.02 }) };
};
const sent = (rpc: { sent: `0x${string}`[] }) => {
  const tx = parseTransaction(rpc.sent[0]!);
  return { gas: tx.gas, ...decodeFunctionData({ abi: agentAccountAbi, data: tx.data! }) };
};

describe('AgentClient curve trades', () => {
  it('buys with a slippage floor and a chain-time deadline, and returns the fill', async () => {
    const { rpc, agent } = await setup();
    const fill = await agent.buy({ token: TOKEN, usdc: '25' });
    const s = sent(rpc);
    expect(s.functionName).toBe('buy');
    expect(s.args).toEqual([TOKEN, 25_000_000n, 980_000n * WAD, rpc.block.timestamp + 60n]);
    expect(s.gas).toBe(180_000n);
    expect(fill.action).toBe('buy');
    expect(fill.tokensOut).toBe(1_000_000n * WAD);
    expect(fill.usdcSpent).toBe('25');
    expect(fill.launched).toBeNull();
  });

  it('sends a buy that completes the curve with the graduation gas floor', async () => {
    const { rpc, agent } = await setup({ usdcUsed: (u) => u - 1n });
    await agent.buy({ token: TOKEN, usdc: '25' });
    expect(sent(rpc).gas).toBe(1_800_000n);
  });

  it('refuses an unregistered token and a graduated curve locally', async () => {
    const { rpc, agent } = await setup({ phase: 2 });
    const unregistered = (await agent
      .buy({ token: A(0xdd), usdc: '1' })
      .catch((e: unknown) => e)) as unknown as ContractRevertError;
    expect(unregistered.revert.name).toBe('TokenNotRegistered');
    await expect(agent.buy({ token: TOKEN, usdc: '1' })).rejects.toThrow(/swapExactIn/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('sell all with a zero balance fails locally (Review Focus 5)', async () => {
    const { rpc, agent } = await setup({ balance: 0n });
    await expect(agent.sell({ token: TOKEN, amount: 'all' })).rejects.toThrow(InvalidInputError);
    await expect(agent.sell({ token: TOKEN, amount: 'all' })).rejects.toThrow(
      /holds none of this token/,
    );
    expect(rpc.sent).toHaveLength(0);
  });

  it('sells everything during GraduationPending with a usdc6 floor', async () => {
    const { rpc, agent } = await setup({
      phase: 1,
      balance: 5n * WAD,
      usdcOut: 9_900_000_000_000_000_000n,
    });
    await agent.sell({ token: TOKEN, amount: 'all' });
    expect(sent(rpc).args).toEqual([TOKEN, 5n * WAD, 9_702_000n, rpc.block.timestamp + 60n]);
  });

  it('values a sell at the high-water cost and refuses above maxTradeUsdc locally', async () => {
    // 100 USDC for 1,000 tokens, then a crash buy of 10 USDC for 10,000: the average is 0.01 but the high-water stays 0.1.
    const basis = [110_000_000n, 11_000n * WAD, 10n ** 23n] as const;
    const { rpc, agent } = await setup({ balance: 11_000n * WAD }, { basis });
    expect((await agent.position(TOKEN)).highWater).toBe(10n ** 23n);
    const err = (await agent
      .sell({ token: TOKEN, amountWei: 2_000n * WAD })
      .catch((e: unknown) => e)) as unknown as ContractRevertError;
    expect(err).toBeInstanceOf(ContractRevertError);
    expect(err.revert.name).toBe('TradeTooLarge'); // valued at 200 USDC (high-water), not 20 (average)
    expect(err.phase).toBe('local');
    expect(rpc.sent).toHaveLength(0);
  });

  it('reports headroom in USDC from the policy registry, and when the period ends', async () => {
    const { rpc, agent } = await setup();
    const h = await agent.headroom();
    expect([h.spend, h.sell, h.actions, h.launches, h.maxTrade]).toEqual([
      '400',
      '500',
      499,
      3,
      '100',
    ]);
    expect(h.periodEndsAt).toBe((19_637 + 1) * 86_400);
    const headroomCall = encodeFunctionData({
      abi: agentPolicyRegistryAbi,
      functionName: 'headroom',
      args: [ACCOUNT],
    }).toLowerCase();
    const calls = rpc.methods('eth_call').map((p) => p[0] as { to: string; data: string });
    expect(
      calls.some(
        (c) =>
          c.to.toLowerCase() === REGISTRY.toLowerCase() && c.data.toLowerCase() === headroomCall,
      ),
    ).toBe(true);
  });

  it('refuses an address that is not an agent account', async () => {
    const { mf } = await setup();
    await expect(mf.agent({ account: A(0xee), signer })).rejects.toThrow(
      /not a Mercurifi agent account/,
    );
  });
});

describe('AgentClient preflight mirrors the account', () => {
  const refused = async (run: Promise<unknown>, name: string) => {
    const err = (await run.catch((e: unknown) => e)) as ContractRevertError;
    expect(err).toBeInstanceOf(ContractRevertError);
    expect(err.revert.name).toBe(name);
    expect(err.phase).toBe('local');
    return err;
  };

  it('refuses price impact above the policy with the same bps the account computes', async () => {
    const { rpc, agent } = await setup({ price: 10n ** 13n });
    const err = await refused(agent.buy({ token: TOKEN, usdc: '25' }), 'PriceImpactTooHigh');
    expect(err.revert.args).toEqual([14_750n]);
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses a snipe tax above maxSnipeBps, a young token and an allowlist miss', async () => {
    expect((await setup({ snipe: 500n })).agent).toBeDefined();
    await refused(
      (await setup({ snipe: 500n })).agent.buy({ token: TOKEN, usdc: '1' }),
      'SnipeTaxTooHigh',
    );
    // block 1000, launchBlock 100: age 900
    const young = await setup({}, { policy: { ...DEFAULT_POLICY, minTokenAgeBlocks: 1_000 } });
    await refused(young.agent.buy({ token: TOKEN, usdc: '1' }), 'TokenTooNew');
    const listed = await setup({}, { policy: { ...DEFAULT_POLICY, allowlistOnly: true } });
    await refused(listed.agent.buy({ token: TOKEN, usdc: '1' }), 'TokenNotAllowed');
    expect(young.rpc.sent.length + listed.rpc.sent.length).toBe(0);
  });

  it('refuses above maxTrade, the spend headroom and the per-token cap', async () => {
    const { rpc, agent } = await setup();
    await refused(agent.buy({ token: TOKEN, usdc: '101' }), 'TradeTooLarge');
    const low = await setup({}, { headroom: [20_000_000n, 500_000_000n, 499, 3] });
    const err = await refused(low.agent.buy({ token: TOKEN, usdc: '25' }), 'PeriodSpendExceeded');
    expect(err.revert.args).toEqual([20_000_000n]);
    const capped = await setup();
    capped.rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenSpent', 90_000_000n);
    expect(
      (await refused(capped.agent.buy({ token: TOKEN, usdc: '25' }), 'TokenCapExceeded')).revert
        .args,
    ).toEqual([10_000_000n]);
    expect(rpc.sent.length + low.rpc.sent.length + capped.rpc.sent.length).toBe(0);
  });

  it('checks the spend against what a final buy really uses, not the amount offered', async () => {
    const { rpc, agent } = await setup(
      { usdcUsed: (u) => u - 10n ** 19n },
      { headroom: [16_000_000n, 500_000_000n, 499, 3] },
    );
    await agent.buy({ token: TOKEN, usdc: '25' });
    expect(rpc.sent).toHaveLength(1);
  });

  it('refuses a sell above the remaining sell headroom, with the remaining amount', async () => {
    const { rpc, agent } = await setup(
      { balance: 5n * WAD },
      { headroom: [400_000_000n, 5_000_000n, 499, 3] },
    );
    const err = await refused(agent.sell({ token: TOKEN, amount: 'all' }), 'PeriodSellExceeded');
    expect(err.revert.args).toEqual([5_000_000n]);
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses a sell with price impact above the policy', async () => {
    const { agent } = await setup({ balance: 5n * WAD, price: 4n * WAD });
    await refused(agent.sell({ token: TOKEN, amount: 'all' }), 'PriceImpactTooHigh');
  });

  it('refuses a key that is not an active, permitted, unexpired agent, or has no action left', async () => {
    await refused(
      (await setup({}, { agentActive: false })).agent.buy({ token: TOKEN, usdc: '1' }),
      'NotAgent',
    );
    await refused(
      (await setup({}, { agentExpiresAt: 1_600_000_000 })).agent.buy({ token: TOKEN, usdc: '1' }),
      'AgentExpired',
    );
    await refused(
      (await setup({}, { agentPermissions: 2 })).agent.buy({ token: TOKEN, usdc: '1' }),
      'MissingPermission',
    );
    await refused(
      (await setup({}, { headroom: [400_000_000n, 500_000_000n, 0, 3] })).agent.buy({
        token: TOKEN,
        usdc: '1',
      }),
      'ActionLimit',
    );
  });

  it('never sends a zero minimum: a user floor can only raise it', async () => {
    const { rpc, agent } = await setup({ tokensOut: 1n, price: 10n ** 40n });
    await agent.buy({ token: TOKEN, usdc: '1', slippage: 0.02 });
    expect(sent(rpc).args![2]).toBe(1n);
    const b = await setup({ tokensOut: 1_000n * WAD, price: 10n ** 40n });
    await b.agent.buy({ token: TOKEN, usdc: '1', minTokensOut: 999n * WAD });
    expect(sent(b.rpc).args![2]).toBe(999n * WAD);
  });

  it('builds the deadline from chain time inside the account window, clamped to maxDeadlineSeconds', async () => {
    const { rpc, mf } = await setup({}, { policy: { ...DEFAULT_POLICY, maxDeadlineSeconds: 30 } });
    const agent = await mf.agent({ account: ACCOUNT, signer, deadlineSeconds: 120 });
    await agent.buy({ token: TOKEN, usdc: '1' });
    expect(sent(rpc).args![3]).toBe(rpc.block.timestamp + 30n);
  });

  it('returns the measured fill from the AgentAction log, not the quote', async () => {
    const { rpc, agent } = await setup();
    rpc.receiptLogs = [
      agentActionLog({
        agent: signer.address,
        action: 1,
        token: TOKEN,
        usdcSpent: 24_000_000n,
        tokenDelta: 7n * WAD,
        basisValue: 24_000_000n,
        periodId: 5n,
      }),
    ];
    const fill = await agent.buy({ token: TOKEN, usdc: '25' });
    expect([fill.usdcSpent6, fill.tokenDelta, fill.basisValue6, fill.periodId]).toEqual([
      24_000_000n,
      7n * WAD,
      24_000_000n,
      5n,
    ]);
  });

  it('parses a sell fill with negative token delta', async () => {
    const t = await setup({ balance: 5n * WAD });
    t.rpc.receiptLogs = [
      agentActionLog({
        agent: signer.address,
        action: 2,
        token: TOKEN,
        usdcReceived: 9_000_000n,
        tokenDelta: -(5n * WAD),
        basisValue: 9_900_000n,
        periodId: 3n,
      }),
    ];
    const fill = await t.agent.sell({ token: TOKEN, amount: 'all' });
    expect([
      fill.action,
      fill.usdcReceived6,
      fill.usdcReceived,
      fill.tokensIn,
      fill.tokens,
      fill.basisValue6,
    ]).toEqual(['sell', 9_000_000n, '9', 5n * WAD, '5', 9_900_000n]);
  });

  it('fails with FILL_NOT_FOUND when the receipt has no AgentAction from the account', async () => {
    const { rpc, agent } = await setup();
    rpc.receiptLogs = [];
    await expect(agent.buy({ token: TOKEN, usdc: '1' })).rejects.toMatchObject({
      code: 'FILL_NOT_FOUND',
    });
  });

  it('refuses a sell on a graduated curve before quoting it', async () => {
    const { rpc, agent } = await setup({ phase: 2, balance: 5n * WAD });
    rpc.read(CURVE, bondingCurveAbi, 'quoteSell', () => {
      throw new Error('quoteSell must not be read on a graduated curve');
    });
    await refused(agent.sell({ token: TOKEN, amountWei: WAD }), 'NotTrading');
    expect(rpc.sent).toHaveLength(0);
  });

  it('checks Paused first: the owner pause or the platform pause, before the agent and the token', async () => {
    const owner = await setup({}, { agentActive: false });
    owner.rpc.read(REGISTRY, agentPolicyRegistryAbi, 'ownerPaused', true);
    await refused(owner.agent.buy({ token: TOKEN, usdc: '1' }), 'Paused');
    const platform = await setup({ phase: 2 });
    platform.rpc.read(FACTORY, agentAccountFactoryAbi, 'isPaused', true);
    await refused(platform.agent.buy({ token: A(0xdd), usdc: '1' }), 'Paused');
    await refused(platform.agent.sell({ token: TOKEN, amount: 'all' }), 'Paused');
    expect(owner.rpc.sent.length + platform.rpc.sent.length).toBe(0);
  });

  it('flags a buy that may complete the curve when it takes half or more of what is left', async () => {
    // remaining = 800M - 100M = 700M; half = 350M
    const half = await setup({ tokensOut: 350_000_000n * WAD });
    await half.agent.buy({ token: TOKEN, usdc: '25' });
    expect(sent(half.rpc).gas).toBe(1_800_000n);
    const under = await setup({ tokensOut: 349_999_999n * WAD });
    await under.agent.buy({ token: TOKEN, usdc: '25' });
    expect(sent(under.rpc).gas).toBe(180_000n);
  });

  it('compares the token age against the block the transaction will land in (latest + 1)', async () => {
    // latest 1000, launchBlock 100: age 900 now, 901 when included.
    const ok = await setup({}, { policy: { ...DEFAULT_POLICY, minTokenAgeBlocks: 901 } });
    await ok.agent.buy({ token: TOKEN, usdc: '1' });
    expect(ok.rpc.sent).toHaveLength(1);
    await refused(
      (await setup({}, { policy: { ...DEFAULT_POLICY, minTokenAgeBlocks: 902 } })).agent.buy({
        token: TOKEN,
        usdc: '1',
      }),
      'TokenTooNew',
    );
  });

  it('sells dust with a minimum of one micro-USDC, and refuses proceeds below it', async () => {
    const dust = await setup({ balance: 5n * WAD, usdcOut: 1_500_000_000_000n });
    await dust.agent.sell({ token: TOKEN, amount: 'all', slippage: 0.49 });
    expect(sent(dust.rpc).args![2]).toBe(1n);
    const below = await setup({ balance: 5n * WAD, usdcOut: 999_999_999_999n });
    await expect(below.agent.sell({ token: TOKEN, amount: 'all' })).rejects.toThrow(
      /below 1 micro-USDC/,
    );
    expect(below.rpc.sent).toHaveLength(0);
  });

  it('reads the agent preflight and headroom from one block', async () => {
    // The sender's own simulation of the trade is a separate, deliberate "latest" call.
    const trade = new Set([
      toFunctionSelector(getAbiItem({ abi: agentAccountAbi, name: 'buy' }) as never),
      toFunctionSelector(getAbiItem({ abi: agentAccountAbi, name: 'sell' }) as never),
    ]);
    const pinned = (calls: unknown[][]) =>
      calls
        .filter((c) => !trade.has((c[0] as { data: string }).data.slice(0, 10) as `0x${string}`))
        .map((c) => c[1]);
    const { rpc, agent } = await setup({ balance: 5n * WAD });
    for (const run of [
      () => agent.buy({ token: TOKEN, usdc: '1' }),
      () => agent.sell({ token: TOKEN, amount: 'all' }),
    ]) {
      const from = rpc.methods('eth_call').length;
      await run();
      const blocks = pinned(rpc.methods('eth_call').slice(from));
      expect(blocks.length).toBeGreaterThan(8);
      expect(new Set(blocks)).toEqual(new Set(['0x3e8']));
    }
    const from = rpc.methods('eth_call').length;
    await agent.headroom();
    expect(new Set(pinned(rpc.methods('eth_call').slice(from)))).toEqual(new Set(['0x3e8']));
  });

  it('throws on an AgentAction code it does not know, instead of reporting a buy', async () => {
    const { rpc, agent } = await setup();
    rpc.receiptLogs = [
      agentActionLog({ agent: signer.address, action: 9, token: TOKEN, periodId: 1n }),
    ];
    await expect(agent.buy({ token: TOKEN, usdc: '1' })).rejects.toMatchObject({
      code: 'UNKNOWN_ACTION',
    });
  });

  it('ignores an AgentAction from another account and rejects two from this one', async () => {
    const { rpc, agent } = await setup();
    const own = agentActionLog({
      agent: signer.address,
      action: 1,
      token: TOKEN,
      usdcSpent: 3_000_000n,
      tokenDelta: 2n * WAD,
      periodId: 4n,
    });
    const other = eventLog(agentAccountAbi, A(0xab), 'AgentAction', {
      agent: signer.address,
      action: 1,
      token: TOKEN,
      usdcSpent: 99_000_000n,
      tokenDelta: 99n * WAD,
      periodId: 9n,
    });
    rpc.receiptLogs = [other, own];
    const fill = await agent.buy({ token: TOKEN, usdc: '3' });
    expect([fill.usdcSpent6, fill.periodId]).toEqual([3_000_000n, 4n]);
    rpc.receiptLogs = [own, own];
    await expect(agent.buy({ token: TOKEN, usdc: '3' })).rejects.toMatchObject({
      code: 'FILL_NOT_FOUND',
    });
  });
});
