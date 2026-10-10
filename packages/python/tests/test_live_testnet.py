"""Opt-in, read-only check against the public Arc testnet RPC (the SDK's default; never a paid provider). Skipped unless
MERCURIFI_LIVE_TESTNET=1: `MERCURIFI_LIVE_TESTNET=1 uv run pytest tests/test_live_testnet.py`. Sends nothing."""

import os
import re

import pytest

from mercurifi.client import create_client
from mercurifi.identity import get_agent
from mercurifi.networks import TESTNET

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
