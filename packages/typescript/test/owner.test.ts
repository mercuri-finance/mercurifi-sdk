import { decodeFunctionData, encodeAbiParameters, parseTransaction, zeroAddress, type Abi, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { InvalidInputError, NotOwnerError } from '../src/errors.js';
import { SELL_RISK_WARNING } from '../src/permissions.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { POLICY_TUPLE } from '../src/queue.js';
import { localKey } from '../src/signers.js';
import { agentActionLog, eventLog, FACTORY, mockAccount, mockCurve, queueLog, REGISTRY } from './helpers/account.js';
import { A, ACCOUNT, AGENT_KEY, localClient, localRpc, OWNER_KEY, TOKEN } from './helpers/local.js';

const owner = localKey(OWNER_KEY);
const agent = localKey(AGENT_KEY);
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const USDC = '0x3600000000000000000000000000000000000000';
const ALL_ABI = [...agentAccountAbi, ...agentPolicyRegistryAbi, ...agentAccountFactoryAbi] as Abi;

/** Lowercases every address so checksummed decodes compare with the lowercase test addresses. */
const norm = (v: unknown): unknown =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase()
    : Array.isArray(v) ? v.map(norm)
      : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
        : v;

const setup = async (ownerAddress = owner.address) => {
  const rpc = localRpc();
  mockAccount(rpc, { owner: ownerAddress, agent: agent.address });
  mockCurve(rpc, { balance: 5n * 10n ** 18n });
  rpc.read(FACTORY, agentAccountFactoryAbi, 'predictAccount', ACCOUNT);
  rpc.read(FACTORY, agentAccountFactoryAbi, 'createAccount', ACCOUNT);
  rpc.receiptLogs = [eventLog(agentAccountFactoryAbi, FACTORY, 'AccountCreated', { owner: owner.address, account: ACCOUNT, salt: SALT })];
  const onWarning = vi.fn();
  const mf = await localClient(rpc, { onWarning });
  return { rpc, mf, owner: mf.owner(owner), onWarning };
};
/** The i-th sent transaction: its target and decoded call, addresses lowercased. */
const sent = (rpc: { sent: Hex[] }, i = 0) => {
  const tx = parseTransaction(rpc.sent[i]!);
  const { functionName, args } = decodeFunctionData({ abi: ALL_ABI, data: tx.data! });
  return { to: tx.to!.toLowerCase(), functionName, args: norm(args) as unknown[] };
};

describe('OwnerClient.createAccount', () => {
  it('uses the spec defaults and a 30-day first agent without sell, sent to the factory', async () => {
    const { rpc, owner: o } = await setup();
    const res = await o.createAccount({ salt: SALT, firstAgent: { address: agent.address } });
    expect(res.account.toLowerCase()).toBe(ACCOUNT);
    const { to, functionName, args } = sent(rpc);
    expect(to).toBe(FACTORY);
    expect(functionName).toBe('createAccount');
    const init = args[1] as Record<string, unknown>;
    expect(init.policy).toEqual({ ...DEFAULT_POLICY });
    expect(init.periodSeconds).toBe(86_400);
    expect(init.increaseDelay).toBe(3_600);
    expect(init.referrer).toBe(zeroAddress);
    expect(init.firstAgentPermissions).toBe(1 | 4 | 8 | 16);
    expect(init.firstAgentExpiresAt).toBe(Number(rpc.block.timestamp) + 30 * 86_400);
  });

  it('warns when sell is granted', async () => {
    const { owner: o, onWarning } = await setup();
    await o.createAccount({ salt: SALT, firstAgent: { address: agent.address, permissions: ['buy', 'sell'] } });
    expect(onWarning).toHaveBeenCalledWith(SELL_RISK_WARNING);
  });

  it('refuses a self-referrer, a policy above a ceiling and the owner as agent, sending nothing', async () => {
    const { rpc, owner: o } = await setup();
    await expect(o.createAccount({ salt: SALT, referrer: ACCOUNT })).rejects.toThrow(/referrer cannot be the account/);
    await expect(o.createAccount({ salt: SALT, policy: { maxTradeUsdc: '5000' } })).rejects.toThrow(/beta ceiling/);
    await expect(o.createAccount({ salt: SALT, firstAgent: { address: owner.address } })).rejects.toThrow(InvalidInputError);
    expect(rpc.sent).toHaveLength(0);
  });
});

describe('AccountManager', () => {
  it('refuses a signer that is not the owner (read from the registry)', async () => {
    const { owner: o } = await setup(A(0x99));
    await expect(o.manage(ACCOUNT)).rejects.toThrow(NotOwnerError);
  });

  it('applies tighter fields now and queues wider ones', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setPolicy', 4n);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', [3, 1_700_003_600, 1n, 1n, '0x']);
    const m = await o.manage(ACCOUNT);
    const res = await m.setPolicy({ maxTradeUsdc: '50', periodSpendCap: '900' });
    expect(res.outcome).toBe('mixed');
    expect(res.queuedId).toBe(4n);
    expect(res.eta).toBe(1_700_003_600);
    expect(res.preview.immediate).toEqual(['maxTradeUsdc']);
    expect(res.preview.queued).toEqual(['periodSpendCap']);
  });

  it('sends setPolicy(account, target) to the registry', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setPolicy', 0n);
    await (await o.manage(ACCOUNT)).setPolicy({ maxTradeUsdc: '50' });
    const s = sent(rpc);
    expect([s.to, s.functionName, s.args[0]]).toEqual([REGISTRY, 'setPolicy', ACCOUNT]);
    expect(s.args[1]).toEqual({ ...DEFAULT_POLICY, maxTradeUsdc: 50_000_000n });
  });

  it('lists queued changes from registry logs with their status and decoded payload', async () => {
    const { rpc, owner: o } = await setup();
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n), queueLog(2n, 'IncreaseDelayQueued'), queueLog(3n), eventLog(agentPolicyRegistryAbi, REGISTRY, 'AgentQueued', { account: A(0x55), id: 9n })];
    const addPayload = encodeAbiParameters([{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }], [agent.address, now + 86_400, 29]);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => {
      const id = args[1] as bigint;
      if (id === 1n) return [1, now - 10, 1n, 1n, addPayload];
      if (id === 2n) return [5, now + 100, 1n, 1n, encodeAbiParameters([{ type: 'uint32' }], [60])];
      if (id === 3n) return [1, now - 10, 0n, 1n, addPayload];
      throw new Error(`another account's id ${id} was read`);
    });
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.kind, q.status])).toEqual([[1n, 'addAgent', 'ready'], [2n, 'delay', 'pending'], [3n, 'addAgent', 'cancelled']]);
    expect(list[0]!.detail).toEqual({ agent: agent.address, expiresAt: now + 86_400, permissions: ['buy', 'launch', 'swap', 'claim'] });
    const filter = rpc.methods('eth_getLogs')[0]![0] as { address: string; topics: (string | null)[] };
    expect(filter.address.toLowerCase()).toBe(REGISTRY);
    expect(filter.topics).toEqual([null, `0x${'0'.repeat(24)}${ACCOUNT.slice(2)}`]);
  });

  it('marks an item stale when its subject was written after it, and lists superseded policy fields', async () => {
    const { rpc, owner: o } = await setup();
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n), queueLog(2n, 'PolicyQueued')];
    const addPayload = encodeAbiParameters([{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }], [agent.address, now + 86_400, 29]);
    const policyPayload = encodeAbiParameters([POLICY_TUPLE], [{ ...DEFAULT_POLICY, periodSpendCap: 900_000_000n }]);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) =>
      (args[1] as bigint) === 1n ? [2, now - 10, 1n, 5n, addPayload] : [3, now + 100, 1n, 5n, policyPayload]);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'agentWrite', 7n);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'policyWrite', (args) => ((args[1] as bigint) === 0n ? 9n : 0n));
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.kind, q.seq, q.status])).toEqual([[1n, 'setAgent', 5n, 'stale'], [2n, 'policy', 5n, 'pending']]);
    expect(list[1]!.detail).toMatchObject({ superseded: ['maxTradeUsdc'], policy: { periodSpendCap: 900_000_000n } });
  });

  it('sends nothing when the token is already on the allowlist', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenAllowed', true);
    const r = await (await o.manage(ACCOUNT)).setTokenAllowed(TOKEN, true);
    expect(r.outcome).toBe('none');
    expect(rpc.sent).toHaveLength(0);
  });

  it('accepts a queued ownership transfer on the registry', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'acceptOwnership', undefined);
    const r = await o.acceptOwnership(ACCOUNT, 3n);
    expect(r.outcome).toBe('immediate');
    expect(sent(rpc)).toEqual({ to: REGISTRY, functionName: 'acceptOwnership', args: [ACCOUNT, 3n] });
  });

  it('withdraws native USDC in wei from the account and refuses the ERC-20 view', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'withdraw', undefined);
    const m = await o.manage(ACCOUNT);
    await m.withdraw({ usdc: '10' });
    expect(sent(rpc)).toEqual({ to: ACCOUNT, functionName: 'withdraw', args: [zeroAddress, 10n * 10n ** 18n] });
    await expect(m.withdraw({ token: USDC, amount: '1' })).rejects.toThrow(/as native/);
  });

  it('withdraws every held token and native last, from the account', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const res = await (await o.manage(ACCOUNT)).withdrawMany([TOKEN, TOKEN, USDC]);
    expect(res.tokens).toEqual([TOKEN]);
    expect(sent(rpc)).toEqual({ to: ACCOUNT, functionName: 'withdrawMany', args: [[TOKEN, zeroAddress]] });
  });
});

describe('owner UX', () => {
  it('previews which fields apply now and which are queued, with the effective window', async () => {
    const { rpc, owner: o } = await setup();
    const p = await (await o.manage(ACCOUNT)).previewPolicy({ maxTradeUsdc: '50', periodSpendCap: '900' });
    const now = Number(rpc.block.timestamp);
    expect(p.immediate).toEqual(['maxTradeUsdc']);
    expect(p.queued).toEqual(['periodSpendCap']);
    expect(p.etaIfQueued).toBe(now + 3_600);
    expect(p.expiresIfQueued).toBe(now + 3_600 + 604_800);
    expect(p.summary[0]).toMatch(/maxTradeUsdc: 100 -> 50 applies immediately/);
    expect(p.summary[1]).toMatch(/periodSpendCap: 500 -> 900 is queued; executable from .* until /);
    expect(rpc.sent).toHaveLength(0);
  });

  it('has no ETA when everything is narrowing', async () => {
    const { owner: o } = await setup();
    const p = await (await o.manage(ACCOUNT)).previewPolicy({ maxTradeUsdc: '50' });
    expect([p.etaIfQueued, p.expiresIfQueued, p.queued]).toEqual([null, null, []]);
  });

  it('flags an expired item and a stale one in the queue view, with a warning', async () => {
    const { rpc, owner: o } = await setup();
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n), queueLog(2n, 'TokenAllowQueued'), queueLog(3n, 'IncreaseDelayQueued')];
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => {
      const id = args[1] as bigint;
      if (id === 1n) return [4, now - 604_800 - 5, 1n, 1n, encodeAbiParameters([{ type: 'address' }], [TOKEN])];
      if (id === 2n) return [4, now - 10, 1n, 1n, encodeAbiParameters([{ type: 'address' }], [TOKEN])];
      return [5, now + 10, 1n, 2n, encodeAbiParameters([{ type: 'uint32' }], [60])];
    });
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenWrite', 3n);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'delayWrite', 2n);
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.status])).toEqual([[1n, 'expired'], [2n, 'stale'], [3n, 'pending']]);
    expect(list[0]!.expiresAt).toBe(now - 5);
    expect(list[0]!.warning).toMatch(/QueuedExpired/);
    expect(list[1]!.warning).toMatch(/StaleQueued/);
    expect(list[2]!.warning).toBeNull();
  });

  it('has no recipient parameter: an extra field is refused and nothing is sent', async () => {
    const { rpc, owner: o } = await setup();
    const m = await o.manage(ACCOUNT);
    await expect(m.withdraw({ usdc: '1', to: A(0x99) } as never)).rejects.toThrow(/no recipient/);
    await expect(m.withdraw({ usdc: '1', recipient: A(0x99) } as never)).rejects.toThrow(/always go to the account owner/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('discovers tokens from the account logs but only withdraws Launch tokens', async () => {
    const { rpc, owner: o } = await setup();
    rpc.logs = [agentActionLog({ token: TOKEN }), agentActionLog({ token: A(0xdd) })];
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const res = await (await o.manage(ACCOUNT)).withdrawMany();
    expect(res.tokens.map((t) => t.toLowerCase())).toEqual([TOKEN]);
    expect(sent(rpc).args).toEqual([[TOKEN, zeroAddress]]);
  });
});
