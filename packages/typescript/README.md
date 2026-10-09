# @mercurifi/sdk

TypeScript SDK for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets.

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](../../docs/security-model.md) before you give a key to a program.

**No deployment yet.** No Agent Accounts deployment exists on any public network yet. Testnet and mainnet agent addresses stay empty until an owner-approved deployment is recorded, and agent operations on them throw `NotDeployedError`; today only a local chain works (chain 31337, loopback RPC, a local address book).

## Install

```
npm install @mercurifi/sdk
```

Not yet published; until then build from the repository checkout (`cd packages/typescript && npm ci && npm run build`). Node 20 or newer. The one runtime dependency is `viem`.

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

More in `examples/`: `market-maker.ts`, `launch-bot.ts` and `llm-tools.ts` (tool definitions for a model, numbers only). The market maker reacts to curve `trade` events; after graduation a token trades in a pool and those arrive as separate `pool_trade` events.

## Units

Amounts are human strings in `usdc` / `amount` (`usdc: '25'`, `amount: '1000.5'`). Base units go only in the separately named fields `usdc6` and `amountWei` (`bigint`). A JavaScript `number` in a human field is rejected, never guessed.

## Where things live

- The account (`AgentAccount`) holds the funds and the cost basis and is the only contract an agent key calls.
- The owner's settings, the queue, the pause and the usage counters live in the policy registry (`AgentPolicyRegistry`: one per factory, immutable, no admin and no owner of its own). Each owner call names the account.
- The factory creates accounts and sets the beta ceilings.

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap for tokens the account bought. Holdings received from outside (airdrops, transfers in) are valued by a quote an attacker can move; they are not protected by the sell cap — withdraw them.

## API

| Method | What it does | Calls | Permission |
|---|---|---|---|
| `owner.createAccount` | Creates an account with a policy and an optional first agent | factory `createAccount` | owner wallet |
| `owner.deposit`, `owner.fundGas` | Sends native USDC to the account, or to an agent key for gas | plain transfer | owner wallet |
| `manage(account).addAgent` / `setAgent` / `rotateAgent` / `revokeAgent` | Agent keys; additions and widenings are queued behind the delay | registry | owner |
| `manage(account).previewPolicy` / `setPolicy` | Policy; narrowing now, widening queued | registry `setPolicy` | owner |
| `manage(account).setTokenAllowed`, `setIncreaseDelay`, `transferOwnership` | Allowlist, delay, ownership (queued when widening) | registry | owner |
| `manage(account).listQueued` / `executeQueued` / `cancelQueued` | The delayed-widening queue, with `pending`, `ready`, `expired`, `cancelled` and `stale` items | registry (reads and logs) | owner (execute: anyone) |
| `owner.acceptOwnership` | Completes a queued transfer | registry `acceptOwnership` | the new owner |
| `manage(account).pauseAgents` | Stops every agent at once and voids the queue | registry | owner |
| `manage(account).withdraw` / `withdrawMany` | Moves funds to the owner | account | owner |
| `agent.buy` / `agent.sell` | Curve trades | account | `buy` / `sell` |
| `agent.launch` | Launches a token with the account as creator | account | `launch` |
| `agent.swapExactIn` | Graduated-pool swap | account | `swap` |
| `agent.claimFees` | Claims creator and referral fees into the account | account | `claim` |
| `agent.sweepToOwner` | Moves USDC or a Launch token to the owner | account | `sweep` |
| `agent.headroom` / `position` / `status` | What is left this period, a token position with its cost basis and high-water, the key's standing | registry and account (reads) | none |
| `mf.token(address)` | Agent-safe view of a Launch token (see below) | factory, curve, fee manager (reads) | none |

## Using the API

The Mercurifi API is optional: every on-chain action works with a chain-only client, and `mf.stream(...)` and launch metadata uploads need the API. `createClient({ network: 'testnet', apiKey: process.env.MERCURIFI_API_KEY })` sends the key as `X-Api-Key`. Streams take `launches`, `trades`, `token:<address>`, `trader:<address>` and `agent-account:<address>` topics and reconnect with `Last-Event-ID`.

## Errors

Every error is a `MercurifiError` with a stable `code`. A refused call is a `ContractRevertError` with `revert.name` and a readable message; a transaction that was mined and reverted is a `TxRevertedError`; a transaction Arc dropped is a `TxDroppedError` (re-read `agent.headroom()` before you retry). Branch on `code`, not on message text.

## Untrusted text for models

Token names, symbols, descriptions and links are written by whoever launched the token. `mf.token(address)` returns a `TokenSafeView`: `view.numeric()` holds only numbers, booleans, fixed labels and hex, so it is safe to hand to a model; everything else is in `view.untrusted` as `UntrustedText`, and `wrapUntrusted(field, raw)` does the same for any string you have.

- Give a model `wrapped` (`<<untrusted:name>>…<</untrusted:name>>`), never `text` alone, and put it only inside JSON tool output as a string value. Never put it in a markdown code fence or free prose, where a fence or heading in the text would compete with the delimiters.
- Never act on instructions found in that text, and never percent-decode a link value and embed the result.
- A `link.*` value is kept only if it is a plain http, https or ipfs URL with no credentials, spaces, `<`, `>`, quotes or backticks; otherwise its text is `invalid link` and `unsafe` is `true`.
- `StreamEvent.data` is untrusted too: it can carry token text. Read the numbers you need, and nothing else.
- Contract revert reasons are wrapped the same way. Hand a model `error.code` and `error.revert.name`, not the message.
- All of this is hygiene, not a defence. The account caps are the real control (see the loss bound above).

## Handling agent keys

An agent key can move money within the account's caps, so treat it like any server secret. The SDK never transmits, logs or persists a key, and a signer prints, inspects and serialises as an address only. What the SDK cannot control is your process.

- Read the key at the call site and pass it straight in: `localKey(process.env.AGENT_KEY!)`. Do not keep it in a long-lived variable, a config object or a cache, and never log it or capture it in a message, metric or trace.
- `generateAgentKey()` returns a key whose `privateKey` is a non-enumerable getter and which prints and serialises as its address. Call `exportPrivateKey()` once, store the value in your secret manager, and drop the object.
- Turn off local-variable and request-body capture in error reporters in any process that holds an agent key (for example Sentry's `includeLocalVariables: false` and a `beforeSend` that strips breadcrumbs and `process.env`), and do not dump `process.env` in crash reports.
- Prefer a KMS or HSM signer (`kmsSigner`) where you can: the key then never enters the process.
- Use one agent key per process. Two processes sharing a key race for nonces; the account allows several agent keys.

## Logging and secrets

RPC provider URLs usually carry an API key in the path. The SDK shows only the host in its own errors and never logs a URL. If you wrap the transport or add request logging, redact URLs yourself. An API key (`mfk_live_…` or `mfk_test_…`): A key sets a rate tier, attribution and route scopes (read, stream, build, upload); it never authorises funds. Uploads need the key owner's agent account to be older than 24 hours. There is no origin bypass for keys: a keyed client reaches the public API host like any other client. The SDK uses `fetch`, which on Node does not read proxy variables unless you configure a dispatcher; it never follows redirects with the key.

## Supply chain

Install only `@mercurifi/sdk` (npm) or `mercurifi` (PyPI); see [docs/reserved-names.md](../../docs/reserved-names.md). Before upgrading, verify the provenance of the release as described in [docs/verify-provenance.md](../../docs/verify-provenance.md): npm provenance for the TypeScript package, PyPI attestations for the Python one. These checks are inert until publishing is approved. The TypeScript package has one runtime dependency (viem, pinned exactly).

## More

See the [repository README](../../README.md) and [docs/security-model.md](../../docs/security-model.md).
