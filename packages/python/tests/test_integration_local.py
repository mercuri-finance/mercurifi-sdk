"""Loopback Anvil only (scripts/local-chain.sh). Run: uv run pytest -m integration. ANVIL_PORT (default 8545) selects the
chain and its book fixtures/local-book-<port>.json; ANVIL_RPC may override the URL, and its port then names the book.

One ordered test: each block depends on the state the previous one left, as in the TypeScript tier's local.test.ts. Python does not
record fixtures; the TS tier is the single recorder and test_recorded.py proves Python decodes its files identically.
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

from mercurifi import FirstAgent, create_client, generate_agent_key, local_key, local_network
from mercurifi.abi import AGENT_ACCOUNT, BONDING_CURVE, LAUNCH_FACTORY, LAUNCH_TOKEN
from mercurifi.basis import Basis, curve_sell_value6, recorded_sell_value6
from mercurifi.client import AsyncClient
from mercurifi.networks import is_loopback_url
from mercurifi.revert import ContractRevertError, DecodedRevert, decode_revert, extract_revert_data
from mercurifi.rpc import RpcError
from mercurifi.signers import LocalKeySigner
from mercurifi.tx import WriteRequest

pytestmark = pytest.mark.integration
RPC = os.environ.get("ANVIL_RPC", f"http://127.0.0.1:{os.environ.get('ANVIL_PORT', '8545')}")
BOOK = (
    Path(__file__).resolve().parents[3] / "fixtures" / f"local-book-{urlsplit(RPC).port or 80}.json"
)
WAD = 10**18
DAY = 86_400
ZERO = "0x" + "00" * 20
ALL_BUT_SELL = ("buy", "launch", "swap", "claim", "sweep")
ALL = ("buy", "sell", "launch", "swap", "claim", "sweep")


def require_loopback() -> None:
    # An explicit raise, not assert: the guard must hold under python -O too.
    if not is_loopback_url(RPC):
        raise RuntimeError("the integration tier runs only against a loopback Anvil")


async def anvil(method: str, params: list[Any]) -> Any:
    require_loopback()
    async with httpx.AsyncClient(trust_env=False) as http:
        body = (
            await http.post(
                RPC, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            )
        ).json()
    if "error" in body:
        raise RuntimeError(body["error"]["message"])
    return body["result"]


async def fund(address: str, usdc: int) -> None:
    await anvil("anvil_setBalance", [address, hex(usdc * WAD)])


async def mine(blocks: int) -> None:
    await anvil("anvil_mine", [hex(blocks)])


async def latest_ts() -> int:
    return int((await anvil("eth_getBlockByNumber", ["latest", False]))["timestamp"], 16)


DAY0 = {"day": 0}


async def align_to_day_start() -> None:
    """Periods are block.timestamp // 1 day. Start one minute into the next UTC day, so the run's warps (3 x 3,601 s plus
    mined blocks) cannot cross midnight and reset the period-bound counters (the launch limit) mid-run."""
    DAY0["day"] = await latest_ts() // DAY + 1
    await anvil("evm_setNextBlockTimestamp", [hex(DAY0["day"] * DAY + 60)])
    await mine(1)
    assert await latest_ts() // DAY == DAY0["day"]


async def warp(seconds: int) -> None:
    """Moves chain time forward; every warp must stay inside the aligned day, or period-bound cases would flake."""
    await anvil("evm_increaseTime", [hex(seconds)])
    await mine(1)
    assert await latest_ts() // DAY == DAY0["day"]


def new_key() -> LocalKeySigner:
    return local_key(generate_agent_key().export_private_key())


async def chain_revert(mf: AsyncClient, sender: str, to: str, data: str) -> DecodedRevert:
    """The SDK refuses most failing trades locally, before signing (source `local check`, no node data). The same call is
    replayed here as an eth_call from the agent key, bypassing those checks, and the node's revert data is decoded."""
    try:
        await mf.rpc.call(to, data, from_=sender, gas=1_800_000)
    except RpcError as exc:
        d = decode_revert(extract_revert_data(exc))
        assert d.source != "local check" and len(d.data) >= 10
        return d
    raise AssertionError("the call did not revert on chain")


async def test_end_to_end() -> None:
    require_loopback()
    await align_to_day_start()
    book = local_network(json.loads(BOOK.read_text()))
    assert book.agents is not None and book.agents.registry != ZERO
    # create_client verifies the factory, implementation and registry code hashes, factory.registry() and registry.FACTORY().
    mf = await create_client(book, rpc_url=RPC, api=None, on_warning=lambda m: None)
    try:
        await _run(mf)
    finally:
        await mf.aclose()


async def _run(mf: AsyncClient) -> None:
    agents = mf.require_agents()
    owner, agent_signer = new_key(), new_key()
    await fund(owner.address, 100_000)
    await fund(agent_signer.address, 10)

    async def agent_call(fn: str, token: str, amount: int) -> DecodedRevert:
        deadline = await mf.rpc.latest_timestamp() + 60
        return await chain_revert(
            mf, agent_signer.address, account, AGENT_ACCOUNT.encode(fn, token, amount, 1, deadline)
        )

    # Account with the defaults and a first agent (no sell).
    created = await mf.owner(owner).create_account(
        first_agent=FirstAgent(agent_signer.address, permissions=ALL_BUT_SELL)
    )
    account = created.account
    await mf.owner(owner).deposit(account, usdc="1000")
    agent = await mf.agent(account, agent_signer)
    assert (await agent.status()).active
    manager = await mf.owner(owner).manage(account)
    state = await manager.state()
    assert (state.owner, state.registry) == (owner.address, agents.registry)

    # Launch: the account is the creator.
    fill = await agent.launch("PyLocal", "PYL", metadata_uri="ipfs://py", initial_buy_usdc="5")
    assert fill.action == "launch" and fill.launched is not None
    token = fill.launched.token
    assert (await mf.token(token)).creator == account

    # Snipe window (refused locally, and on chain from AgentAccount), then a buy.
    with pytest.raises(ContractRevertError) as snipe:
        await agent.buy(token, usdc="25")
    assert snipe.value.revert.name == "SnipeTaxTooHigh"
    on_chain = await agent_call("buy", token, 25_000_000)
    assert (on_chain.name, on_chain.source) == ("SnipeTaxTooHigh", "AgentAccount")
    await mine(130)
    assert (await agent.buy(token, usdc="25")).usdc_spent6 == 25_000_000

    # The per-trade cap comes from the account: the SDK refuses it locally, the account reverts the same way on chain.
    with pytest.raises(ContractRevertError, match="100 USDC") as cap:
        await agent.buy(token, usdc="150")
    assert cap.value.revert.name == "TradeTooLarge"
    on_chain = await agent_call("buy", token, 150_000_000)
    assert (on_chain.name, on_chain.source) == ("TradeTooLarge", "AgentAccount")
    assert "100 USDC" in on_chain.message

    # Concurrent buys from one key go out in nonce order.
    fills = await asyncio.gather(*(agent.buy(token, usdc="1") for _ in range(3)))
    assert len({f.tx_hash for f in fills}) == 3
    txs = [await mf.rpc.request("eth_getTransactionByHash", [f.tx_hash]) for f in fills]
    nonces = sorted(int(t["nonce"], 16) for t in txs)
    assert nonces == [nonces[0], nonces[0] + 1, nonces[0] + 2]

    # Sell needs the permission (a registry error), granted through the queue.
    with pytest.raises(ContractRevertError) as missing:
        await agent.sell(token, amount="1000000")
    assert missing.value.revert.name == "MissingPermission"
    on_chain = await agent_call("sell", token, 1_000_000 * WAD)
    assert (on_chain.name, on_chain.source) == ("MissingPermission", "AgentPolicyRegistry")
    grant = await manager.set_agent(agent_signer.address, permissions=ALL)
    assert grant.outcome == "queued" and grant.queued_id is not None
    item = next(q for q in await manager.list_queued() if q.id == grant.queued_id)
    assert (item.kind, item.status) == ("setAgent", "pending")
    await warp(3_601)
    await manager.execute_queued(grant.queued_id)
    assert (await agent.sell(token, amount="1000000")).action == "sell"

    # The sell is valued at the high-water cost, exactly as basis.py computes it before signing. Make the high-water term
    # win: a wallet pumps the price, the agent buys high (raising its high-water average), the wallet dumps, the agent
    # buys cheap (the average falls, the high-water stays), then the agent sells.
    first_curve = (await mf.token(token)).curve
    pumper = new_key()
    await fund(pumper.address, 10_000)
    deadline = await mf.rpc.latest_timestamp() + 600
    pump = BONDING_CURVE.encode("buy", 1, ZERO, deadline)
    await mf.sender.send(
        pumper, WriteRequest(to=first_curve, data=pump, label="pump", value=2_000 * WAD)
    )
    await agent.buy(token, usdc="40")
    held = int(await mf.rpc.read(LAUNCH_TOKEN, token, "balanceOf", pumper.address))
    approve = LAUNCH_TOKEN.encode("approve", first_curve, held)
    await mf.sender.send(pumper, WriteRequest(to=token, data=approve, label="approve"))
    deadline = await mf.rpc.latest_timestamp() + 600
    dump = BONDING_CURVE.encode("sell", held, 1, ZERO, deadline)
    await mf.sender.send(pumper, WriteRequest(to=first_curve, data=dump, label="dump"))
    await agent.buy(token, usdc="20")

    before = await agent.position(token)
    basis = Basis(before.cost_usdc6, before.basis_tokens, before.high_water)
    tokens_in = basis.tokens // 10
    assert (
        tokens_in <= before.balance_wei
    )  # every token was bought by the account: nothing is unrecorded
    recorded, value6 = recorded_sell_value6(basis, tokens_in)
    assert recorded == tokens_in
    assert curve_sell_value6(basis, tokens_in, 0) == value6
    ceil_avg = (tokens_in * basis.cost_usdc6 + basis.tokens - 1) // basis.tokens
    high_water = tokens_in * basis.high_water // 10**36
    assert value6 == high_water  # the high-water branch decides ...
    assert high_water > ceil_avg  # ... strictly above the rounded-up average
    assert (await agent.sell(token, amount_wei=tokens_in)).basis_value6 == value6

    # A curve-completing buy goes out with at least 1.8M gas. It runs on a second token: completing the first one would
    # leave it GraduationPending on Anvil (graduation is deferred there), and every later buy of it would fail NotTrading.
    second = await agent.launch("PyLocal Two", "PYL2", metadata_uri="ipfs://py-2")
    assert second.launched is not None
    full = second.launched.token
    await mine(130)
    curve = (await mf.token(full)).curve

    async def used(value: int) -> int:
        return int((await mf.rpc.read(BONDING_CURVE, curve, "quoteBuy", value))[1])

    lo, hi = 1, 100_000 * WAD
    while lo < hi:
        mid = (lo + hi) // 2
        if await used(mid) < mid:
            hi = mid
        else:
            lo = mid + 1
    whale = new_key()
    await fund(whale.address, 100_000)
    deadline = await mf.rpc.latest_timestamp() + 600
    whale_buy = WriteRequest(
        to=curve,
        data=BONDING_CURVE.encode("buy", 1, ZERO, deadline),
        label="whale",
        value=lo - 40 * WAD,
    )
    await mf.sender.send(whale, whale_buy)
    completing = await agent.buy(full, usdc="50")
    tx = await mf.rpc.request("eth_getTransactionByHash", [completing.tx_hash])
    assert int(tx["gas"], 16) >= 1_800_000
    # Graduation itself is deferred on Anvil (the USDC stub cannot move funds): the curve completed and waits.
    assert (await mf.token(full)).phase == "graduationPending"

    # The launch limit is checked before the trade size (registry preamble), on chain.
    await agent.launch(
        "PyLocal Three", "PYL3", metadata_uri="ipfs://py-3"
    )  # third of three this period
    config_hash = str(await mf.rpc.read(LAUNCH_FACTORY, mf.network.launch.factory, "configHash"))
    initial_buy6 = 150_000_000
    request = {
        "name": "PyLocal Four",
        "symbol": "PYL4",
        "metadataURI": "ipfs://py-4",
        "salt": "0x" + "00" * 31 + "04",
        "expectedConfigHash": config_hash,
        "initialBuyUsdc": initial_buy6,
        "minTokensOut": 1,
        "deadline": await mf.rpc.latest_timestamp() + 60,
    }
    on_chain = await chain_revert(
        mf, agent_signer.address, account, AGENT_ACCOUNT.encode("launch", request)
    )
    assert (on_chain.name, on_chain.source) == ("LaunchLimit", "AgentPolicyRegistry")
    # The multi-failure: out of launches and an initial buy above maxTradeUsdc at once; LaunchLimit wins.
    assert (await agent.headroom()).launches == 0
    assert initial_buy6 > (await manager.state()).policy.max_trade_usdc

    # A tightening applies at once; the older widening keeps the field written after it (superseded).
    first = await manager.set_policy({"max_trade_usdc": "50", "period_spend_cap": "900"})
    assert first.outcome == "mixed" and first.queued_id is not None
    assert (await manager.set_policy({"max_trade_usdc": "40"})).outcome == "immediate"
    queued = next(q for q in await manager.list_queued() if q.id == first.queued_id)
    assert queued.detail["superseded"] == ["max_trade_usdc"]
    await warp(3_601)
    await manager.execute_queued(first.queued_id)
    policy = (await manager.state()).policy
    assert (policy.max_trade_usdc, policy.period_spend_cap) == (40_000_000, 900_000_000)

    # A queued allowlist addition goes stale when the token is removed after it.
    add = await manager.set_token_allowed(token, True)
    assert add.outcome == "queued" and add.queued_id is not None
    assert (await manager.set_token_allowed(token, False)).outcome == "immediate"
    item = next(q for q in await manager.list_queued() if q.id == add.queued_id)
    assert (item.kind, item.status) == ("allowToken", "stale")
    await warp(3_601)
    with pytest.raises(ContractRevertError) as stale:
        await manager.execute_queued(add.queued_id)
    assert (stale.value.revert.name, stale.value.revert.source) == (
        "StaleQueued",
        "AgentPolicyRegistry",
    )

    # Every queue kind decodes; pausing cancels them all.
    await manager.set_token_allowed(token, True)
    await manager.set_increase_delay(60)
    await manager.transfer_ownership(new_key().address)
    await manager.add_agent(new_key().address)
    pending = [q for q in await manager.list_queued() if q.status == "pending"]
    assert {q.kind for q in pending} == {"allowToken", "delay", "owner", "addAgent"}
    await manager.pause_agents(True)
    with pytest.raises(ContractRevertError) as paused:
        await agent.buy(token, usdc="1")
    assert paused.value.revert.name == "Paused"
    assert all(q.status != "pending" for q in await manager.list_queued())
    await manager.pause_agents(False)

    # Claims land in the account; a sweep pays the owner in native wei.
    assert (await agent.claim_fees()).usdc_received6 > 0
    owner_before = await mf.rpc.get_balance(owner.address)
    await agent.sweep_to_owner(usdc="1")
    assert await mf.rpc.get_balance(owner.address) - owner_before == WAD

    # Revoke for good and withdraw everything.
    await manager.revoke_agent(agent_signer.address)
    with pytest.raises(ContractRevertError) as gone:
        await agent.buy(token, usdc="1")
    assert gone.value.revert.name == "NotAgent"
    assert (await agent.status()).retired
    await manager.withdraw_many()
    assert await mf.rpc.get_balance(account) == 0
    assert await mf.rpc.read(LAUNCH_TOKEN, token, "balanceOf", account) == 0
    assert await latest_ts() // DAY == DAY0["day"]  # the whole run stayed in one period
