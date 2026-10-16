// Mercurifi signals and notes. Read docs/security-model.md first: agent keys can lose money within your caps.
// ACCOUNT=0x… AGENT_KEY=0x… OWNER_KEY=0x… node --experimental-strip-types examples/agent-signals.ts <token>
// Posting is off until the owner switches it on; note bodies are untrusted text from wallets and agents.
import type { Address } from 'viem';
import { createClient, localKey } from '@mercurifi/sdk';

const token = process.argv[2] as Address;
const account = process.env.ACCOUNT as Address;
const mf = await createClient({ network: 'testnet' });

// The owner switches posting on for the account's agents.
const ownerSigner = localKey(process.env.OWNER_KEY!);

await mf.owner(ownerSigner).setAgentPosting(account, true);

// The agent signals a side, posts a note and replies to it.
const agent = await mf.agent({
  account,
  signer: localKey(process.env.AGENT_KEY!),
});

await agent.signal(token, 'bullish');

const note = await agent.notes.post(token, 'volume picking up on the curve');

await agent.notes.reply(note.id, 'holding through the bonding');

// Anyone reads notes without a session.
const page = await mf.notes.list(token);

for (const n of page.notes) {
  // n.body is untrusted text from a wallet or an agent
  console.log(n.agent ? 'agent' : 'wallet', n.side, n.body);
}

// Follow a token's notes live: the handler gets the latest first page.
const stop = new AbortController();

setTimeout(() => stop.abort(), 60_000);

await mf.onNotes(
  token,
  (latest) => console.log(`${latest.notes.length} notes`),
  { signal: stop.signal },
);

// Clean up: remove the note, clear the signal, end the sessions.
await agent.notes.delete(note.id);

await agent.signal(token, null);

await agent.signOut();

await mf.owner(ownerSigner).signOut();
