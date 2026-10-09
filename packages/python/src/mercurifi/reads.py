"""Shared typed reads: account and registry state, ceilings, agents. Registry views take the account first."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .abi import AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY
from .networks import AgentBook
from .permissions import decode_permissions
from .policy import ChainPolicy
from .rpc import Rpc


async def read_account(rpc: Rpc, account: str, fn: str, *args: object, at: int | None = None) -> Any:
    """A read of the account itself (funds, basis, owner, referrer); `at` pins it to a block."""
    return await rpc.read(AGENT_ACCOUNT, account, fn, *args, at=at)


async def read_registry(rpc: Rpc, registry: str, fn: str, *args: object, at: int | None = None) -> Any:
    """A read of the policy registry. Every registry view takes the account as its first argument; `at` pins it to a block."""
    return await rpc.read(AGENT_POLICY_REGISTRY, registry, fn, *args, at=at)


async def read_policy(rpc: Rpc, agents: AgentBook, account: str, *, at: int | None = None) -> ChainPolicy:
    return ChainPolicy.from_abi(await read_registry(rpc, agents.registry, "policy", account, at=at))


async def read_paused(rpc: Rpc, agents: AgentBook, account: str, *, at: int | None = None) -> bool:
    """The account owner's pause or the platform pause (the registry's authorize() checks both, first)."""
    owner, platform = await asyncio.gather(
        read_registry(rpc, agents.registry, "ownerPaused", account, at=at),
        rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "isPaused", at=at),
    )
    return bool(owner) or bool(platform)


async def latest_timestamp(rpc: Rpc) -> int:
    return await rpc.latest_timestamp()


@dataclass(frozen=True)
class AccountState:
    account: str
    registry: str
    owner: str
    referrer: str
    policy: ChainPolicy
    period_seconds: int
    increase_delay: int
    owner_paused: bool
    factory_paused: bool
    active_agent_count: int
    epoch: int
    #: Registry write sequence: queued items record it; a subject written after an item's `seq` is not overwritten by it.
    write_seq: int
    balance_wei: int


async def read_account_state(rpc: Rpc, agents: AgentBook, account: str) -> AccountState:
    def r(fn: str) -> Any:
        return read_registry(rpc, agents.registry, fn, account)

    owner, referrer, policy, period, delay, paused, count, epoch, write_seq, factory_paused, balance = await asyncio.gather(
        r("owner"), read_account(rpc, account, "referrer"), r("policy"), r("periodSeconds"), r("increaseDelay"), r("ownerPaused"),
        r("activeAgentCount"), r("epoch"), r("writeSeq"),
        rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "isPaused"), rpc.get_balance(account),
    )
    return AccountState(account, agents.registry, owner, referrer, ChainPolicy.from_abi(policy), int(period), int(delay), bool(paused),
                        bool(factory_paused), int(count), int(epoch), int(write_seq), int(balance))


async def read_ceilings(rpc: Rpc, agents: AgentBook) -> ChainPolicy:
    return ChainPolicy.from_abi(await rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "ceilings"))


async def is_agent_account(rpc: Rpc, agents: AgentBook, account: str, *, at: int | None = None) -> bool:
    return bool(await rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "isAccount", account, at=at))


@dataclass(frozen=True)
class AgentInfo:
    address: str
    active: bool
    #: Revoked once; can never be an agent of this account again.
    retired: bool
    expires_at: int
    expired: bool
    permissions: list[str]
    permission_bits: int


async def read_agent(rpc: Rpc, agents: AgentBook, account: str, agent: str, now: int, *, at: int | None = None) -> AgentInfo:
    a, retired = await asyncio.gather(
        read_registry(rpc, agents.registry, "agent", account, agent, at=at),
        read_registry(rpc, agents.registry, "retired", account, agent, at=at),
    )
    expires_at = int(a["expiresAt"])
    bits = int(a["permissions"])
    return AgentInfo(agent, bool(a["active"]), bool(retired), expires_at, expires_at <= now, decode_permissions(bits), bits)
