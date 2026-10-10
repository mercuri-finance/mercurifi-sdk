// Opt-in, read-only check against the public Arc testnet RPC (the SDK's default; never a paid provider). Skipped unless
// MERCURIFI_LIVE_TESTNET=1: `MERCURIFI_LIVE_TESTNET=1 npx vitest run test/live-testnet.test.ts`. Sends nothing.
import { isAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { createClient } from '../src/client.js';
import { getAgent } from '../src/identity.js';
import { TESTNET } from '../src/networks.js';

describe.skipIf(process.env.MERCURIFI_LIVE_TESTNET !== '1')('live Arc testnet (read-only)', () => {
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
});
