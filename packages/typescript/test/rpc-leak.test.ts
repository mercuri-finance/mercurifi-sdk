// Every public read and write preflight, run against a closed loopback port with a secret in the RPC URL's path: the
// secret must not appear in any error's message, stack, own fields or cause chain. Set-up answers come from a MockRpc;
// then the transport's fetch goes to the real (closed) 127.0.0.1:1, so the runtime's own socket errors are exercised.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { createClient } from '../src/client.js';
import { localNetwork } from '../src/networks.js';
import { rpcTransport } from '../src/rpcFetch.js';
import { localKey } from '../src/signers.js';
import { mockAccount, mockCurve } from './helpers/account.js';
import { A, ACCOUNT, AGENT_KEY, localJson, localRpc, OWNER_KEY, TOKEN } from './helpers/local.js';

const SECRET = 'SUPERSECRETKEY123';
const URL_ = `http://127.0.0.1:1/v2/${SECRET}`;

const everything = (e: unknown): string => {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 32 && typeof cur === 'object' && cur !== null; i += 1) {
    out.push(String((cur as Error).message), String((cur as Error).stack));
    for (const v of Object.values(cur)) out.push(typeof v === 'string' ? v : '');
    try {
      out.push(JSON.stringify(cur, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch {
      /* cyclic */
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return out.join('\n');
};

describe('no RPC URL in any error (closed loopback port, secret path)', () => {
  it('sweeps every public read and write preflight', async () => {
    const owner = localKey(OWNER_KEY);
    const agentKey = localKey(AGENT_KEY);
    const rpc = localRpc();
    mockAccount(rpc, { owner: owner.address, agent: agentKey.address });
    mockCurve(rpc);
    const mock = rpc.transport()({ retryCount: 0 } as never);
    let closed = false;
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (closed) return globalThis.fetch(input, init); // ECONNREFUSED from the runtime itself
      const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const result = await mock.request({ method, params } as never);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    };
    const mf = await createClient({ network: localNetwork(localJson()), rpcUrl: URL_, transport: rpcTransport(URL_, fetchFn), pollMs: 1, onWarning: () => undefined });
    const agent = await mf.agent({ account: ACCOUNT, signer: agentKey });
    const ownerClient = mf.owner(owner);
    const m = await ownerClient.manage(ACCOUNT);
    closed = true;

    const other: Address = A(0x5555);
    const calls: [string, () => Promise<unknown>][] = [
      ['token', () => mf.token(TOKEN)],
      ['agent()', () => mf.agent({ account: ACCOUNT, signer: agentKey })],
      ['manage()', () => ownerClient.manage(ACCOUNT)],
      ['status', () => agent.status()],
      ['headroom', () => agent.headroom()],
      ['position', () => agent.position(TOKEN)],
      ['buy', () => agent.buy({ token: TOKEN, usdc: '1' })],
      ['sell', () => agent.sell({ token: TOKEN, amount: 'all' })],
      ['launch', () => agent.launch({ name: 'Ok', symbol: 'OK', metadataURI: 'ipfs://m' })],
      ['swapExactIn buy', () => agent.swapExactIn({ token: TOKEN, side: 'buy', usdc: '1' })],
      ['swapExactIn sell', () => agent.swapExactIn({ token: TOKEN, side: 'sell', amount: 'all' })],
      ['claimFees', () => agent.claimFees()],
      ['sweepToOwner', () => agent.sweepToOwner({ token: TOKEN, amount: 'all' })],
      ['createAccount', () => ownerClient.createAccount()],
      ['deposit', () => ownerClient.deposit(ACCOUNT, { usdc: '1' })],
      ['fundGas', () => ownerClient.fundGas(agentKey.address, { usdc: '1' })],
      ['acceptOwnership', () => ownerClient.acceptOwnership(ACCOUNT, 1n)],
      ['pendingOwnership', () => ownerClient.pendingOwnership(ACCOUNT)],
      ['state', () => m.state()],
      ['previewPolicy', () => m.previewPolicy({ maxTradeUsdc: '1' })],
      ['setPolicy', () => m.setPolicy({ maxTradeUsdc: '1' })],
      ['addAgent', () => m.addAgent(other)],
      ['setAgent', () => m.setAgent(agentKey.address, { permissions: ['buy'] })],
      ['rotateAgent', () => m.rotateAgent(agentKey.address, other)],
      ['revokeAgent', () => m.revokeAgent(agentKey.address)],
      ['setTokenAllowed', () => m.setTokenAllowed(TOKEN, true)],
      ['setIncreaseDelay', () => m.setIncreaseDelay(60)],
      ['transferOwnership', () => m.transferOwnership(other)],
      ['listQueued', () => m.listQueued()],
      ['executeQueued', () => m.executeQueued(1n)],
      ['cancelQueued', () => m.cancelQueued(1n)],
      ['pauseAgents', () => m.pauseAgents(true)],
      ['withdraw', () => m.withdraw({ token: TOKEN, amount: 'all' })],
      ['withdrawMany (discovery)', () => m.withdrawMany()],
    ];
    const leaks: string[] = [];
    for (const [name, f] of calls) {
      const err = await f().then(() => new Error(`${name} did not fail`), (e: unknown) => e);
      if (everything(err).includes(SECRET)) leaks.push(name);
      expect(err, name).toBeInstanceOf(Error);
      expect((err as Error).message, name).not.toMatch(/did not fail/);
    }
    expect(leaks).toEqual([]);
  }, 120_000);
});
