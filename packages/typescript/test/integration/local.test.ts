import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  agentAccountAbi,
  bondingCurveAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../../src/abi/index.js';
import { curveSellValue6, recordedSellValue6, type Basis } from '../../src/basis.js';
import {
  ContractRevertError,
  createClient,
  decodeRevert,
  extractRevertData,
  generateAgentKey,
  isLoopbackUrl,
  localKey,
  localNetwork,
  type DecodedRevert,
  type AgentClient,
  type Fill,
  type MercurifiClient,
  type Signer,
} from '../../src/index.js';

// ANVIL_PORT selects the chain started by `scripts/local-chain.sh` (default 8545) and its book fixtures/local-book-<port>.json.
// ANVIL_RPC may override the URL; its port then names the book. Both must point at the same loopback Anvil.
const RPC = process.env.ANVIL_RPC ?? `http://127.0.0.1:${process.env.ANVIL_PORT ?? '8545'}`;
if (!isLoopbackUrl(RPC)) throw new Error('the integration tier runs only against a loopback Anvil');
const PORT = new URL(RPC).port || '80';
const ROOT = new URL('../../../../', import.meta.url);
const DAY = 86_400n;
const RECORD = process.env.RECORD === '1';
const WAD = 10n ** 18n;

const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(body.error.message);
  return body.result;
};
const fund = (a: Address, usdc: bigint) => rpc('anvil_setBalance', [a, toHex(usdc * WAD)]);
const mine = (blocks: number) => rpc('anvil_mine', [toHex(blocks)]);
const latestTs = async () =>
  BigInt(((await rpc('eth_getBlockByNumber', ['latest', false])) as { timestamp: Hex }).timestamp);
/** The UTC day (= the account's one-day period) the run was aligned to in beforeAll. */
let day0 = 0n;
/** Moves chain time forward; every warp must stay inside the aligned day, or period-bound cases would flake. */
const warp = async (seconds: number) => {
  await rpc('evm_increaseTime', [toHex(seconds)]);
  await mine(1);
  expect((await latestTs()) / DAY).toBe(day0);
};
const json = (v: unknown) =>
  `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;
const record = (name: string, value: unknown) => {
  if (!RECORD) return;
  mkdirSync(new URL('fixtures/recorded/', ROOT), { recursive: true });
  writeFileSync(new URL(`fixtures/recorded/${name}.json`, ROOT), json(value));
};
const revertOf = async (p: Promise<unknown>): Promise<ContractRevertError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ContractRevertError);
  return e as ContractRevertError;
};

describe('local Anvil end to end', () => {
  let mf: MercurifiClient;
  let owner: Signer;
  let agentSigner: Signer;
  let account: Address;
  let agent: AgentClient;
  let token: Address;

  const recordFill = async (name: string, fill: Fill) => {
    const r = await mf.publicClient.getTransactionReceipt({ hash: fill.txHash });
    record(`fill-${name}`, {
      kind: 'fill',
      account,
      launchFactory: mf.network.launch.factory,
      receipt: {
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      },
      expected: {
        action: fill.action,
        token: fill.token,
        usdcSpent6: fill.usdcSpent6,
        usdcReceived6: fill.usdcReceived6,
        tokenDelta: fill.tokenDelta,
        basisValue6: fill.basisValue6,
        launched: fill.launched,
      },
    });
  };
  const recordRevert = (name: string, d: DecodedRevert, context?: Record<string, unknown>) => {
    expect(d.source).not.toBe('local check'); // real revert data from the node
    expect(d.data.length).toBeGreaterThanOrEqual(10);
    record(`revert-${name}`, {
      kind: 'revert',
      data: d.data,
      ...(context === undefined ? {} : { context }),
      expected: { name: d.name, message: d.message, source: d.source },
    });
  };
  /**
   * The SDK refuses most failing trades locally, before signing, so their ContractRevertError carries no node data. The
   * recorded fixtures must be real chain data, so the same call is replayed as an eth_call from the agent key (bypassing
   * the SDK's local checks) and the node's revert data is decoded.
   */
  const chainRevert = async (from: Address, to: Address, data: Hex): Promise<DecodedRevert> => {
    const e = await mf.publicClient.call({ account: from, to, data, gas: 1_800_000n }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).not.toBeNull();
    return decodeRevert(extractRevertData(e));
  };
  const agentCall = async (
    functionName: 'buy' | 'sell',
    args: readonly [Address, bigint, bigint],
  ): Promise<DecodedRevert> => {
    const deadline = (await mf.publicClient.getBlock()).timestamp + 60n;
    return chainRevert(
      agentSigner.address,
      account,
      encodeFunctionData({ abi: agentAccountAbi, functionName, args: [...args, deadline] }),
    );
  };

  beforeAll(async () => {
    // Periods are block.timestamp / 1 day. Start one minute into the next UTC day, so the run's warps (3 x 3,601 s plus
    // mined blocks) cannot cross midnight and reset the period-bound counters (the launch limit) mid-run.
    day0 = (await latestTs()) / DAY + 1n;
    await rpc('evm_setNextBlockTimestamp', [toHex(day0 * DAY + 60n)]);
    await mine(1);
    expect((await latestTs()) / DAY).toBe(day0);
    const book = localNetwork(
      JSON.parse(readFileSync(new URL(`fixtures/local-book-${PORT}.json`, ROOT), 'utf8')),
    );
    mf = await createClient({ network: book, rpcUrl: RPC, onWarning: () => undefined });
    owner = localKey(generateAgentKey().privateKey);
    agentSigner = localKey(generateAgentKey().privateKey);
    await fund(owner.address, 100_000n);
    await fund(agentSigner.address, 10n);
  });

  it('verified the factory, implementation and policy registry at start-up', () => {
    const agents = mf.requireAgents();
    expect(agents.registry).not.toBe(zeroAddress);
  });

  it('creates an account with the defaults and a first agent', async () => {
    const res = await mf.owner(owner).createAccount({
      firstAgent: {
        address: agentSigner.address,
        permissions: ['buy', 'launch', 'swap', 'claim', 'sweep'],
      },
    });
    account = res.account;
    await mf.owner(owner).deposit(account, { usdc: '1000' });
    agent = await mf.agent({ account, signer: agentSigner });
    expect((await agent.status()).active).toBe(true);
    const state = await (await mf.owner(owner).manage(account)).state();
    expect(state.owner).toBe(owner.address);
    expect(state.registry).toBe(mf.requireAgents().registry);
  });

  it('launches a token whose creator is the account', async () => {
    const fill = await agent.launch({
      name: 'Local',
      symbol: 'LOC',
      metadataURI: 'ipfs://local',
      initialBuyUsdc: '5',
    });
    token = fill.launched!.token;
    expect(fill.action).toBe('launch');
    expect((await mf.token(token)).creator).toBe(account);
    await recordFill('launch', fill);
  });

  it('refuses a buy in the snipe window, then buys after it', async () => {
    const e = await revertOf(agent.buy({ token, usdc: '25' }));
    expect(e.revert.name).toBe('SnipeTaxTooHigh');
    const onChain = await agentCall('buy', [token, 25_000_000n, 1n]);
    expect(onChain.name).toBe('SnipeTaxTooHigh');
    recordRevert('snipe', onChain);
    await mine(130);
    const fill = await agent.buy({ token, usdc: '25' });
    expect(fill.usdcSpent6).toBe(25_000_000n);
    await recordFill('buy', fill);
  });

  it('explains a cap with the limit in USDC', async () => {
    const e = await revertOf(agent.buy({ token, usdc: '150' }));
    expect(e.revert.name).toBe('TradeTooLarge');
    expect(e.message).toContain('100 USDC');
    const onChain = await agentCall('buy', [token, 150_000_000n, 1n]);
    expect([onChain.name, onChain.source]).toEqual(['TradeTooLarge', 'AgentAccount']);
    expect(onChain.message).toContain('100 USDC');
    recordRevert('trade-too-large', onChain);
  });

  it('sends concurrent buys from one key in nonce order', async () => {
    const fills = await Promise.all([1, 2, 3].map(() => agent.buy({ token, usdc: '1' })));
    expect(new Set(fills.map((f) => f.txHash)).size).toBe(3);
    const nonces = (
      await Promise.all(fills.map((f) => mf.publicClient.getTransaction({ hash: f.txHash })))
    )
      .map((t) => t.nonce)
      .sort((a, b) => a - b);
    expect(nonces).toEqual([nonces[0], nonces[0]! + 1, nonces[0]! + 2]);
  });

  it('needs the sell permission, which is queued behind the delay', async () => {
    const e = await revertOf(agent.sell({ token, amount: '1000000' }));
    expect(e.revert.name).toBe('MissingPermission');
    const onChain = await agentCall('sell', [token, 1_000_000n * WAD, 1n]);
    expect([onChain.name, onChain.source]).toEqual(['MissingPermission', 'AgentPolicyRegistry']);
    recordRevert('missing-permission', onChain);
    const m = await mf.owner(owner).manage(account);
    const r = await m.setAgent(agentSigner.address, {
      permissions: ['buy', 'sell', 'launch', 'swap', 'claim', 'sweep'],
    });
    expect(r.outcome).toBe('queued');
    expect((await m.listQueued()).find((q) => q.id === r.queuedId)).toMatchObject({
      kind: 'setAgent',
      status: 'pending',
    });
    await warp(3_601);
    await m.executeQueued(r.queuedId!);
    const fill = await agent.sell({ token, amount: '1000000' });
    expect(fill.action).toBe('sell');
    await recordFill('sell', fill);
  });

  it('values a sell at the high-water cost, exactly as the SDK computes it before signing', async () => {
    // Make the high-water term win: a wallet pumps the price, the agent buys high (raising its high-water average), the
    // wallet dumps, the agent buys cheap (the average falls, the high-water stays), then the agent sells.
    const curve = (await mf.token(token)).curve;
    const whale = localKey(generateAgentKey().privateKey);
    await fund(whale.address, 10_000n);
    const deadline = async () => (await mf.publicClient.getBlock()).timestamp + 600n;
    const curveTx = async (functionName: 'buy' | 'sell', args: readonly unknown[], value = 0n) =>
      mf.sender.send(whale, {
        to: curve,
        data: encodeFunctionData({ abi: bondingCurveAbi, functionName, args } as never),
        value,
        label: `whale ${functionName}`,
      });
    await curveTx('buy', [1n, zeroAddress, await deadline()], 2_000n * WAD);
    await agent.buy({ token, usdc: '40' });
    const whaleTokens = (await mf.publicClient.readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: 'balanceOf',
      args: [whale.address],
    } as never)) as bigint;
    await mf.sender.send(whale, {
      to: token,
      data: encodeFunctionData({
        abi: launchTokenAbi,
        functionName: 'approve',
        args: [curve, whaleTokens],
      } as never),
      label: 'whale approve',
    });
    await curveTx('sell', [whaleTokens, 1n, zeroAddress, await deadline()]);
    await agent.buy({ token, usdc: '20' });

    const before = await agent.position(token);
    const basis: Basis = {
      costUsdc6: before.costUsdc6,
      tokens: before.basisTokens,
      highWater: before.highWater,
    };
    const tokensIn = basis.tokens / 10n;
    expect(tokensIn <= before.balanceWei).toBe(true); // every token was bought by the account, so nothing is unrecorded
    const { recorded, value6 } = recordedSellValue6(basis, tokensIn);
    expect(recorded).toBe(tokensIn);
    expect(curveSellValue6(basis, tokensIn, 0n)).toBe(value6);
    const ceilAvg = (tokensIn * basis.costUsdc6 + basis.tokens - 1n) / basis.tokens;
    const highWater = (tokensIn * basis.highWater) / 10n ** 36n;
    expect(value6).toBe(highWater); // the high-water branch decides ...
    expect(highWater > ceilAvg).toBe(true); // ... strictly above the rounded-up average
    const fill = await agent.sell({ token, amountWei: tokensIn });
    expect(fill.basisValue6).toBe(value6);
    await recordFill('sell-high-water', fill);
  });

  it('sends a curve-completing buy with at least 1.8M gas', async () => {
    const launched = await agent.launch({
      name: 'Local Two',
      symbol: 'LOC2',
      metadataURI: 'ipfs://local-2',
    });
    const full = launched.launched!.token;
    await mine(130); // past the snipe window of the new curve
    const curve = (await mf.token(full)).curve;
    const quoteUsed = async (v: bigint) =>
      (
        (await mf.publicClient.readContract({
          address: curve,
          abi: bondingCurveAbi,
          functionName: 'quoteBuy',
          args: [v],
        } as never)) as readonly bigint[]
      )[1]!;
    let lo = 1n;
    let hi = 100_000n * WAD;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if ((await quoteUsed(mid)) < mid) hi = mid;
      else lo = mid + 1n;
    }
    const whale = localKey(generateAgentKey().privateKey);
    await fund(whale.address, 100_000n);
    const deadline = (await mf.publicClient.getBlock()).timestamp + 600n;
    await mf.sender.send(whale, {
      to: curve,
      data: encodeFunctionData({
        abi: bondingCurveAbi,
        functionName: 'buy',
        args: [1n, zeroAddress, deadline],
      }),
      value: lo - 40n * WAD,
      label: 'whale',
    });
    const fill = await agent.buy({ token: full, usdc: '50' });
    const tx = await mf.publicClient.getTransaction({ hash: fill.txHash });
    expect(tx.gas >= 1_800_000n).toBe(true);
    // graduation itself is deferred on Anvil (the USDC stub cannot move funds): the curve completed and waits
    expect((await mf.token(full)).phase).toBe('graduationPending');
  });

  it('checks the launch limit before the trade size (registry preamble), on chain', async () => {
    await agent.launch({ name: 'Local Three', symbol: 'LOC3', metadataURI: 'ipfs://local-3' }); // third of three this period
    const configHash = (await mf.publicClient.readContract({
      address: mf.network.launch.factory,
      abi: launchFactoryAbi,
      functionName: 'configHash',
    } as never)) as Hex;
    const deadline = (await mf.publicClient.getBlock()).timestamp + 60n;
    const request = {
      name: 'Local Four',
      symbol: 'LOC4',
      metadataURI: 'ipfs://local-4',
      salt: toHex(4n, { size: 32 }),
      expectedConfigHash: configHash,
      initialBuyUsdc: 150_000_000n,
      minTokensOut: 1n,
      deadline,
    };
    // over the launch limit and over maxTradeUsdc at once: the launch limit is reported
    const onChain = await chainRevert(
      agentSigner.address,
      account,
      encodeFunctionData({
        abi: agentAccountAbi,
        functionName: 'launch',
        args: [request],
      } as never),
    );
    expect([onChain.name, onChain.source]).toEqual(['LaunchLimit', 'AgentPolicyRegistry']);
    const room = await agent.headroom();
    const { policy } = await (await mf.owner(owner).manage(account)).state();
    expect(room.launches).toBe(0);
    expect(request.initialBuyUsdc > policy.maxTradeUsdc).toBe(true);
    // The context shows the multi-failure: out of launches AND an initial buy above maxTradeUsdc; LaunchLimit wins.
    recordRevert('launch-limit', onChain, {
      initialBuyUsdc6: request.initialBuyUsdc,
      maxTradeUsdc6: policy.maxTradeUsdc,
      launchesUsed: policy.launchesPerPeriod - room.launches,
      launchesPerPeriod: policy.launchesPerPeriod,
    });
  });

  it('applies a tightening at once and merges an older queued widening field by field', async () => {
    const m = await mf.owner(owner).manage(account);
    const first = await m.setPolicy({ maxTradeUsdc: '50', periodSpendCap: '900' });
    expect(first.outcome).toBe('mixed');
    expect((await m.setPolicy({ maxTradeUsdc: '40' })).outcome).toBe('immediate');
    const queued = (await m.listQueued()).find((q) => q.id === first.queuedId);
    expect(queued?.detail).toMatchObject({ superseded: ['maxTradeUsdc'] });
    await warp(3_601);
    await m.executeQueued(first.queuedId!);
    const { policy } = await m.state();
    expect([policy.maxTradeUsdc, policy.periodSpendCap]).toEqual([40_000_000n, 900_000_000n]);
  });

  it('marks a queued allowlist addition stale after a removal', async () => {
    const m = await mf.owner(owner).manage(account);
    const add = await m.setTokenAllowed(token, true);
    expect(add.outcome).toBe('queued');
    expect((await m.setTokenAllowed(token, false)).outcome).toBe('immediate');
    expect((await m.listQueued()).find((q) => q.id === add.queuedId)).toMatchObject({
      kind: 'allowToken',
      status: 'stale',
    });
    await warp(3_601);
    const e = await revertOf(m.executeQueued(add.queuedId!));
    expect([e.revert.name, e.revert.source]).toEqual(['StaleQueued', 'AgentPolicyRegistry']);
    recordRevert('stale', e.revert);
  });

  it('decodes every queue kind, and pausing cancels them all', async () => {
    const m = await mf.owner(owner).manage(account);
    await m.setTokenAllowed(token, true);
    await m.setIncreaseDelay(60);
    await m.transferOwnership(localKey(generateAgentKey().privateKey).address);
    await m.addAgent(localKey(generateAgentKey().privateKey).address);
    const pending = (await m.listQueued()).filter((q) => q.status === 'pending');
    expect(new Set(pending.map((q) => q.kind))).toEqual(
      new Set(['allowToken', 'delay', 'owner', 'addAgent']),
    );
    await m.pauseAgents(true);
    expect((await revertOf(agent.buy({ token, usdc: '1' }))).revert.name).toBe('Paused');
    expect((await m.listQueued()).every((q) => q.status !== 'pending')).toBe(true);
    await m.pauseAgents(false);
  });

  it('claims creator fees into the account and sweeps USDC to the owner', async () => {
    const claim = await agent.claimFees();
    expect(claim.usdcReceived6 > 0n).toBe(true);
    const before = await mf.publicClient.getBalance({ address: owner.address });
    await agent.sweepToOwner({ usdc: '1' });
    expect((await mf.publicClient.getBalance({ address: owner.address })) - before).toBe(WAD);
  });

  it('revokes a key for good and withdraws everything to the owner', async () => {
    const m = await mf.owner(owner).manage(account);
    await m.revokeAgent(agentSigner.address);
    expect((await revertOf(agent.buy({ token, usdc: '1' }))).revert.name).toBe('NotAgent');
    expect((await agent.status()).retired).toBe(true);
    await m.withdrawMany();
    expect(await mf.publicClient.getBalance({ address: account })).toBe(0n);
    expect(
      await mf.publicClient.readContract({
        address: token,
        abi: launchTokenAbi,
        functionName: 'balanceOf',
        args: [account],
      } as never),
    ).toBe(0n);
    expect((await latestTs()) / DAY).toBe(day0); // the whole run stayed in one period
  });
});
