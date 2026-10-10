// Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
// ACCOUNT=0x… AGENT_KEY=0x… node --experimental-strip-types examples/market-maker.ts <token>   (selling needs the opt-in sell permission)
import type { Address } from 'viem';
import { ContractRevertError, createClient, localKey } from '@mercurifi/sdk';

const TOKEN = process.argv[2] as Address;
const TARGET = 50_000n * 10n ** 18n;
const mf = await createClient({
  network: 'testnet',
  ...(process.env.MERCURIFI_API_KEY
    ? { apiKey: process.env.MERCURIFI_API_KEY }
    : {}),
});
const agent = await mf.agent({
  account: process.env.ACCOUNT as Address,
  signer: localKey(process.env.AGENT_KEY!),
  slippage: 0.01,
});
const stop = new AbortController();
process.on('SIGINT', () => stop.abort());

for await (const ev of mf.stream([`token:${TOKEN.toLowerCase()}`], {
  signal: stop.signal,
})) {
  // Curve trades only: after graduation the token trades in a pool, and those arrive as separate `pool_trade` events.
  // Event data is untrusted (it can carry token text): this loop reads no field of it, only the event type.
  if (ev.type !== 'trade') continue; // 'reset' means a gap; the loop re-reads state on the next trade anyway
  const [room, pos] = await Promise.all([
    agent.headroom(),
    agent.position(TOKEN),
  ]);
  try {
    if (pos.balanceWei < TARGET && room.spendUsdc6 >= 2_000_000n) {
      const f = await agent.buy({ token: TOKEN, usdc: '2' });
      console.log(`buy ${f.tokens} for ${f.usdcSpent} USDC`);
    } else if (pos.balanceWei > TARGET * 2n) {
      const f = await agent.sell({
        token: TOKEN,
        amountWei: pos.balanceWei - TARGET,
      });
      console.log(`sell ${f.tokens} for ${f.usdcReceived} USDC`);
    }
  } catch (e) {
    if (e instanceof ContractRevertError)
      console.warn(`skipped: ${e.code} ${e.revert.name}`); // fixed labels, not the message
    else throw e;
  }
}
