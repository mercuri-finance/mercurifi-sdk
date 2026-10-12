![Mercurifi Agent Accounts SDK — Your agent trades. Only you withdraw.](https://raw.githubusercontent.com/mercuri-finance/mercurifi-sdk/main/assets/banner-light.png)

# @mercurifi/sdk

TypeScript SDK for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets.

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](https://github.com/mercuri-finance/mercurifi-sdk/blob/main/docs/security-model.md) before you give a key to a program.

Agent Accounts are deployed on Arc mainnet and testnet: mainnet (chain 5042; factory `0x816C7269FDcf621b7d8cb99A5AfbE9daddBd3b58`) and testnet (chain 5042002; factory `0x6D56A15c25782FF638943A4E81A1eD1ea862C9Bd`, source verified on the explorer and Sourcify). **No third-party audit has been performed yet; start with small amounts.** A network or address book without a recorded agent deployment throws `NotDeployedError` for agent operations. A local chain also works (chain 31337, loopback RPC, a local address book).

## Install

```
npm install @mercurifi/sdk
```

Published with signed provenance from the SDK repository. Node 20 or newer. The one runtime dependency is `viem`.

## Quickstart (Arc testnet)

```ts
import type { Address } from 'viem';
import { createClient, generateAgentKey, localKey } from '@mercurifi/sdk';

const mf = await createClient({ network: 'testnet' });

// The owner wallet creates the account, funds it and gives the agent key gas.
const owner = mf.owner(localKey(process.env.OWNER_KEY!));

// Demo only: a real bot stores the key in a secret manager
// and reads it at the call site.
const key = generateAgentKey();

const { account } = await owner.createAccount({
  firstAgent: { address: key.address },
});

await owner.deposit(account, { usdc: '20' });

await owner.fundGas(key.address, { usdc: '0.5' });

// The agent key trades for the account.
const agent = await mf.agent({
  account,
  signer: localKey(key.exportPrivateKey()),
});

const fill = await agent.buy({
  token: process.argv[2] as Address,
  usdc: '5',
  slippage: 0.02,
});

console.log(
  `bought ${fill.tokens} tokens for ${fill.usdcSpent} USDC in ${fill.txHash}`,
);
```

More in `examples/`: `market-maker.ts`, `launch-bot.ts` and `llm-tools.ts` (tool definitions for a model, numbers only). The market maker reacts to curve `trade` events; after graduation a token trades in a pool and those arrive as separate `pool_trade` events.

## Units

Amounts are human strings in `usdc` / `amount` (`usdc: '25'`, `amount: '1000.5'`). Base units go only in the separately named fields `usdc6` and `amountWei` (`bigint`). A JavaScript `number` in a human field is rejected, never guessed.

## Where things live

- The account (`AgentAccount`) holds the funds and the cost basis and is the only contract an agent key calls.
- The owner's settings, the queue, the pause and the usage counters live in the policy registry (`AgentPolicyRegistry`: one per factory, immutable, no admin and no owner of its own). Each owner call names the account.
- The factory creates accounts and sets the ceilings.

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap for tokens the account bought. Holdings received from outside (airdrops, transfers in) are valued by a quote an attacker can move; they are not protected by the sell cap — withdraw them.

## API

| Method                                                                     | What it does                                                                                      | Calls                               | Permission              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------- |
| `owner.createAccount`                                                      | Creates an account with a policy and an optional first agent                                      | factory `createAccount`             | owner wallet            |
| `owner.deposit`, `owner.fundGas`                                           | Sends native USDC to the account, or to an agent key for gas                                      | plain transfer                      | owner wallet            |
| `manage(account).addAgent` / `setAgent` / `rotateAgent` / `revokeAgent`    | Agent keys; additions and widenings are queued behind the delay                                   | registry                            | owner                   |
| `manage(account).previewPolicy` / `setPolicy`                              | Policy; narrowing now, widening queued                                                            | registry `setPolicy`                | owner                   |
| `manage(account).setTokenAllowed`, `setIncreaseDelay`, `transferOwnership` | Allowlist, delay, ownership (queued when widening)                                                | registry                            | owner                   |
| `manage(account).listQueued` / `executeQueued` / `cancelQueued`            | The delayed-widening queue, with `pending`, `ready`, `expired`, `cancelled` and `stale` items     | registry (reads and logs)           | owner (execute: anyone) |
| `owner.acceptOwnership`                                                    | Completes a queued transfer                                                                       | registry `acceptOwnership`          | the new owner           |
| `manage(account).pauseAgents`                                              | Stops every agent at once and voids the queue                                                     | registry                            | owner                   |
| `manage(account).withdraw` / `withdrawMany`                                | Moves funds to the owner                                                                          | account                             | owner                   |
| `agent.buy` / `agent.sell`                                                 | Curve trades                                                                                      | account                             | `buy` / `sell`          |
| `agent.launch`                                                             | Launches a token with the account as creator                                                      | account                             | `launch`                |
| `agent.swapExactIn`                                                        | Graduated-pool swap                                                                               | account                             | `swap`                  |
| `agent.claimFees`                                                          | Claims creator and referral fees into the account                                                 | account                             | `claim`                 |
| `agent.sweepToOwner`                                                       | Moves USDC or a Launch token to the owner                                                         | account                             | `sweep`                 |
| `agent.headroom` / `position` / `status`                                   | What is left this period, a token position with its cost basis and high-water, the key's standing | registry and account (reads)        | none                    |
| `mf.token(address)`                                                        | Agent-safe view of a Launch token (see below)                                                     | factory, curve, fee manager (reads) | none                    |

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

RPC provider URLs usually carry an API key in the path. The SDK shows only the host in its own errors and never logs a URL: its HTTP transport turns every transport or HTTP failure into an `RPC_ERROR` naming the host only, with no `cause`, so no error the SDK raises (message, stack or cause chain) carries the URL. If you pass your own `transport` or add request logging, redact URLs yourself. An API key (`mfk_live_…` or `mfk_test_…`) sets a rate tier, attribution and route scopes (read, stream, build, upload), and never authorises funds. Uploads need the key owner's agent account to be older than 24 hours. There is no origin bypass for keys: a keyed client reaches the public API host like any other client. The SDK uses `fetch`, which on Node does not read proxy variables unless you configure a dispatcher; it never follows redirects with the key.

## Supply chain

Install only `@mercurifi/sdk` (npm) or `mercurifi` (PyPI); see [docs/reserved-names.md](https://github.com/mercuri-finance/mercurifi-sdk/blob/main/docs/reserved-names.md). Before upgrading, verify the provenance of the release as described in [docs/verify-provenance.md](https://github.com/mercuri-finance/mercurifi-sdk/blob/main/docs/verify-provenance.md): npm provenance for the TypeScript package, PyPI attestations for the Python one. These checks are inert until publishing is approved. The TypeScript package has one runtime dependency (viem, pinned exactly).

## ERC-8004 identity (optional)

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is an on-chain registry for agents. Each agent is an ERC-721 token in an IdentityRegistry, and its token URI points to a registration file that describes the agent and its endpoints. The helpers here build that file and the calldata. They never sign or send. They work on Arc mainnet and testnet.

Who signs: an ordinary wallet (EOA) sends the registration, normally the owner wallet. That wallet becomes the agent's owner in the registry. The agent account cannot register itself, because it only calls allowlisted Mercurifi contracts. It also cannot sign: its `isValidSignature` always fails, so it can never be the registry's verified `agentWallet` (`setAgentWallet` with the account as the wallet reverts). The account is linked through the registration file instead, as the service entry `MercurifiAgentAccount` with endpoint `eip155:<chainId>:<account>`. The registry's `agentWallet` stays the registering wallet.

```ts
import {
  createPublicClient,
  http,
  type Address,
  type TransactionReceipt,
} from 'viem';
import {
  agentIdFromReceipt,
  buildRegistrationFile,
  encodeRegister,
  getAgent,
  registrationDataUri,
} from '@mercurifi/sdk';

// Your agent account.
declare const account: Address;

// The receipt of the transaction your owner wallet sent.
declare const receipt: TransactionReceipt;

const file = buildRegistrationFile({
  network: 'testnet',
  account,
  name: 'Dip Buyer',
  description: 'Buys new Launch tokens inside its caps.',
  services: [{ name: 'MCP', endpoint: 'https://mcp.example.com/' }],
});

// Embed the file on chain, or publish registrationFileJson(file)
// at an https:// or ipfs:// URI and pass that.
const tx = encodeRegister({
  network: 'testnet',
  agentURI: registrationDataUri(file),
}); // { chainId, to, data, value: 0n }

// Send tx from the owner wallet, then read the new agent from its receipt.
const { agentId } = agentIdFromReceipt({ network: 'testnet', receipt });

const agent = await getAgent(
  createPublicClient({ transport: http('https://rpc.testnet.arc.io') }),
  { network: 'testnet', agentId },
);
```

ERC-8004 asks the file to list its own registration. Once you have the `agentId`, build the file again with `agentId` and send `encodeSetAgentURI({ network, agentId, agentURI })` from the same wallet. `ERC8004_REGISTRIES` lists the Identity, Reputation and Validation registries on both networks. The agent URI and the file are public, and anyone can register any address in a file, so a listing proves nothing about who controls the account. Check the account's owner on chain.

## Circle Wallets

A Circle wallet can be an account's **owner**, including a Circle Agent Wallet, which is a smart-contract account. Every owner check is `msg.sender`-based, so the owner functions work from any address that can send a transaction. A Circle wallet cannot be the **agent key** of a self-hosted agent. It has no exportable private key, and it signs through Circle's API, so the SDK's signers cannot use it. The SDK provides no Circle adapter.

## More

See the [repository README](https://github.com/mercuri-finance/mercurifi-sdk#readme) and [docs/security-model.md](https://github.com/mercuri-finance/mercurifi-sdk/blob/main/docs/security-model.md).
