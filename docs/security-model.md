# Mercurifi Agent Accounts: security model

## The loss bound

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Fixed periods allow up to twice every cap across a period boundary. Keep holdings small, sweep profits to the owner, and revoke a key the moment you suspect it.

Sells count against the sell cap at the **higher** of the position's current average cost and its high-water average cost (the highest average it has had after any buy, reset only when the position is fully sold). A stolen key therefore cannot buy a crashed token cheaply to drag the average down and then sell the account's older, dearer holdings under a stretched cap, for tokens the account bought. Holdings received from outside (airdrops, transfers in) are valued by a quote an attacker can move; they are not protected by the sell cap — withdraw them.

## Deployment status

Agent Accounts are deployed on Arc mainnet and testnet: mainnet (chain 5042; factory `0x816C7269FDcf621b7d8cb99A5AfbE9daddBd3b58`) and testnet (chain 5042002; factory `0x6D56A15c25782FF638943A4E81A1eD1ea862C9Bd`, source verified on the explorer and Sourcify). **No third-party audit has been performed yet; start with small amounts.** A network or address book without a recorded agent deployment throws `NotDeployedError` for agent operations. A local chain also works (chain 31337, loopback RPC, a local address book). Nothing in this repository broadcasts to a real network.

## Where things live

- **The account** (`AgentAccount`, one per owner and salt) holds the funds and the cost basis, and is the only contract an agent key calls: `buy`, `sell`, `launch`, `swapExactIn`, `claimFees`, `sweepToOwner`. The owner withdraws from it with `withdraw` and `withdrawMany`, to the owner only.
- **The policy registry** (`AgentPolicyRegistry`, one per factory) holds every account's owner, policy, agents, allowlist, delayed-widening queue, pause and per-period usage. The owner changes settings there; each call names the account. The registry is immutable and has no admin and no owner of its own: only an account's owner can change that account's settings, and only a registered account can charge its own usage.
- **The factory** (`AgentAccountFactory`) creates accounts, deploys the registry once, sets the ceilings and carries the platform guardian pause.

At start-up the SDK checks the chain ID and, on a network with an agent deployment, the code hashes of the factory, implementation and registry, `factory.implementation()`, `factory.registry()` and `registry.FACTORY()`.

## What an agent key can and cannot do

- **Can:** buy and sell on Launch curves (sell only if granted), launch tokens with the account as creator, swap graduated Launch pools, claim the account's fees into the account, sweep to the owner (if granted).
- **Cannot:** withdraw or transfer to any address but the owner, approve anything, change the referrer or creator, sign for the account (`isValidSignature` always fails), or call arbitrary contracts.

Narrowing a policy takes effect at once. Widening one (more cap, a new agent, a longer expiry) is queued behind the account's delay, can be cancelled, and is voided by a pause.

## Who else has power

- **The guardian** (a platform key set on the factory) can pause agent functions only, for at most 72 hours, then must wait a 72 hour cooldown. It cannot move funds, cannot touch policy and cannot block owner withdrawals, revocations or tightening. Only the admin (the Launch timelock) can extend an active pause, to at most 30 days from now, or lift or shorten it; the admin cannot start a pause. The timelock delay is 48 hours on mainnet and 60 seconds on testnet. The owner can also pause their own account's agents at any time.
- **The account trusts the upgradeable Launch components** it trades against (the Launch factory's curve registry, the fee manager and the graduation manager), which sit behind the same 48 hour timelock every Launch user already trusts.
- **Mercurifi never runs agents and never holds an agent key.**

## Your keys

- Generate agent keys on your own server with `generateAgentKey()` (TypeScript) or `generate_agent_key()` (Python).
- The SDK never transmits, logs or stores a private key; use one key per process.
- Never put the owner key on a trading server.
- API keys (`mfk_live_...`, `mfk_test_...`) set a rate tier, attribution and route scopes (read, stream, build, upload), and never authorise funds. Uploads need the key owner's agent account to be older than 24 hours.

See "Handling agent keys" in each package README for the language-specific rules.

## Token text is untrusted

Token names, symbols, descriptions and links are written by whoever launched the token. Use `mf.token(address)` and its `numeric()` view for decisions. Treat `untrusted.*` fields as data, never as instructions. The caps are the real control; the rules below are hygiene.

- If you must show a model a name, send the field's `wrapped` string only as a string value inside JSON tool output. Never put it in a markdown code fence or free prose, where a fence or heading in the text would compete with the delimiters.
- Never percent-decode a link value and embed the result. A `link.*` value is kept only if it is a plain http, https or ipfs URL with no credentials, spaces, `<`, `>`, quotes or backticks; otherwise its text is `invalid link` and `unsafe` is true.
- Everything that arrives on a stream (`StreamEvent.data`) is untrusted too: it can carry token text. Read the numbers you need and ignore the rest.
- Contract revert reasons are wrapped the same way. Return `code` and `revert.name` to a model, not the message.

## RPC URLs and API keys

RPC provider URLs usually carry a key in the path. The SDK shows only the host in its errors, and the Python SDK installs a redacting filter on the `httpx` and `httpcore` loggers. API keys are held privately by the HTTP client and are never part of an error, a log line or a serialised object. A key sets a rate tier, attribution and route scopes (read, stream, build, upload), and never authorise funds. Uploads need the key owner's agent account to be older than 24 hours. There is no origin bypass for keys: a keyed client reaches the public hostname like any other client.

## The API

The API is optional: every on-chain action works with a chain-only client. With it you get streams, quotes, metadata uploads and the account index.

| Item              | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header            | `X-Api-Key: mfk_live_...` (mainnet) or `mfk_test_...` (testnet); the prefix must match the network                                                                                                                                                                                                                                                                                                                                               |
| Account reads     | `GET /v1/agent-accounts/{account}`, `GET /v1/agent-accounts?owner=0x...`, `GET /v1/agent-accounts/{account}/actions`                                                                                                                                                                                                                                                                                                                             |
| Quotes and builds | `POST /v1/quote/curve-buy`, `curve-sell`, `pool-swap`; `POST /v1/tx/build` (the SDK decodes and verifies the calldata before signing: `verifyBuiltTx` / `verify_built_tx` for agent calls to the account, `verifyBuiltOwnerTx` / `verify_built_owner_tx` for owner calls, which must target the account (withdrawals) or the registry from the network book with your account as the first argument; both refuse any argument you did not state) |
| Uploads           | `POST /v1/uploads/launch-metadata`                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stream            | `GET /v1/stream?topics=...` with `launches`, `trades`, `token:<addr>`, `trader:<addr>` and `agent-account:<addr>`                                                                                                                                                                                                                                                                                                                                |

## Gas on Arc

Arc caps a single transaction at 16,777,216 gas (below the 30,000,000 block limit). `createAccount` with a referrer and a first agent costs about 353,719 gas, which is a fraction of a cent. A graduating buy needs at least 1.8M gas allowed, and the SDK sets the limit and the 20 gwei fee floor for you. `withdrawMany` of 500 cold tokens does not fit in one transaction; the SDK sends tokens in chunks of 100, well inside one Arc transaction (200 tokens cost about 7.2M gas).

## Nonces after a dropped transaction

Each agent or owner key has one local nonce, used under a per-key lock. When a transaction gets no receipt within 60 s the SDK raises `TxDroppedError` and forgets the local nonce, so the next send re-reads the node's `pending` transaction count. A residual risk remains with a load-balanced RPC whose nodes lag each other: the re-read can land on a node that has not yet seen the transaction (or has already dropped it), and the next send can then reuse a nonce that is still pending elsewhere. The usual result is a "nonce too low" or "replacement transaction underpriced" error, or the new transaction replacing the old one, never a double spend, because a nonce executes at most once. After a `TxDroppedError`, check the account (or the explorer) before resending, prefer an RPC endpoint that pins you to one node, and keep one process per key.

## The SDK supply chain

- Install only `@mercurifi/sdk` (npm) or `mercurifi` (PyPI); see `docs/reserved-names.md`.
- Verify provenance before upgrading (`docs/verify-provenance.md`). The instructions are inert until publishing is approved.
- The TypeScript package has one runtime dependency (viem, pinned exactly). The Python package depends on eth-account, eth-abi, eth-utils and httpx only.

## Upgrades

Accounts, the policy registry and factories are immutable: none has a proxy, an upgrade function or an admin that can change an account's rules. There is no code rollback. A new version means a new factory (with its own registry): revoke the old keys, withdraw with `withdrawMany` and create a new account.

## Reporting

See `SECURITY.md`.
