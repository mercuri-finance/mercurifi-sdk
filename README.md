# Mercurifi Agent Accounts SDK

TypeScript (`packages/typescript`, npm `@mercurifi/sdk`) and Python (`packages/python`, PyPI `mercurifi`) SDKs for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets. Mercurifi never runs agents and never holds an agent key.

## Loss bound

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](docs/security-model.md) before you give a key to a program.

**Testnet only for now.** No mainnet agent factory is deployed: the mainnet agent addresses in this SDK are empty until an owner-approved deployment is recorded, and agent operations on mainnet throw `NotDeployedError`. Use `'testnet'` (Arc testnet, chain 5042002); a local Anvil book (chain 31337, loopback RPC) is also accepted.

## Install

```
npm install @mercurifi/sdk
pip install mercurifi
```

Neither package is published yet (publishing needs an owner decision). Until then install from a checkout: `cd packages/typescript && npm ci && npm run build`, or `pip install ./packages/python`.

## Quickstart (testnet)

```ts
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
```

The Python quickstart is in [packages/python/README.md](packages/python/README.md); more examples are in `packages/typescript/examples/` and `packages/python/examples/`.

## Units

Amounts are human strings in `usdc` / `amount` (`usdc: '25'`, `amount: '1000.5'`). Base units go only in the separately named fields `usdc6` and `amountWei` (`bigint`). A JavaScript `number` in a human field is rejected, never guessed. The Python SDK also accepts `Decimal`, takes `usdc6` and `amount_wei` as `int`, and rejects an `int` or `float` in a human field.

## Owner and agent

The owner (main wallet) creates the account, deposits and sets policy; an agent key trades inside the policy. Owner settings are on the policy registry and funds are on the account:

- The account (`AgentAccount`) holds the funds and the cost basis and is the only contract an agent key calls.
- The owner's settings, the queue, the pause and the usage counters live in the policy registry (`AgentPolicyRegistry`: one per factory, immutable, no admin and no owner of its own). Each owner call names the account.
- The factory creates accounts and sets the beta ceilings.

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap.

Full detail, including who else holds power (the guardian pause, the Launch timelock), is in [docs/security-model.md](docs/security-model.md#where-things-live).

## Chain-only or with the API

Every on-chain action works with only an RPC URL. Add an API key (`X-Api-Key`, `mfk_live_…` / `mfk_test_…`) for streams, metadata uploads and the account index. A key only selects a rate tier; it never authorises funds.

## Errors

Every error carries a stable `code` and a readable message. A call the account would refuse fails before anything is sent, as a `ContractRevertError` that names the revert. Branch on `code` and `revert.name`, never on message text, and never hand a message to a model.

## Local development

- `scripts/local-chain.sh` starts a loopback Anvil (chain 31337) with the agent contracts.
- `cd packages/typescript && npm test && npm run typecheck`; `npm run test:integration` runs the Anvil tier.
- `cd packages/python && uv run pytest`; `uv run pytest -m integration` runs the Anvil tier.

Nothing here broadcasts to a real network.

## Security

See [docs/security-model.md](docs/security-model.md) and [SECURITY.md](SECURITY.md). Releases are described in [docs/releasing.md](docs/releasing.md) and [docs/verify-provenance.md](docs/verify-provenance.md).
