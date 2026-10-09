"""Every public read and write preflight against a closed loopback port with a secret in the RPC URL's path: the
secret must not appear in any error's text, traceback, attributes, cause or context (parity with TS rpc-leak.test.ts).
Set-up answers come from a MockRpc; then requests go to the real (closed) 127.0.0.1:1."""
from __future__ import annotations

import traceback
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from mercurifi.signers import local_key

from .helpers import ACCOUNT, AGENT_KEY, OWNER_KEY, TOKEN, A, local_client, local_rpc, mock_account, mock_curve

SECRET = "SUPERSECRETKEY123"
URL = f"http://127.0.0.1:1/v2/{SECRET}"


class _Switch(httpx.AsyncBaseTransport):
    def __init__(self, mock: httpx.MockTransport) -> None:
        self.mock = mock
        self.real = httpx.AsyncHTTPTransport()
        self.closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.closed:
            return await self.real.handle_async_request(request)  # ConnectError from the real socket
        return await self.mock.handle_async_request(request)

    async def aclose(self) -> None:
        await self.real.aclose()


def _everything(e: BaseException) -> str:
    out: list[str] = []
    seen: set[int] = set()
    stack: list[BaseException | None] = [e]
    while stack:
        cur = stack.pop()
        if cur is None or id(cur) in seen:
            continue
        seen.add(id(cur))
        out.append(str(cur))
        out.append(repr(cur))
        out.append("".join(traceback.format_exception(type(cur), cur, cur.__traceback__)))
        out.extend(repr(v) for v in vars(cur).values())
        stack.extend([cur.__cause__, cur.__context__])
    return "\n".join(out)


async def test_no_rpc_url_in_any_error() -> None:
    owner, agent_key = local_key(OWNER_KEY), local_key(AGENT_KEY)
    rpc = local_rpc()
    mock_account(rpc, owner=owner.address, agent=agent_key.address)
    mock_curve(rpc)
    switch = _Switch(rpc.transport())
    mf = await local_client(rpc, rpc_url=URL, rpc_transport=switch)
    agent = await mf.agent(ACCOUNT, agent_key)
    oc = mf.owner(owner)
    m = await oc.manage(ACCOUNT)
    switch.closed = True
    other = A(0x5555)
    calls: list[tuple[str, Callable[[], Awaitable[Any]]]] = [
        ("token", lambda: mf.token(TOKEN)),
        ("agent()", lambda: mf.agent(ACCOUNT, agent_key)),
        ("manage()", lambda: oc.manage(ACCOUNT)),
        ("status", agent.status),
        ("headroom", agent.headroom),
        ("position", lambda: agent.position(TOKEN)),
        ("buy", lambda: agent.buy(TOKEN, usdc="1")),
        ("sell", lambda: agent.sell(TOKEN, amount="all")),
        ("launch", lambda: agent.launch("Ok", "OK", metadata_uri="ipfs://m")),
        ("swap buy", lambda: agent.swap_exact_in(TOKEN, "buy", usdc="1")),
        ("swap sell", lambda: agent.swap_exact_in(TOKEN, "sell", amount="all")),
        ("claim_fees", agent.claim_fees),
        ("sweep_to_owner", lambda: agent.sweep_to_owner(token=TOKEN, all=True)),
        ("create_account", oc.create_account),
        ("deposit", lambda: oc.deposit(ACCOUNT, usdc="1")),
        ("fund_gas", lambda: oc.fund_gas(agent_key.address, usdc="1")),
        ("accept_ownership", lambda: oc.accept_ownership(ACCOUNT, 1)),
        ("pending_ownership", lambda: oc.pending_ownership(ACCOUNT)),
        ("state", m.state),
        ("preview_policy", lambda: m.preview_policy({"max_trade_usdc": "1"})),
        ("set_policy", lambda: m.set_policy({"max_trade_usdc": "1"})),
        ("add_agent", lambda: m.add_agent(other)),
        ("set_agent", lambda: m.set_agent(agent_key.address, permissions=["buy"])),
        ("rotate_agent", lambda: m.rotate_agent(agent_key.address, other)),
        ("revoke_agent", lambda: m.revoke_agent(agent_key.address)),
        ("set_token_allowed", lambda: m.set_token_allowed(TOKEN, True)),
        ("set_increase_delay", lambda: m.set_increase_delay(60)),
        ("transfer_ownership", lambda: m.transfer_ownership(other)),
        ("list_queued", m.list_queued),
        ("execute_queued", lambda: m.execute_queued(1)),
        ("cancel_queued", lambda: m.cancel_queued(1)),
        ("pause_agents", lambda: m.pause_agents(True)),
        ("withdraw", lambda: m.withdraw(token=TOKEN, all=True)),
        ("withdraw_many (discovery)", m.withdraw_many),
    ]
    leaks, silent = [], []
    for name, f in calls:
        try:
            await f()
            silent.append(name)
        except Exception as e:  # noqa: BLE001 - every failure is inspected
            if SECRET in _everything(e):
                leaks.append(name)
    await mf.aclose()
    assert silent == []
    assert leaks == []
