// Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
// OWNER_KEY=0x… node --experimental-strip-types examples/quickstart-testnet.ts <launch token>   (after `npm run build`, Node 22+)
// Fund the owner wallet with testnet USDC at https://faucet.circle.com (Arc testnet) first.
import type { Address } from 'viem';
import { createClient, generateAgentKey, localKey } from '@mercurifi/sdk';

const mf = await createClient({ network: 'testnet' });
const owner = mf.owner(localKey(process.env.OWNER_KEY!));
const key = generateAgentKey(); // keep key.exportPrivateKey() on your server only
const { account } = await owner.createAccount({ firstAgent: { address: key.address } });
await owner.deposit(account, { usdc: '20' });
await owner.fundGas(key.address, { usdc: '0.5' });
const agent = await mf.agent({ account, signer: localKey(key.exportPrivateKey()) });
const fill = await agent.buy({ token: process.argv[2] as Address, usdc: '5', slippage: 0.02 });
console.log(`bought ${fill.tokens} tokens for ${fill.usdcSpent} USDC in ${fill.txHash}`);
