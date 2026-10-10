# Mercurifi Agent Accounts SDK

TypeScript (`packages/typescript`, npm `@mercurifi/sdk`) and Python (`packages/python`, PyPI `mercurifi`) SDKs for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets. Mercurifi never runs agents and never holds an agent key.

## Loss bound

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](docs/security-model.md) before you give a key to a program.

**No deployment yet.** No Agent Accounts deployment exists on any public network yet. Testnet and mainnet agent addresses stay empty until an owner-approved deployment is recorded, and agent operations on them throw `NotDeployedError`; today only a local chain works (chain 31337, loopback RPC, a local address book).

## Install

```
npm install @mercurifi/sdk
pip install mercurifi
```

Neither package is published yet (publishing needs an owner decision). Until then install from a checkout: `cd packages/typescript && npm ci && npm run build`, or `pip install ./packages/python`.

## Quickstart (runs once a testnet deployment is recorded)

```ts
import type { Address } from 'viem';
import { createClient, generateAgentKey, localKey } from '@mercurifi/sdk';

const mf = await createClient({ network: 'testnet' });
const owner = mf.owner(localKey(process.env.OWNER_KEY!));
const key = generateAgentKey(); // demo only: a real bot stores the key in a secret manager and reads it at the call site
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

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap for tokens the account bought. Holdings received from outside (airdrops, transfers in) are valued by a quote an attacker can move; they are not protected by the sell cap — withdraw them.

Full detail, including who else holds power (the guardian pause, the Launch timelock), is in [docs/security-model.md](docs/security-model.md#where-things-live).

## Chain-only or with the API

Every on-chain action works with only an RPC URL. Add an API key (`X-Api-Key`, `mfk_live_…` / `mfk_test_…`) for streams, metadata uploads and the account index. A key sets a rate tier, attribution and route scopes (read, stream, build, upload); it never authorises funds. Uploads need the key owner's agent account to be older than 24 hours.

## Errors

Every error carries a stable `code` and a readable message. A call the account would refuse fails before anything is sent, as a `ContractRevertError` that names the revert. Branch on `code` and `revert.name`, never on message text, and never hand a message to a model.

## ERC-8004 identity (optional)

Both SDKs can build an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) registration file that lists an agent account, plus the calldata to register it on Arc testnet. The owner wallet (an EOA) signs and sends it. The agent account cannot register itself, and it cannot sign (`isValidSignature` always fails), so it is never the registry's verified `agentWallet`. It appears only as a service entry in the file. See "ERC-8004 identity (optional)" in either package README.

## Circle Wallets

A Circle wallet, including a Circle Agent Wallet (a smart-contract account), can be an account's owner, because owner checks are `msg.sender`-based. It cannot be the agent key of a self-hosted agent, because it has no exportable key and signs through Circle's API. No adapter is provided.

## Local development

- Prerequisites for the Anvil tier: Foundry's `anvil` and `forge` on the PATH, and a checkout of the agent contracts (`git clone --recurse-submodules https://github.com/mercuri-finance/mercuri-agent-contracts.git`). Point `MERCURIFI_CONTRACTS_DIR` at it (for example `export MERCURIFI_CONTRACTS_DIR=$HOME/src/agent-contracts`); `scripts/local-chain.sh` and `scripts/gen-abis.mjs` (except `--verify-digest`) stop with a clear message when it is unset.
- `scripts/local-chain.sh` starts a loopback Anvil (chain 31337) on `127.0.0.1:$ANVIL_PORT` (default 8545), deploys the Launch and agent contracts, and writes `fixtures/local-book-<port>.json`. `scripts/stop-local-chain.sh [port]` stops it.
- The test tiers find the chain from the same `ANVIL_PORT`. `ANVIL_RPC` may override the URL; its port then names the book, so keep the two consistent.
- `cd packages/typescript && npm test && npm run typecheck`; `npm run test:integration` runs the Anvil tier (`RECORD=1` rewrites `fixtures/recorded`).
- `cd packages/python && uv run pytest`; `uv run pytest -m integration` runs the Anvil tier.

Nothing here broadcasts to a real network.

## Security

See [docs/security-model.md](docs/security-model.md) and [SECURITY.md](SECURITY.md). Releases are described in [docs/releasing.md](docs/releasing.md) and [docs/verify-provenance.md](docs/verify-provenance.md).
