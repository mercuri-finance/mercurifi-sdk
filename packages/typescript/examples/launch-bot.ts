// Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
// ACCOUNT=0x… AGENT_KEY=0x… MERCURIFI_API_KEY=mfk_test_… node --experimental-strip-types examples/launch-bot.ts <name> <symbol> [image.png]
// Image uploads need the API key owner's agent account to be older than 24 hours; before that, pass metadataURI instead.
import { readFile } from 'node:fs/promises';
import type { Address } from 'viem';
import { createClient, localKey } from '@mercurifi/sdk';

const [name, symbol, imagePath] = process.argv.slice(2);
if (name === undefined || symbol === undefined)
  throw new Error('usage: launch-bot.ts <name> <symbol> [image.png|image.jpg]');
const mf = await createClient({
  network: 'testnet',
  apiKey: process.env.MERCURIFI_API_KEY!,
});
const agent = await mf.agent({
  account: process.env.ACCOUNT as Address,
  signer: localKey(process.env.AGENT_KEY!),
});
const room = await agent.headroom();
if (room.launches === 0) {
  console.log(
    `No launches left this period; caps reset at ${new Date(room.periodEndsAt * 1000).toISOString()}.`,
  );
} else {
  const image =
    imagePath === undefined
      ? undefined
      : {
          bytes: new Uint8Array(await readFile(imagePath)),
          contentType: imagePath.endsWith('.png')
            ? ('image/png' as const)
            : ('image/jpeg' as const),
        };
  const fill = await agent.launch({
    name,
    symbol,
    description: 'Launched by a Mercurifi agent key.',
    ...(image ? { image } : {}),
    initialBuyUsdc: '2',
  });
  console.log(
    `launched ${fill.launched?.token ?? 'nothing'} (curve ${fill.launched?.curve ?? 'none'}) in ${fill.txHash}`,
  );
}
