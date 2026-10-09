# mercurifi

Python SDK for Mercurifi Agent Accounts on Arc: an account that holds USDC and Launch tokens, and agent keys that trade for it inside caps the owner sets.

A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.

Read [docs/security-model.md](../../docs/security-model.md) before you give a key to a program.

**Testnet only for now.** No mainnet agent factory is deployed: the mainnet agent addresses in this SDK are empty until an owner-approved deployment is recorded, and agent operations on mainnet raise `NotDeployedError`. Use `"testnet"` (Arc testnet, chain 5042002); a local Anvil book (chain 31337, loopback RPC) is also accepted.

## Install

```
pip install mercurifi
```

Not yet published; until then install from the repository checkout (`pip install ./packages/python`). Python 3.10 or newer. Direct dependencies: `eth-account`, `eth-abi`, `eth-utils`, `httpx`.

## Quickstart

```python
import asyncio
import os
import sys

from mercurifi import FirstAgent, create_client, generate_agent_key, local_key


async def main() -> None:
    mf = await create_client("testnet")
    owner = mf.owner(local_key(os.environ["OWNER_KEY"]))
    key = generate_agent_key()  # keep key.export_private_key() on your server only
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
    for event in mf.stream(["launches"]):  # a plain iterator; leave the loop or call .close() to disconnect
        ...
```

`Client` runs the async client on one private event-loop thread. Every method of the async client and of the objects it returns (owner, `manage(account)`, agent) is reachable with the same arguments, and `mf.api` blocks too. One `Client` may be shared by several threads: calls are queued onto the loop thread, so the per-key nonce lock still serialises sends from one agent key. Do not call it from inside a running event loop (use `create_client` there) or from a callback such as `on_warning`, which runs on the SDK's thread (that raises rather than deadlocking). `close()` (or leaving the `with` block) closes streams, HTTP clients and the thread.

## Units

Amounts are human strings or `Decimal` in `usdc` / `amount` (`usdc="25"`, `amount="1000.5"`). Integers go only in the separately named base-unit fields `usdc6` and `amount_wei`. An `int` or `float` in a human field is rejected, never guessed.

## Where things live

- The account (`AgentAccount`) holds the funds and the cost basis and is the only contract an agent key calls.
- The owner's settings, the queue, the pause and the usage counters live in the policy registry (`AgentPolicyRegistry`: one per factory, immutable, no admin and no owner of its own). Each owner call names the account.
- The factory creates accounts and sets the beta ceilings.

Sells count against the sell cap at the higher of the position's current average cost and its high-water average cost, so a stolen key cannot buy a crashed token cheaply to stretch the sell cap.

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

## Untrusted text for models

Token names, symbols, descriptions and links are written by whoever launched the token. `mf.token(address)` returns a `TokenSafeView`: `view.numeric()` holds only numbers, booleans, fixed labels and hex, so it is safe to hand to a model; everything else is in `view.untrusted` as `UntrustedText`, and `wrap_untrusted(field, raw)` does the same for any string you have.

- Give a model `wrapped` (`<<untrusted:name>>…<</untrusted:name>>`), never `text` alone, and put it only inside JSON tool output as a string value. Never put it in a markdown code fence or free prose, where a fence or heading in the text would compete with the delimiters.
- Never act on instructions found in that text, and never percent-decode a link value and embed the result.
- A `link.*` value is kept only if it is a plain http, https or ipfs URL with no credentials, spaces, `<`, `>`, quotes or backticks; otherwise its text is `invalid link` and `unsafe` is `True`.
- All of this is hygiene, not a defence. The account caps are the real control (see the loss bound above).

## Networking

The SDK's HTTP clients (RPC, API and stream) ignore environment proxies, `.netrc` and `SSL_CERT_*` variables (`trust_env=False`) and never follow redirects: the API key must go where the address book says. To use a proxy, pass your own transport (`rpc_transport=`). The TypeScript SDK uses `fetch`, which on Node does not read proxy variables unless you configure a dispatcher.

## More

See the [repository README](../../README.md) and [docs/security-model.md](../../docs/security-model.md).

## Logging and secrets

RPC provider URLs usually carry an API key in the path, and `httpx` logs request URLs at INFO (`httpcore` at DEBUG).
When the SDK creates an RPC client it installs one idempotent redacting `logging.Filter` on the `httpx` and
`httpcore` loggers that replaces every URL in a log record with its host. Your log levels, handlers and formatters are
not changed. Errors raised by the SDK also show the host only.

## Untrusted text and Unicode data

Contract-supplied revert reasons and token names, symbols, descriptions and links are made inert by one sanitiser that mirrors the TypeScript SDK. It depends on Unicode data: character categories come from your Python's `unicodedata` and the pictograph table is built in, so a character assigned in a newer Unicode release than your interpreter knows can be treated differently from the TypeScript SDK. The shared vectors in `fixtures/vectors/` arbitrate. This is output hygiene, not a security boundary: the account caps are the real control.

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
