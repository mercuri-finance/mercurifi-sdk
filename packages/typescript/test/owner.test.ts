import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  parseTransaction,
  toHex,
  zeroAddress,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  agentAccountAbi,
  agentAccountFactoryAbi,
  agentPolicyRegistryAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../src/abi/index.js';
import { InvalidInputError, NotOwnerError } from '../src/errors.js';
import { SELL_RISK_WARNING } from '../src/permissions.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { listQueued, POLICY_TUPLE, scanLogs } from '../src/queue.js';
import { localNetwork } from '../src/networks.js';
import { localKey } from '../src/signers.js';
import {
  agentActionLog,
  eventLog,
  FACTORY,
  LAUNCH_FACTORY,
  mockAccount,
  mockCurve,
  queueLog,
  registryLog,
  REGISTRY,
} from './helpers/account.js';
import {
  A,
  ACCOUNT,
  AGENT_KEY,
  localClient,
  localJson,
  localRpc,
  OWNER_KEY,
  TOKEN,
} from './helpers/local.js';

const owner = localKey(OWNER_KEY);
const agent = localKey(AGENT_KEY);
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const USDC = '0x3600000000000000000000000000000000000000';
const ALL_ABI = [...agentAccountAbi, ...agentPolicyRegistryAbi, ...agentAccountFactoryAbi] as Abi;

/** Lowercases every address so checksummed decodes compare with the lowercase test addresses. */
const norm = (v: unknown): unknown =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
    ? v.toLowerCase()
    : Array.isArray(v)
      ? v.map(norm)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
        : v;

const setup = async (ownerAddress = owner.address, over: Record<string, unknown> = {}) => {
  const rpc = localRpc();
  mockAccount(rpc, { owner: ownerAddress, agent: agent.address });
  mockCurve(rpc, { balance: 5n * 10n ** 18n });
  rpc.read(FACTORY, agentAccountFactoryAbi, 'predictAccount', ACCOUNT);
  rpc.read(FACTORY, agentAccountFactoryAbi, 'createAccount', ACCOUNT);
  rpc.receiptLogs = [
    eventLog(agentAccountFactoryAbi, FACTORY, 'AccountCreated', {
      owner: owner.address,
      account: ACCOUNT,
      salt: SALT,
    }),
  ];
  const onWarning = vi.fn();
  const mf = await localClient(rpc, { onWarning, ...over });
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
    await o.createAccount({
      salt: SALT,
      firstAgent: { address: agent.address, permissions: ['buy', 'sell'] },
    });
    expect(onWarning).toHaveBeenCalledWith(SELL_RISK_WARNING);
  });

  it('refuses a self-referrer, a policy above a ceiling and the owner as agent, sending nothing', async () => {
    const { rpc, owner: o } = await setup();
    await expect(o.createAccount({ salt: SALT, referrer: ACCOUNT })).rejects.toThrow(
      /referrer cannot be the account/,
    );
    await expect(o.createAccount({ salt: SALT, policy: { maxTradeUsdc: '5000' } })).rejects.toThrow(
      /beta ceiling/,
    );
    await expect(
      o.createAccount({ salt: SALT, firstAgent: { address: owner.address } }),
    ).rejects.toThrow(InvalidInputError);
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
    rpc.receiptLogs = [registryLog('PolicyQueued', { id: 4n, eta: 1_700_003_600 })];
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
    rpc.logs = [
      queueLog(1n),
      queueLog(2n, 'IncreaseDelayQueued'),
      queueLog(3n),
      eventLog(agentPolicyRegistryAbi, REGISTRY, 'AgentQueued', { account: A(0x55), id: 9n }),
    ];
    const addPayload = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }],
      [agent.address, now + 86_400, 29],
    );
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => {
      const id = args[1] as bigint;
      if (id === 1n) return [1, now - 10, 1n, 1n, addPayload];
      if (id === 2n) return [5, now + 100, 1n, 1n, encodeAbiParameters([{ type: 'uint32' }], [60])];
      if (id === 3n) return [1, now - 10, 0n, 1n, addPayload];
      throw new Error(`another account's id ${id} was read`);
    });
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.kind, q.status])).toEqual([
      [1n, 'addAgent', 'ready'],
      [2n, 'delay', 'pending'],
      [3n, 'addAgent', 'cancelled'],
    ]);
    expect(list[0]!.detail).toEqual({
      agent: agent.address,
      expiresAt: now + 86_400,
      permissions: ['buy', 'launch', 'swap', 'claim'],
    });
    const filter = rpc.methods('eth_getLogs')[0]![0] as {
      address: string;
      topics: (string | null)[];
    };
    expect(filter.address.toLowerCase()).toBe(REGISTRY);
    expect(filter.topics).toEqual([null, `0x${'0'.repeat(24)}${ACCOUNT.slice(2)}`]);
  });

  it('marks an item stale when its subject was written after it, and lists superseded policy fields', async () => {
    const { rpc, owner: o } = await setup();
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n), queueLog(2n, 'PolicyQueued')];
    const addPayload = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }],
      [agent.address, now + 86_400, 29],
    );
    const policyPayload = encodeAbiParameters(
      [POLICY_TUPLE],
      [{ ...DEFAULT_POLICY, periodSpendCap: 900_000_000n }],
    );
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) =>
      (args[1] as bigint) === 1n
        ? [2, now - 10, 1n, 5n, addPayload]
        : [3, now + 100, 1n, 5n, policyPayload],
    );
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'agentWrite', 7n);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'policyWrite', (args) =>
      (args[1] as bigint) === 0n ? 9n : 0n,
    );
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.kind, q.seq, q.status])).toEqual([
      [1n, 'setAgent', 5n, 'stale'],
      [2n, 'policy', 5n, 'pending'],
    ]);
    expect(list[1]!.detail).toMatchObject({
      superseded: ['maxTradeUsdc'],
      policy: { periodSpendCap: 900_000_000n },
    });
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
    rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 3n })];
    const r = await o.acceptOwnership(ACCOUNT, 3n);
    expect(r.outcome).toBe('immediate');
    expect(sent(rpc)).toEqual({
      to: REGISTRY,
      functionName: 'acceptOwnership',
      args: [ACCOUNT, 3n],
    });
  });

  it('withdraws native USDC in wei from the account and refuses the ERC-20 view', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'withdraw', undefined);
    const m = await o.manage(ACCOUNT);
    await m.withdraw({ usdc: '10' });
    expect(sent(rpc)).toEqual({
      to: ACCOUNT,
      functionName: 'withdraw',
      args: [zeroAddress, 10n * 10n ** 18n],
    });
    await expect(m.withdraw({ token: USDC, amount: '1' })).rejects.toThrow(/as native/);
  });

  it('withdraws native in its own call (first) and the held tokens in another, from the account', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const res = await (await o.manage(ACCOUNT)).withdrawMany([TOKEN, TOKEN, USDC]);
    expect(res.tokens).toEqual([TOKEN]);
    expect(res.txHashes).toHaveLength(2);
    expect(sent(rpc, 0)).toEqual({
      to: ACCOUNT,
      functionName: 'withdrawMany',
      args: [[zeroAddress]],
    });
    expect(sent(rpc, 1)).toEqual({ to: ACCOUNT, functionName: 'withdrawMany', args: [[TOKEN]] });
  });
});

describe('owner UX', () => {
  it('previews which fields apply now and which are queued, with the effective window', async () => {
    const { rpc, owner: o } = await setup();
    const p = await (
      await o.manage(ACCOUNT)
    ).previewPolicy({ maxTradeUsdc: '50', periodSpendCap: '900' });
    const now = Number(rpc.block.timestamp);
    expect(p.immediate).toEqual(['maxTradeUsdc']);
    expect(p.queued).toEqual(['periodSpendCap']);
    expect(p.etaIfQueued).toBe(now + 3_600);
    expect(p.expiresIfQueued).toBe(now + 3_600 + 604_800);
    expect(p.summary[0]).toMatch(/maxTradeUsdc: 100 -> 50 applies immediately/);
    expect(p.summary[1]).toMatch(/periodSpendCap: 500 -> 900 is queued; executable from .* until /);
    const iso = (t: number) => new Date(t * 1000).toISOString();
    expect(
      p.summary[1]!.endsWith(
        `executable from ${iso(now + 3_600)} until ${iso(now + 3_600 + 604_800)}`,
      ),
    ).toBe(true);
    expect(iso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
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
    rpc.logs = [
      queueLog(1n),
      queueLog(2n, 'TokenAllowQueued'),
      queueLog(3n, 'IncreaseDelayQueued'),
    ];
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => {
      const id = args[1] as bigint;
      if (id === 1n)
        return [4, now - 604_800 - 5, 1n, 1n, encodeAbiParameters([{ type: 'address' }], [TOKEN])];
      if (id === 2n)
        return [4, now - 10, 1n, 1n, encodeAbiParameters([{ type: 'address' }], [TOKEN])];
      return [5, now + 10, 1n, 2n, encodeAbiParameters([{ type: 'uint32' }], [60])];
    });
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'tokenWrite', 3n);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'delayWrite', 2n);
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => [q.id, q.status])).toEqual([
      [1n, 'expired'],
      [2n, 'stale'],
      [3n, 'pending'],
    ]);
    expect(list[0]!.expiresAt).toBe(now - 5);
    expect(list[0]!.warning).toMatch(/QueuedExpired/);
    expect(list[1]!.warning).toMatch(/StaleQueued/);
    expect(list[2]!.warning).toBeNull();
  });

  it('has no recipient parameter: an extra field is refused and nothing is sent', async () => {
    const { rpc, owner: o } = await setup();
    const m = await o.manage(ACCOUNT);
    await expect(m.withdraw({ usdc: '1', to: A(0x99) } as never)).rejects.toThrow(/no recipient/);
    await expect(m.withdraw({ usdc: '1', recipient: A(0x99) } as never)).rejects.toThrow(
      /always go to the account owner/,
    );
    expect(rpc.sent).toHaveLength(0);
  });

  it('discovers tokens from the account logs but only withdraws Launch tokens', async () => {
    const { rpc, owner: o } = await setup();
    rpc.logs = [agentActionLog({ token: TOKEN }), agentActionLog({ token: A(0xdd) })];
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const res = await (await o.manage(ACCOUNT)).withdrawMany();
    expect(res.tokens.map((t) => t.toLowerCase())).toEqual([TOKEN]);
    expect(sent(rpc, 1).args).toEqual([[TOKEN]]);
  });
});

const AGENT2 = A(0x66);
const NEW_OWNER = A(0x55);
const asAddr = (a: string) => a as `0x${string}`;
const mgr = async (over: Record<string, unknown> = {}, ownerAddress = owner.address) => {
  const t = await setup(ownerAddress, over);
  t.rpc.receiptLogs = [];
  return { ...t, m: await t.owner.manage(ACCOUNT) };
};
const AG = agent.address.toLowerCase();

describe('owner functions: target, arguments and outcome', () => {
  it('addAgent queues on the registry; id and ETA come from the mined event', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'addAgent', 6n);
    rpc.receiptLogs = [registryLog('AgentQueued', { id: 6n, eta: 1_700_003_600 })];
    const r = await m.addAgent(AGENT2, { expiresInDays: 30, permissions: ['buy'] });
    const s = sent(rpc);
    expect([s.to, s.functionName, s.args[0], s.args[1], s.args[3]]).toEqual([
      REGISTRY,
      'addAgent',
      ACCOUNT,
      AGENT2,
      1,
    ]);
    expect(s.args[2]).toBe(Number(rpc.block.timestamp) + 30 * 86_400);
    expect([r.outcome, r.queuedId, r.eta]).toEqual(['queued', 6n, 1_700_003_600]);
    expect(r.summary).toMatch(/queued as item 6/);
  });

  it('addAgent refuses an expiry the queue delay would outlive, sending nothing', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'increaseDelay', 2 * 86_400);
    await expect(m.addAgent(AGENT2, { expiresInDays: 2 })).rejects.toThrow(
      /could never be executed/,
    );
    await expect(m.rotateAgent(agent.address, AGENT2, { expiresInDays: 1 })).rejects.toThrow(
      /could never be executed/,
    );
    expect(rpc.sent).toHaveLength(0);
  });

  it('addAgent warns when the account already has 8 active agents', async () => {
    const { rpc, m, onWarning } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'activeAgentCount', 8);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'addAgent', 6n);
    rpc.receiptLogs = [registryLog('AgentQueued', { id: 6n, eta: 1_700_003_600 })];
    const r = await m.addAgent(AGENT2);
    expect(r.warnings.join(' ')).toMatch(/TooManyAgents/);
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/TooManyAgents/));
  });

  it('setAgent applies narrower terms now (queued id 0 maps to immediate)', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setAgent', 0n);
    const r = await m.setAgent(agent.address, { permissions: ['buy'] });
    const s = sent(rpc);
    expect([s.to, s.functionName, s.args]).toEqual([
      REGISTRY,
      'setAgent',
      [ACCOUNT, AG, 1_800_000_000, 1],
    ]);
    expect([r.outcome, r.queuedId, r.eta]).toEqual(['immediate', null, null]);
  });

  it('setAgent queues wider terms and warns that the old terms stay', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'agent', {
      active: true,
      expiresAt: 1_800_000_000,
      permissions: 1,
    });
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setAgent', 9n);
    rpc.receiptLogs = [registryLog('AgentQueued', { id: 9n, eta: 1_700_003_600 })];
    const r = await m.setAgent(agent.address, { permissions: ['buy', 'swap'] });
    expect(sent(rpc).args).toEqual([ACCOUNT, AG, 1_800_000_000, 9]);
    expect([r.outcome, r.queuedId]).toEqual(['queued', 9n]);
    expect(r.warnings.join(' ')).toMatch(/old terms stay/);
  });

  it('rotateAgent revokes the old key now and queues the new one', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'rotateAgent', 11n);
    rpc.receiptLogs = [registryLog('AgentQueued', { id: 11n, eta: 1_700_003_600 })];
    const r = await m.rotateAgent(agent.address, AGENT2, { expiresInDays: 30 });
    const s = sent(rpc);
    expect([s.to, s.functionName, s.args[0], s.args[1], s.args[2], s.args[4]]).toEqual([
      REGISTRY,
      'rotateAgent',
      ACCOUNT,
      AG,
      AGENT2,
      1 | 4 | 8 | 16,
    ]);
    expect([r.outcome, r.queuedId]).toEqual(['mixed', 11n]);
  });

  it('a queue-only call without a *Queued event is an error, not a silent success', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'addAgent', 6n);
    await expect(m.addAgent(AGENT2)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });

  it('revokeAgent is immediate', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'revokeAgent', undefined);
    const r = await m.revokeAgent(agent.address);
    expect(sent(rpc)).toEqual({ to: REGISTRY, functionName: 'revokeAgent', args: [ACCOUNT, AG] });
    expect(r.outcome).toBe('immediate');
  });

  it('setIncreaseDelay: raise is immediate, lower is queued, equal sends nothing', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setIncreaseDelay', 0n);
    const up = await m.setIncreaseDelay(7_200);
    expect(sent(rpc)).toEqual({
      to: REGISTRY,
      functionName: 'setIncreaseDelay',
      args: [ACCOUNT, 7_200],
    });
    expect(up.outcome).toBe('immediate');
    expect(up.warnings.join(' ')).toMatch(/postpones every item already queued/);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setIncreaseDelay', 12n);
    rpc.receiptLogs = [
      registryLog('IncreaseDelayQueued', { id: 12n, delay: 60, eta: 1_700_003_600 }),
    ];
    const down = await m.setIncreaseDelay(60);
    expect(sent(rpc, 1).args).toEqual([ACCOUNT, 60]);
    expect([down.outcome, down.queuedId, down.eta]).toEqual(['queued', 12n, 1_700_003_600]);
    expect(down.warnings.join(' ')).toMatch(/Lowering the delay/);
    const same = await m.setIncreaseDelay(3_600);
    expect(same.outcome).toBe('none');
    expect(rpc.sent).toHaveLength(2);
  });

  it('transferOwnership queues, warns and names the accept step', async () => {
    const { rpc, m, onWarning } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'transferOwnership', 8n);
    rpc.receiptLogs = [
      registryLog('OwnershipQueued', { id: 8n, newOwner: NEW_OWNER, eta: 1_700_003_600 }),
    ];
    const r = await m.transferOwnership(NEW_OWNER);
    expect(sent(rpc)).toEqual({
      to: REGISTRY,
      functionName: 'transferOwnership',
      args: [ACCOUNT, NEW_OWNER],
    });
    expect([r.outcome, r.queuedId]).toEqual(['queued', 8n]);
    expect(r.warnings.join(' ')).toMatch(/acceptOwnership/);
    expect(r.warnings.join(' ')).toMatch(/retires the new owner as an agent/);
    expect(onWarning).toHaveBeenCalled();
  });

  it('setTokenAllowed(true) warns; an id-0 race is MISSING_EVENT unless the receipt shows it applied; false is immediate', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setTokenAllowed', 0n);
    rpc.receiptLogs = [];
    await expect(m.setTokenAllowed(TOKEN, true)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
    expect(sent(rpc)).toEqual({
      to: REGISTRY,
      functionName: 'setTokenAllowed',
      args: [ACCOUNT, TOKEN, true],
    });
    rpc.receiptLogs = [registryLog('TokenAllowed', { token: TOKEN, allowed: true })];
    const r = await m.setTokenAllowed(TOKEN, true);
    expect([r.outcome, r.queuedId]).toEqual(['immediate', null]);
    expect(r.warnings.length).toBeGreaterThan(0);
    rpc.receiptLogs = [];
    const off = await m.setTokenAllowed(TOKEN, false);
    expect(off.outcome).toBe('immediate');
  });

  it('a queued decision with an event of another account is still MISSING_EVENT', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setTokenAllowed', 0n);
    rpc.receiptLogs = [
      registryLog('TokenAllowed', { account: A(0x99), token: TOKEN, allowed: true }),
    ];
    await expect(m.setTokenAllowed(TOKEN, true)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });

  it('executeQueued reports executed vs cancelled from the receipt', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', [1, 1_700_000_000, 1n, 1n, '0x']);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'executeQueued', undefined);
    rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 3n })];
    const ok = await m.executeQueued(3n);
    expect(sent(rpc)).toEqual({ to: REGISTRY, functionName: 'executeQueued', args: [ACCOUNT, 3n] });
    expect(ok.outcome).toBe('immediate');
    rpc.receiptLogs = [registryLog('QueuedCancelled', { id: 3n })];
    const voided = await m.executeQueued(3n);
    expect(voided.outcome).toBe('cancelled');
    expect(voided.summary).toMatch(/nothing was applied/);
    rpc.receiptLogs = [];
    await expect(m.executeQueued(3n)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });

  it('executeQueued refuses ownership items and unknown ids locally', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) =>
      (args[1] as bigint) === 8n
        ? [6, 1_700_000_000, 1n, 1n, encodeAbiParameters([{ type: 'address' }], [NEW_OWNER])]
        : [0, 0, 0n, 0n, '0x'],
    );
    await expect(m.executeQueued(8n)).rejects.toThrow(/acceptOwnership/);
    await expect(m.executeQueued(99n)).rejects.toThrow(/no queued item 99/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('cancelQueued and pauseAgents go to the registry', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'cancelQueued', undefined);
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'pauseAgents', undefined);
    expect((await m.cancelQueued(4n)).outcome).toBe('immediate');
    const p = await m.pauseAgents(true);
    expect(sent(rpc, 0)).toEqual({
      to: REGISTRY,
      functionName: 'cancelQueued',
      args: [ACCOUNT, 4n],
    });
    expect(sent(rpc, 1)).toEqual({
      to: REGISTRY,
      functionName: 'pauseAgents',
      args: [ACCOUNT, true],
    });
    expect(p.warnings.join(' ')).toMatch(/voids every queued item/);
  });

  it('acceptOwnership requires the QueuedExecuted event', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'acceptOwnership', undefined);
    rpc.receiptLogs = [];
    await expect(o.acceptOwnership(ACCOUNT, 3n)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });

  it('createAccount throws when the factory event is missing', async () => {
    const { rpc, owner: o } = await setup();
    rpc.receiptLogs = [];
    await expect(o.createAccount({ salt: SALT })).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });
});

describe('queue view: owner items, unexecutable agents, incoming owner, API', () => {
  const ownerPayload = (a: string) => encodeAbiParameters([{ type: 'address' }], [asAddr(a)]);
  const agentPayload = (expiresAt: number) =>
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }],
      [agent.address, expiresAt, 1],
    );

  it('flags agent items that expire before they can run, and explains owner items', async () => {
    const { rpc, m } = await mgr();
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n), queueLog(2n, 'OwnershipQueued'), queueLog(3n, 'OwnershipQueued')];
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => {
      const id = args[1] as bigint;
      if (id === 1n) return [1, now + 3_600, 1n, 1n, agentPayload(now + 1_800)];
      if (id === 2n) return [6, now + 100, 1n, 1n, ownerPayload(NEW_OWNER)];
      return [6, now - 10, 0n, 1n, ownerPayload(NEW_OWNER)];
    });
    const list = await m.listQueued();
    expect(list.map((q) => [q.id, q.kind, q.status])).toEqual([
      [1n, 'addAgent', 'unexecutable'],
      [2n, 'owner', 'pending'],
      [3n, 'owner', 'cancelled'],
    ]);
    expect(list[0]!.warning).toMatch(/AgentExpiryOutOfRange/);
    expect(list[1]!.warning).toMatch(/new owner calling acceptOwnership/);
    expect(list[2]!.warning).toMatch(/Only cancelQueued clears it/);
    expect(list[1]!.detail).toEqual({ newOwner: NEW_OWNER });
  });

  it('pendingOwnership lists transfers addressed to the signer, usable by a non-owner', async () => {
    const { rpc, owner: o } = await setup(NEW_OWNER);
    const now = Number(rpc.block.timestamp);
    rpc.logs = [queueLog(1n, 'OwnershipQueued'), queueLog(2n, 'OwnershipQueued')];
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', (args) => [
      6,
      now - 10,
      1n,
      1n,
      ownerPayload((args[1] as bigint) === 1n ? owner.address : A(0x77)),
    ]);
    const mine = await o.pendingOwnership(ACCOUNT);
    expect(mine.map((q) => [q.id, q.status])).toEqual([[1n, 'ready']]);
  });

  it('uses the API for candidate ids when a key is configured, verifying each on chain, and never scans logs', async () => {
    const now = 1_700_000_000;
    const api = {
      getAccount: vi.fn(async () => ({
        pending: [
          { id: '1', kind: 'x', eta: 0, expiresAt: 0, payload: null },
          { id: 'zz', kind: 'x', eta: 0, expiresAt: 0, payload: null },
        ],
      })),
    };
    const { rpc, owner: o } = await setup(owner.address, { api, apiKey: 'k' });
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', [
      1,
      now - 10,
      1n,
      1n,
      agentPayload(now + 86_400),
    ]);
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(list.map((q) => q.id)).toEqual([1n]);
    expect(rpc.methods('eth_getLogs')).toHaveLength(0);
  });

  it('falls back to bounded log scans when the API fails, and ignores the API without a key', async () => {
    const api = {
      getAccount: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    const a = await setup(owner.address, { api, apiKey: 'k' });
    a.rpc.logs = [];
    expect(await (await a.owner.manage(ACCOUNT)).listQueued()).toEqual([]);
    expect(api.getAccount).toHaveBeenCalledTimes(1);
    expect(a.rpc.methods('eth_getLogs').length).toBeGreaterThan(0);
    const api2 = { getAccount: vi.fn() };
    const b = await setup(owner.address, { api: api2 });
    await (await b.owner.manage(ACCOUNT)).listQueued();
    expect(api2.getAccount).not.toHaveBeenCalled();
  });
});

describe('withdraw rules', () => {
  const DD = A(0xdd);
  it('rejects mixed or missing amount fields', async () => {
    const { rpc, m } = await mgr();
    for (const bad of [
      { usdc: '1', all: true },
      { usdc: '1', usdc6: 1n },
      { usdc: '1', amount: '1' },
      { amount: '1' },
      { token: TOKEN, usdc: '1' },
      {},
      { token: TOKEN, amount: '1', amountWei: 1n },
    ]) {
      await expect(m.withdraw(bad as never)).rejects.toThrow(InvalidInputError);
    }
    expect(rpc.sent).toHaveLength(0);
  });

  it('does not guess decimals for a non-Launch token: amountWei or all only', async () => {
    const { rpc, m } = await mgr();
    rpc.read(DD, launchTokenAbi, 'balanceOf', 7n);
    rpc.read(ACCOUNT, agentAccountAbi, 'withdraw', undefined);
    await expect(m.withdraw({ token: DD, amount: '1' })).rejects.toThrow(/amountWei/);
    await m.withdraw({ token: DD, amountWei: 5n });
    await m.withdraw({ token: DD, all: true });
    expect(sent(rpc, 0)).toEqual({ to: ACCOUNT, functionName: 'withdraw', args: [DD, 5n] });
    expect(sent(rpc, 1)).toEqual({ to: ACCOUNT, functionName: 'withdraw', args: [DD, 7n] });
  });

  it('withdrawMany sends nothing when there is nothing to move', async () => {
    const { rpc, m } = await mgr();
    rpc.balances.set(ACCOUNT, 0n);
    rpc.read(TOKEN, launchTokenAbi, 'balanceOf', 0n);
    const r = await m.withdrawMany([TOKEN]);
    expect(r.txHashes).toEqual([]);
    expect(rpc.sent).toHaveLength(0);
  });

  it('merges the API token list with the chain scan, so an API that omits a token cannot hide it', async () => {
    const other = A(0xde);
    const listActions = vi.fn(async () => ({ items: [{ token: TOKEN }], nextCursor: null }));
    const { rpc, m } = await mgr({ api: { listActions } });
    rpc.read(LAUNCH_FACTORY, launchFactoryAbi, 'curveOf', () => A(0xcc));
    rpc.read(TOKEN, launchTokenAbi, 'balanceOf', 3n);
    rpc.read(other, launchTokenAbi, 'balanceOf', 7n);
    rpc.logs = [agentActionLog({ token: other })];
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const r = await m.withdrawMany();
    expect(listActions).toHaveBeenCalledTimes(1);
    expect(r.tokens.map((t) => t.toLowerCase()).sort()).toEqual(
      [TOKEN, other].map((t) => t.toLowerCase()).sort(),
    );
  });

  it('caps API pagination at 50 pages, then reads the chain', async () => {
    const listActions = vi.fn(async () => ({ items: [], nextCursor: 'more' }));
    const { rpc, m } = await mgr({ api: { listActions } });
    rpc.balances.set(ACCOUNT, 0n);
    rpc.logs = [agentActionLog({ token: TOKEN })];
    rpc.read(ACCOUNT, agentAccountAbi, 'withdrawMany', undefined);
    const r = await m.withdrawMany();
    expect(listActions).toHaveBeenCalledTimes(50);
    expect(r.tokens.map((t) => t.toLowerCase())).toEqual([TOKEN]);
  });
});

describe('owner client polish', () => {
  it('puts the sell-risk warning into result.warnings as well as onWarning', async () => {
    const { rpc, m, onWarning } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'addAgent', 6n);
    rpc.receiptLogs = [registryLog('AgentQueued', { id: 6n, eta: 1_700_003_600 })];
    const r = await m.addAgent(A(0x51), { permissions: ['buy', 'sell'] });
    expect(r.warnings).toContain(SELL_RISK_WARNING);
    expect(onWarning).toHaveBeenCalledWith(SELL_RISK_WARNING);
  });

  it('still scans recent logs when the API answers with an empty pending list', async () => {
    const api = { getAccount: vi.fn(async () => ({ pending: [] })) };
    const { rpc, owner: o } = await setup(owner.address, { api, apiKey: 'k' });
    rpc.logs = [queueLog(1n)];
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'queued', [
      1,
      1_700_000_000 - 10,
      1n,
      1n,
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint40' }, { type: 'uint16' }],
        [A(0x51), 1_800_000_000, 1],
      ),
    ]);
    const list = await (await o.manage(ACCOUNT)).listQueued();
    expect(api.getAccount).toHaveBeenCalledTimes(1);
    expect(rpc.methods('eth_getLogs').length).toBeGreaterThan(0);
    expect(list.map((q) => q.id)).toEqual([1n]);
  });

  it('warns that raising the delay can push queued agent items past their expiry', async () => {
    const { rpc, m } = await mgr();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'setIncreaseDelay', 0n);
    const r = await m.setIncreaseDelay(7_200);
    expect(r.warnings.join(' ')).toMatch(/past its own expiry/);
  });

  it('warns about agent retirement on acceptOwnership only when the signer is an agent', async () => {
    const plain = await setup();
    plain.rpc.read(REGISTRY, agentPolicyRegistryAbi, 'acceptOwnership', undefined);
    plain.rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 3n })];
    expect((await plain.owner.acceptOwnership(ACCOUNT, 3n)).warnings).toEqual([]);

    const asAgent = await setup();
    asAgent.rpc.read(REGISTRY, agentPolicyRegistryAbi, 'acceptOwnership', undefined);
    asAgent.rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 3n })];
    const r = await asAgent.mf.owner(agent).acceptOwnership(ACCOUNT, 3n);
    expect(r.warnings.join(' ')).toMatch(/retires it as an agent/);
  });

  it('does not accept a QueuedExecuted for a different id or another account', async () => {
    const { rpc, owner: o } = await setup();
    rpc.read(REGISTRY, agentPolicyRegistryAbi, 'acceptOwnership', undefined);
    rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 4n })];
    await expect(o.acceptOwnership(ACCOUNT, 3n)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
    rpc.receiptLogs = [registryLog('QueuedExecuted', { id: 3n, account: A(0x88) })];
    await expect(o.acceptOwnership(ACCOUNT, 3n)).rejects.toMatchObject({ code: 'MISSING_EVENT' });
  });
});

describe('scanLogs without toBlock', () => {
  const scanTo = (rpc: ReturnType<typeof localRpc>, from: number) =>
    rpc.calls
      .slice(from)
      .filter((c) => c.method === 'eth_getLogs')
      .map((c) => (c.params[0] as { toBlock: Hex }).toBlock)
      .at(-1);

  it('scans to the current head even when the client caches the block number', async () => {
    const rpc = localRpc();
    const cached = createPublicClient({ transport: rpc.transport() }) as PublicClient; // viem default cacheTime: 4 s
    await cached.getBlockNumber();
    rpc.block.number += 7n;
    const from = rpc.calls.length;
    await scanLogs(cached, { address: REGISTRY }, rpc.block.number - 3n);
    expect(scanTo(rpc, from)).toBe(toHex(rpc.block.number));
  });

  it('does not join a block-number request already in flight from before the head moved', async () => {
    const rpc = localRpc();
    const client = createPublicClient({ transport: rpc.transport(), cacheTime: 0 }) as PublicClient;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const old = rpc.block.number;
    rpc.on('eth_blockNumber', async () => {
      await gate;
      return toHex(old);
    });
    const inflight = client.getBlockNumber({ cacheTime: 0 });
    rpc.block.number += 7n;
    const from = rpc.calls.length;
    const scan = scanLogs(client, { address: REGISTRY }, old);
    release();
    await Promise.all([inflight, scan]);
    expect(scanTo(rpc, from)).toBe(toHex(rpc.block.number));
  });
});

describe('listQueued with a caller-supplied client', () => {
  it('scans up to the current head even when the client caches the block number', async () => {
    const rpc = localRpc();
    mockAccount(rpc, { owner: owner.address, agent: agent.address });
    const cached = createPublicClient({ transport: rpc.transport() }) as PublicClient; // viem default: block number cached
    await cached.getBlockNumber(); // warms the cache at the old head
    rpc.block.number += 7n;
    const from = rpc.calls.length;
    await listQueued(cached, localNetwork(localJson()).agents!, ACCOUNT);
    const scans = rpc.calls
      .slice(from)
      .filter((c) => c.method === 'eth_getLogs')
      .map((c) => (c.params[0] as { toBlock: Hex }).toBlock);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.at(-1)).toBe(toHex(rpc.block.number));
  });
});
