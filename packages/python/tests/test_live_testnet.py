"""Opt-in check against the public Arc testnet RPC (the SDK's default; never a paid provider). Skipped unless
MERCURIFI_LIVE_TESTNET=1: `MERCURIFI_LIVE_TESTNET=1 uv run pytest tests/test_live_testnet.py`. The first test is
read-only; the signals test also needs MERCURIFI_TEST_AGENT_KEY, MERCURIFI_TEST_AGENT_ACCOUNT and MERCURIFI_TEST_TOKEN
(and, for the owner step, MERCURIFI_TEST_OWNER_KEY) and writes one signal and one note to the testnet API, then removes
them."""

import os
import re
import time
from collections.abc import Awaitable, Callable

import pytest

from mercurifi.agent import AgentClient
from mercurifi.client import create_client
from mercurifi.identity import get_agent
from mercurifi.networks import TESTNET
from mercurifi.signers import local_key

pytestmark = pytest.mark.skipif(
    os.environ.get("MERCURIFI_LIVE_TESTNET") != "1",
    reason="set MERCURIFI_LIVE_TESTNET=1 to read the live testnet",
)


async def test_passes_start_up_verification_of_the_pinned_agent_deployment() -> None:
    mf = await create_client("testnet", api=None)
    try:
        assert TESTNET.agents is not None
        assert mf.require_agents() is TESTNET.agents
        assert await mf.rpc.block_number() > TESTNET.agents.deploy_block
        agent = await get_agent(mf.rpc, "testnet", 1)
        assert agent.agent_id == 1 and re.fullmatch(r"0x[0-9a-fA-F]{40}", agent.owner)
    finally:
        await mf.aclose()


AGENT_KEY = os.environ.get("MERCURIFI_TEST_AGENT_KEY", "")
AGENT_ACCOUNT = os.environ.get("MERCURIFI_TEST_AGENT_ACCOUNT", "")
OWNER_KEY = os.environ.get("MERCURIFI_TEST_OWNER_KEY", "")
# A Launch token on testnet to signal on; the account's owner must have switched posting on for the agent flow.
TOKEN = os.environ.get("MERCURIFI_TEST_TOKEN", "")
_ADDR = re.compile(r"0x[0-9a-fA-F]{40}")
HAS_AGENT = (
    AGENT_KEY != ""
    and _ADDR.fullmatch(AGENT_ACCOUNT) is not None
    and _ADDR.fullmatch(TOKEN) is not None
)


@pytest.mark.skipif(not HAS_AGENT, reason="needs the MERCURIFI_TEST_AGENT_* and TOKEN variables")
async def test_agent_signals_posts_reads_the_note_back_and_cleans_up() -> None:
    mf = await create_client("testnet")
    agent: AgentClient | None = None
    note_id: int | None = None
    try:
        # Built inside the try so the client is closed even if the account check fails.
        agent = await mf.agent(AGENT_ACCOUNT, local_key(AGENT_KEY))
        await agent.signal(TOKEN, "bullish")
        note = await agent.notes.post(TOKEN, f"sdk live check {int(time.time() * 1000)}")
        note_id = note["id"]
        read = await mf.notes.get(note["id"])
        assert read["agent"] is True and read["body"] == note["body"]
        assert any(n["id"] == note_id for n in (await mf.notes.list(TOKEN))["notes"])
    finally:
        # Each step runs even if an earlier one raises; the first failure is raised.
        errors: list[BaseException] = []

        async def attempt(step: Callable[[], Awaitable[None]]) -> None:
            try:
                await step()
            except Exception as e:
                errors.append(e)

        if agent is not None:
            a = agent
            if note_id is not None:
                last = note_id
                await attempt(lambda: a.notes.delete(last))
            await attempt(lambda: a.signal(TOKEN, None))
            await attempt(a.sign_out)
        await attempt(mf.aclose)
        if errors:
            raise errors[0]


@pytest.mark.skipif(
    not HAS_AGENT or OWNER_KEY == "", reason="needs MERCURIFI_TEST_OWNER_KEY as well"
)
async def test_owner_reads_the_posting_switch_and_never_turns_it_off() -> None:
    mf = await create_client("testnet")
    owner = mf.owner(local_key(OWNER_KEY))
    try:
        posting = await owner.agent_posting(AGENT_ACCOUNT)
        assert isinstance(posting["enabled"], bool)
    finally:
        await owner.sign_out()
        await mf.aclose()
