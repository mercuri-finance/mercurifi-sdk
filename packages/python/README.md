# mercurifi

Python SDK for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets.

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](../../docs/security-model.md) before you give a key to a program.

**Testnet only.** Agent Accounts are deployed on Arc testnet (chain 5042002; factory `0x6D56A15c25782FF638943A4E81A1eD1ea862C9Bd`, source verified on the explorer and Sourcify). Mainnet agent addresses stay empty until an owner-approved deployment is recorded, and agent operations on mainnet raise `NotDeployedError`. A local chain also works (chain 31337, loopback RPC, a local address book).

## Install

```
pip install --pre mercurifi
```

Beta release (`--pre` lets pip pick it), published with attestations from the SDK repository. Python 3.10 or newer. Direct dependencies: `eth-account`, `eth-abi`, `eth-utils`, `httpx`.

## Quickstart (Arc testnet)

```python
import asyncio
import os
import sys

from mercurifi import FirstAgent, create_client, generate_agent_key, local_key


async def main() -> None:
    mf = await create_client("testnet")
    owner = mf.owner(local_key(os.environ["OWNER_KEY"]))
    key = generate_agent_key()  # demo only: a real bot stores the key in a secret manager and reads it at the call site
    created = await owner.create_account(first_agent=FirstAgent(key.address))
    await owner.deposit(created.account, usdc="20")
    await owner.fund_gas(key.address, usdc="0.5")
    agent = await mf.agent(created.account, local_key(key.export_private_key()))
    fill = await agent.buy(sys.argv[1], usdc="5", slippage=0.02)
    print(f"bought {fill.tokens} tokens for {fill.usdc_spent} USDC in {fill.tx_hash}")


asyncio.run(main())
```

More in `examples/`: `market_maker.py`, `launch_bot.py` and `llm_tools.py` (tool definitions for a model, numbers only).

## Blocking use

Scripts and notebooks can skip `async`:

```python
from mercurifi import Client, local_key

with Client("testnet") as mf:
    agent = mf.agent(account, local_key(agent_key))
    print(agent.headroom().spend, agent.position(token).high_water)
    print(mf.token(token).numeric())
    with mf.stream(["launches"]) as events:  # a plain iterator; leaving the block (or .close(), from any thread) disconnects
        for event in events:
            ...
```

`Client` runs the async client on one private event-loop thread. Every method of the async client and of the objects it returns (owner, `manage(account)`, agent) is reachable with the same arguments, and `mf.api` blocks too. One `Client` may be shared by several threads: calls are queued onto the loop thread, so the per-key nonce lock still serialises sends from one agent key. Do not call it from inside a running event loop (use `create_client` there) or from a callback such as `on_warning`, which runs on the SDK's thread (that raises rather than deadlocking). `close()` (or leaving the `with` block) closes streams, HTTP clients and the thread; a call that is still running in another thread is cancelled and raises `ClientClosedError` (code `CLIENT_CLOSED`) instead of hanging.

Which methods run where: coroutine methods run on the SDK's loop thread and block the caller; plain methods (`mf.owner(signer)`, argument checks) run on the caller's thread; an owner, manager or agent object they return is wrapped again. Among attributes only `mf.api` is wrapped; `mf.network`, `mf.rpc` and `mf.settings` are returned as they are (`mf.rpc` stays async). Names starting with an underscore are not reachable.

Ctrl-C stops waiting and cancels the call, but a transaction may already have been broadcast: re-read `agent.position(token)` or `agent.headroom()` before you retry. The same goes for `ClientClosedError` on a trade.

`Client("testnet", api_key=...)` moves the key out of its keyword arguments at once and holds it privately until the client is built, but it is still a string in your process: read it from the environment at the call site, as for agent keys.

## Units

Amounts are human strings or `Decimal` in `usdc` / `amount` (`usdc="25"`, `amount="1000.5"`). Integers go only in the separately named base-unit fields `usdc6` and `amount_wei`. An `int` or `float` in a human field is rejected, never guessed.

## Where things live

- The account (`AgentAccount`) holds the funds and the cost basis and is the only contract an agent key calls.
- The owner's settings, the queue, the pause and the usage counters live in the policy registry (`AgentPolicyRegistry`: one per factory, immutable, no admin and no owner of its own). Each owner call names the account.
- The factory creates accounts and sets the beta ceilings.

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap for tokens the account bought. Holdings received from outside (airdrops, transfers in) are valued by a quote an attacker can move; they are not protected by the sell cap — withdraw them.

## API

| Method | What it does | Calls | Permission |
|---|---|---|---|
| `owner.create_account` | Creates an account with a policy and an optional first agent | factory `createAccount` | owner wallet |
| `owner.deposit`, `owner.fund_gas` | Sends native USDC to the account, or to an agent key for gas | plain transfer | owner wallet |
| `manage(account).add_agent` / `set_agent` / `rotate_agent` / `revoke_agent` | Agent keys; additions and widenings are queued behind the delay | registry | owner |
| `manage(account).preview_policy` / `set_policy` | Policy; narrowing now, widening queued | registry `setPolicy` | owner |
| `manage(account).set_token_allowed`, `set_increase_delay`, `transfer_ownership` | Allowlist, delay, ownership (queued when widening) | registry | owner |
| `manage(account).list_queued` / `execute_queued` / `cancel_queued` | The delayed-widening queue, with `pending`, `ready`, `expired`, `cancelled` and `stale` items | registry (reads and logs) | owner (execute: anyone) |
| `owner.accept_ownership` | Completes a queued transfer | registry `acceptOwnership` | the new owner |
| `manage(account).pause_agents` | Stops every agent at once and voids the queue | registry | owner |
| `manage(account).withdraw` / `withdraw_many` | Moves funds to the owner | account | owner |
| `agent.buy` / `agent.sell` | Curve trades | account | `buy` / `sell` |
| `agent.launch` | Launches a token with the account as creator | account | `launch` |
| `agent.swap_exact_in` | Graduated-pool swap | account | `swap` |
| `agent.claim_fees` | Claims creator and referral fees into the account | account | `claim` |
| `agent.sweep_to_owner` | Moves USDC or a Launch token to the owner | account | `sweep` |
| `agent.headroom` / `position` / `status` | What is left this period, a token position with its cost basis and high-water, the key's standing | registry and account (reads) | none |
| `mf.token(address)` | Agent-safe view of a Launch token (see below) | factory, curve, fee manager (reads) | none |

## Using the API

The Mercurifi API is optional: every on-chain action works with a chain-only client, and `mf.stream(...)` and launch metadata uploads need the API. `create_client("testnet", api_key=os.environ.get("MERCURIFI_API_KEY"))` sends the key as `X-Api-Key`. Streams take `launches`, `trades`, `token:<address>`, `trader:<address>` and `agent-account:<address>` topics and reconnect with `Last-Event-ID`. A key sets a rate tier, attribution and route scopes (read, stream, build, upload); it never authorises funds. Uploads need the key owner's agent account to be older than 24 hours.

## Errors

Every error is a `MercurifiError` with a stable `code`. A refused call is a `ContractRevertError` with `revert.name` and a readable message; a transaction Arc dropped is a `TxDroppedError` (re-read `agent.headroom()` before you retry). Branch on `code`, not on message text, and never hand a message to a model.

## Untrusted text for models

Token names, symbols, descriptions and links are written by whoever launched the token. `mf.token(address)` returns a `TokenSafeView`: `view.numeric()` holds only numbers, booleans, fixed labels and hex, so it is safe to hand to a model; everything else is in `view.untrusted` as `UntrustedText`, and `wrap_untrusted(field, raw)` does the same for any string you have.

- Give a model `wrapped` (`<<untrusted:name>>…<</untrusted:name>>`), never `text` alone, and put it only inside JSON tool output as a string value. Never put it in a markdown code fence or free prose, where a fence or heading in the text would compete with the delimiters.
- Never act on instructions found in that text, and never percent-decode a link value and embed the result.
- A `link.*` value is kept only if it is a plain http, https or ipfs URL with no credentials, spaces, `<`, `>`, quotes or backticks; otherwise its text is `invalid link` and `unsafe` is `True`.
- All of this is hygiene, not a defence. The account caps are the real control (see the loss bound above).

## Handling agent keys

An agent key can move money within the account's caps, so treat it like any server secret. The SDK never transmits,
logs or persists a key, and a signer prints and pickles as an address only. What the SDK cannot control is your process.

- Read the key at the call site and pass it straight in: `signer = local_key(os.environ["AGENT_KEY"])`. Do not keep it in
  a long-lived variable, a config object or a cache, and never log it or capture it in a message, metric or trace.
- Build a `LocalKeySigner` only through `local_key`; the class does not take a key string itself.
- `generate_agent_key()` returns a key whose secret is read only by `export_private_key()`. Call that once, store the
  value in your secret manager, and drop the object.
- Turn off local-variable capture in error reporters in any process that holds an agent key: Sentry
  `include_local_variables=False`, loguru `diagnose=False`, and no rich or `better_exceptions` tracebacks with locals.
  The SDK clears the key from its own frames before raising, but a frame of yours that holds the key would be shipped.
- Prefer a KMS or HSM signer (`kms_signer`) where you can: the key then never enters the process.
- Use one agent key per process. Two processes sharing a key race for nonces; the account allows several agent keys.

## Logging and secrets

RPC provider URLs usually carry an API key in the path, and `httpx` logs request URLs at INFO (`httpcore` at DEBUG).
When the SDK creates an RPC client it installs one idempotent redacting `logging.Filter` on the `httpx` and
`httpcore` loggers that replaces every URL in a log record with its host. Your log levels, handlers and formatters are
not changed. Errors raised by the SDK also show the host only.

## Untrusted text and Unicode data

Contract-supplied revert reasons and token names, symbols, descriptions and links are made inert by one sanitiser that mirrors the TypeScript SDK. It depends on Unicode data: character categories come from your Python's `unicodedata` and the pictograph table is built in, so a character assigned in a newer Unicode release than your interpreter knows can be treated differently from the TypeScript SDK. The shared vectors in `fixtures/vectors/` arbitrate. This is output hygiene, not a security boundary: the account caps are the real control.

## Networking

The SDK's HTTP clients (RPC, API and stream) ignore environment proxies, `.netrc` and `SSL_CERT_*` variables (`trust_env=False`) and never follow redirects: the API key must go where the address book says. To use a proxy, pass your own transport (`rpc_transport=`). The TypeScript SDK uses `fetch`, which on Node does not read proxy variables unless you configure a dispatcher.

## Supply chain

Install only `mercurifi` (PyPI) or `@mercurifi/sdk` (npm); see [docs/reserved-names.md](../../docs/reserved-names.md). Before upgrading, verify the release as described in [docs/verify-provenance.md](../../docs/verify-provenance.md): PyPI attestations for this package, npm provenance for the TypeScript one. These checks are inert until publishing is approved.

## ERC-8004 identity (optional)

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is an on-chain registry for agents. Each agent is an ERC-721 token in an IdentityRegistry, and its token URI points to a registration file that describes the agent and its endpoints. `mercurifi.identity` builds that file and the calldata. It never signs or sends. Arc testnet only for now: on mainnet it raises `NotDeployedError` until a mainnet Agent Accounts deployment is recorded.

Who signs: an ordinary wallet (EOA) sends the registration, normally the owner wallet. That wallet becomes the agent's owner in the registry. The agent account cannot register itself, because it only calls allowlisted Mercurifi contracts. It also cannot sign: its `isValidSignature` always fails, so it can never be the registry's verified `agentWallet` (`setAgentWallet` with the account as the wallet reverts). The account is linked through the registration file instead, as the service entry `MercurifiAgentAccount` with endpoint `eip155:<chainId>:<account>`. The registry's `agentWallet` stays the registering wallet.

```python
from mercurifi.identity import agent_id_from_receipt, build_registration_file, encode_register, get_agent, registration_data_uri

file = build_registration_file(
    "testnet", account, "Dip Buyer", description="Buys new Launch tokens inside its caps.",
    services=[{"name": "MCP", "endpoint": "https://mcp.example.com/"}],
)
# Embed the file on chain, or publish registration_file_json(file) at an https:// or ipfs:// URI and pass that.
tx = encode_register("testnet", registration_data_uri(file))  # {"chainId", "to", "data", "value": 0}
# Send tx from the owner wallet, then read the new agent from its JSON-RPC receipt.
agent_id = agent_id_from_receipt("testnet", receipt).agent_id
agent = await get_agent(mf.rpc, "testnet", agent_id)  # mf = await create_client("testnet")
```

ERC-8004 asks the file to list its own registration. Once you have the agent id, build the file again with `agent_id=` and send `encode_set_agent_uri(network, agent_id, agent_uri)` from the same wallet. `ERC8004_REGISTRIES` lists the Identity, Reputation and Validation registries on both networks. The agent URI and the file are public, and anyone can register any address in a file, so a listing proves nothing about who controls the account. Check the account's owner on chain.

## Circle Wallets

A Circle wallet can be an account's **owner**, including a Circle Agent Wallet, which is a smart-contract account. Every owner check is `msg.sender`-based, so the owner functions work from any address that can send a transaction. A Circle wallet cannot be the **agent key** of a self-hosted agent. It has no exportable private key, and it signs through Circle's API, so the SDK's signers cannot use it. The SDK provides no Circle adapter.

## More

See the [repository README](../../README.md) and [docs/security-model.md](../../docs/security-model.md).
