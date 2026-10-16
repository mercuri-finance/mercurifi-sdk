// Opt-in check against the public Arc testnet RPC (the SDK's default; never a paid provider). Skipped unless
// MERCURIFI_LIVE_TESTNET=1: `MERCURIFI_LIVE_TESTNET=1 npx vitest run test/live-testnet.test.ts`. The first tests are read-only; the
// signals test below also needs MERCURIFI_TEST_AGENT_KEY, MERCURIFI_TEST_AGENT_ACCOUNT and MERCURIFI_TEST_TOKEN (and, for the
// owner step, MERCURIFI_TEST_OWNER_KEY) and writes one signal and one note to the testnet API, then removes them.
import { isAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';

import type { AgentClient } from '../src/agent.js';
import { createClient } from '../src/client.js';
import { getAgent } from '../src/identity.js';
import { TESTNET } from '../src/networks.js';
import { localKey } from '../src/signers.js';

describe.skipIf(process.env.MERCURIFI_LIVE_TESTNET !== '1')('live Arc testnet (opt-in)', () => {
  it(
    'passes start-up verification of the pinned agent deployment',
    { timeout: 60_000 },
    async () => {
      const mf = await createClient({ network: 'testnet', api: null });
      expect(mf.requireAgents()).toBe(TESTNET.agents);
      expect(await mf.publicClient.getBlockNumber()).toBeGreaterThan(TESTNET.agents!.deployBlock);
    },
  );
  it('reads an agent from the ERC-8004 IdentityRegistry', { timeout: 60_000 }, async () => {
    const mf = await createClient({ network: 'testnet', api: null });
    const agent = await getAgent(mf.publicClient, { network: 'testnet', agentId: 1n });
    expect(agent.agentId).toBe(1n);
    expect(isAddress(agent.owner)).toBe(true);
  });
  const agentKey = process.env.MERCURIFI_TEST_AGENT_KEY;
  const agentAccount = process.env.MERCURIFI_TEST_AGENT_ACCOUNT ?? '';
  const ownerKey = process.env.MERCURIFI_TEST_OWNER_KEY;
  // A Launch token on testnet to signal on; the account's owner must have switched posting on for the agent flow.
  const token = process.env.MERCURIFI_TEST_TOKEN ?? '';
  const hasAgent =
    agentKey !== undefined && agentKey !== '' && isAddress(agentAccount) && isAddress(token);

  it.skipIf(!hasAgent)(
    'agent signals, posts, reads the note back and cleans up',
    { timeout: 120_000 },
    async () => {
      const mf = await createClient({ network: 'testnet' });
      let agent: AgentClient | null = null;
      let id: number | null = null;
      try {
        // Built inside the try so the cleanup below always runs.
        agent = await mf.agent({
          account: agentAccount as Address,
          signer: localKey(agentKey!),
        });
        await agent.signal(token as Address, 'bullish');
        const note = await agent.notes.post(token as Address, `sdk live check ${Date.now()}`);
        id = note.id;
        const read = await mf.notes.get(id);
        expect(read.agent).toBe(true);
        expect(read.body).toBe(note.body);
        expect((await mf.notes.list(token as Address)).notes.some((n) => n.id === id)).toBe(true);
      } finally {
        // Each step runs even if an earlier one throws; the first failure is rethrown.
        const errors: unknown[] = [];
        const attempt = async (step: () => Promise<void>) => {
          try {
            await step();
          } catch (e) {
            errors.push(e);
          }
        };
        const a = agent;
        if (a !== null) {
          if (id !== null) await attempt(() => a.notes.delete(id!));
          await attempt(() => a.signal(token as Address, null));
          await attempt(() => a.signOut());
        }
        if (errors.length > 0) throw errors[0];
      }
    },
  );

  it.skipIf(!hasAgent || ownerKey === undefined || ownerKey === '')(
    'owner reads the posting switch (never turns it off)',
    { timeout: 60_000 },
    async () => {
      const mf = await createClient({ network: 'testnet' });
      const owner = mf.owner(localKey(ownerKey!));
      try {
        const posting = await owner.agentPosting(agentAccount as Address);
        expect(typeof posting.enabled).toBe('boolean');
      } finally {
        await owner.signOut();
      }
    },
  );
});
