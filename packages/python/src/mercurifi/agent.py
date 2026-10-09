"""The agent-side client: typed calls to the account, each preflighted against the account's own checks, signed locally
and returned as a measured fill (TS agent.ts)."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .abi import AGENT_ACCOUNT, BONDING_CURVE, LAUNCH_FACTORY, LAUNCH_TOKEN
from .basis import curve_sell_value6, read_basis, recorded_sell_value6
from .curve import PHASE_GRADUATED, PHASE_TRADING, buy_impact_bps, may_graduate_buy, sell_impact_bps
from .errors import InvalidInputError
from .fills import Fill, fill_from_receipt
from .networks import AgentBook
from .permissions import PERMISSIONS
from .policy import ChainPolicy
from .reads import AgentInfo, read_agent, read_paused, read_policy, read_registry
from .revert import local_revert
from .signers import Signer
from .time import chain_deadline
from .tx import WriteRequest
from .units import (
    SCALE, apply_slippage_floor, format_usdc6, resolve_token_amount, resolve_usdc6, slippage_to_bps, usdc6_to_wei,
    wei_to_usdc6_ceil, wei_to_usdc6_floor,
)

if TYPE_CHECKING:
    from decimal import Decimal

    from .client import AsyncClient

ZERO = "0x" + "00" * 20
MAX_UINT256 = 2**256 - 1


@dataclass(frozen=True)
class Headroom:
    spend_usdc6: int
    sell_usdc6: int
    actions: int
    launches: int
    max_trade_usdc6: int
    spend: str
    sell: str
    max_trade: str
    period_id: int
    period_ends_at: int
    """Unix seconds when the current fixed period ends and the caps reset."""


@dataclass(frozen=True)
class Position:
    balance_wei: int
    cost_usdc6: int
    """Recorded cost of `basis_tokens`, usdc6."""
    basis_tokens: int
    high_water: int
    """High-water average cost, usdc6 per token unit x 1e36; sells are valued at no less than this."""
    spent_this_period6: int


@dataclass(frozen=True)
class Gate:
    """The registry's authorize() preamble, read at one block: everything later in the same action reads `at` too."""

    at: int
    timestamp: int
    policy: ChainPolicy
    room: tuple[int, int, int, int]


class AgentClient:
    """Agent-side client for one account and one agent key."""

    def __init__(self, mf: AsyncClient, agents: AgentBook, account: str, signer: Signer, slippage_bps: int, deadline_seconds: int) -> None:
        self._mf = mf
        self._agents = agents
        self.account = account
        self.signer = signer
        self._slippage_bps = slippage_bps
        self._deadline_seconds = deadline_seconds

    async def status(self) -> AgentInfo:
        return await read_agent(self._mf.rpc, self._agents, self.account, self.signer.address, await self._mf.rpc.latest_timestamp())

    async def headroom(self) -> Headroom:
        """Period limits left, read from the policy registry (authoritative; no API needed), all at one block."""
        rpc, registry = self._mf.rpc, self._agents.registry
        at = _block_number(await rpc.get_block())
        room, usage, policy, period = await asyncio.gather(
            read_registry(rpc, registry, "headroom", self.account, at=at), read_registry(rpc, registry, "usage", self.account, at=at),
            self._policy(at), read_registry(rpc, registry, "periodSeconds", self.account, at=at),
        )
        spend, sell, actions, launches = (int(x) for x in room)
        period_id = int(usage[0])
        return Headroom(spend, sell, actions, launches, policy.max_trade_usdc, format_usdc6(spend), format_usdc6(sell),
                        format_usdc6(policy.max_trade_usdc), period_id, (period_id + 1) * int(period))

    async def position(self, token: str) -> Position:
        rpc = self._mf.rpc
        at = _block_number(await rpc.get_block())
        balance, basis, spent = await asyncio.gather(
            self._balance_of(token, at), read_basis(rpc, self.account, token, at=at),
            read_registry(rpc, self._agents.registry, "tokenSpent", self.account, token, at=at),
        )
        return Position(balance, basis.cost_usdc6, basis.tokens, basis.high_water, int(spent))

    async def buy(self, token: str, *, usdc: str | Decimal | None = None, usdc6: int | None = None, slippage: float | None = None,
                  min_tokens_out: int | None = None) -> Fill:
        """Buys on the curve. Every check the account makes is repeated here first, in the account's order and with its
        error names, so a doomed buy is refused before anything is signed. Returns the measured fill, never the quote."""
        amount6 = resolve_usdc6(usdc, usdc6)
        if amount6 == 0:
            raise InvalidInputError("usdc", "The buy amount must be above zero.")
        bps = self._bps(slippage)
        rpc, registry = self._mf.rpc, self._agents.registry
        # Everything below reads one block, in the account's order: pause and agent checks first, then the token.
        g = await self._gate("buy")
        at, policy = g.at, g.policy
        curve = await self._curve_of(token, at)
        token_spent, phase, launch_block, snipe = await asyncio.gather(
            read_registry(rpc, registry, "tokenSpent", self.account, token, at=at), self._curve_read(curve, "phase", at=at),
            self._curve_read(curve, "launchBlock", at=at), self._curve_read(curve, "currentSnipeBps", at=at),
        )
        if int(phase) != PHASE_TRADING:
            raise local_revert("NotTrading")
        if policy.allowlist_only and not await read_registry(rpc, registry, "tokenAllowed", self.account, token, at=at):
            raise local_revert("TokenNotAllowed")
        # The transaction lands in a later block than `latest`, so its age is at least one block more.
        if at + 1 - int(launch_block) < policy.min_token_age_blocks:
            raise local_revert("TokenTooNew")
        if int(snipe) > policy.max_snipe_bps:
            raise local_revert("SnipeTaxTooHigh", [int(snipe)])
        if amount6 > policy.max_trade_usdc:
            raise local_revert("TradeTooLarge", [policy.max_trade_usdc])
        if amount6 > MAX_UINT256 // SCALE:
            raise local_revert("AmountTooLarge")
        value_wei = usdc6_to_wei(amount6)
        sold, curve_supply, price, quote = await asyncio.gather(
            self._curve_read(curve, "sold", at=at), self._curve_read(curve, "curveSupply", at=at),
            self._curve_read(curve, "price", at=at), self._curve_read(curve, "quoteBuy", value_wei, at=at),
        )
        tokens_out, usdc_used, fee, tax = (int(x) for x in quote)
        if tokens_out == 0:
            raise local_revert("ZeroOutput")
        impact = buy_impact_bps(usdc_used - fee - tax, tokens_out, int(price))
        if impact > policy.max_price_impact_bps:
            raise local_revert("PriceImpactTooHigh", [impact])
        # The account records what it actually spends (a final buy refunds the surplus), rounded up to usdc6.
        spend6 = wei_to_usdc6_ceil(usdc_used)
        if spend6 > g.room[0]:
            raise local_revert("PeriodSpendExceeded", [g.room[0]])
        token_left = max(policy.per_token_period_cap - int(token_spent), 0)
        if spend6 > token_left:
            raise local_revert("TokenCapExceeded", [token_left])
        min_out = max(apply_slippage_floor(tokens_out, bps), min_tokens_out or 0, 1)
        may_graduate = may_graduate_buy(value_wei, usdc_used, tokens_out, int(curve_supply) - int(sold))
        deadline = await chain_deadline(rpc, policy.max_deadline_seconds, self._deadline_seconds)
        return await self._send(AGENT_ACCOUNT.encode("buy", token, amount6, min_out, deadline), may_graduate, "buy")

    async def sell(self, token: str, *, amount: str | Decimal | None = None, amount_wei: int | None = None, slippage: float | None = None,
                   min_usdc_out6: int | None = None) -> Fill:
        """Sells on the curve. The sell is valued like the account values it (recorded part at the higher of the average and
        high-water cost, excess at its quote) and refused locally when that value is above maxTradeUsdc or above the sell
        headroom left in the period."""
        resolved = resolve_token_amount(amount, amount_wei)
        bps = self._bps(slippage)
        rpc = self._mf.rpc
        g = await self._gate("sell")
        at, policy = g.at, g.policy
        curve = await self._curve_of(token, at)
        balance = await self._balance_of(token, at)
        tokens_in = balance if resolved == "all" else resolved
        if tokens_in == 0:
            raise InvalidInputError("amount", "The account holds none of this token." if resolved == "all" else "The sell amount must be above zero.")
        if tokens_in > balance:
            raise InvalidInputError("amount", "The account holds less of this token than the amount to sell.")
        phase, price, quote, basis = await asyncio.gather(
            self._curve_read(curve, "phase", at=at), self._curve_read(curve, "price", at=at),
            self._curve_read(curve, "quoteSell", tokens_in, at=at), read_basis(rpc, self.account, token, at=at),
        )
        if int(phase) == PHASE_GRADUATED:
            raise local_revert("NotTrading")
        if min_usdc_out6 is not None and min_usdc_out6 > MAX_UINT256 // SCALE:
            raise local_revert("AmountTooLarge")
        recorded, _ = recorded_sell_value6(basis, tokens_in)
        excess_out_wei = int((await self._curve_read(curve, "quoteSell", tokens_in - recorded, at=at))[0]) if tokens_in > recorded else 0
        basis_value = curve_sell_value6(basis, tokens_in, excess_out_wei)
        if basis_value > policy.max_trade_usdc:
            raise local_revert("TradeTooLarge", [policy.max_trade_usdc])
        out, fee = int(quote[0]), int(quote[1])
        if out == 0:
            raise local_revert("ZeroOutput")
        # The account takes the floor in usdc6; proceeds under one micro-USDC cannot carry a non-zero minimum.
        if out < SCALE:
            raise InvalidInputError("amount", "The sell proceeds are below 1 micro-USDC; sell a larger amount.")
        impact = sell_impact_bps(out + fee, tokens_in, int(price))
        if impact > policy.max_price_impact_bps:
            raise local_revert("PriceImpactTooHigh", [impact])
        if basis_value > g.room[1]:
            raise local_revert("PeriodSellExceeded", [g.room[1]])
        # out >= 1e12 here, so a slippage floor that rounds to zero is raised to the smallest valid minimum.
        min_out6 = max(wei_to_usdc6_floor(apply_slippage_floor(out, bps)), 1, min_usdc_out6 or 0)
        deadline = await chain_deadline(rpc, policy.max_deadline_seconds, self._deadline_seconds)
        return await self._send(AGENT_ACCOUNT.encode("sell", token, tokens_in, min_out6, deadline), False, "sell")

    async def _gate(self, permission: str) -> Gate:
        """The registry's authorize() preamble against one pinned block: Paused first (the account owner's pause or the
        platform pause), then the agent, then the policy and headroom."""
        rpc = self._mf.rpc
        block = await rpc.get_block()
        at, now = _block_number(block), _block_timestamp(block)
        paused, agent, policy, room = await asyncio.gather(
            read_paused(rpc, self._agents, self.account, at=at),
            read_agent(rpc, self._agents, self.account, self.signer.address, now, at=at),
            self._policy(at), read_registry(rpc, self._agents.registry, "headroom", self.account, at=at),
        )
        if paused:
            raise local_revert("Paused")
        spend, sell, actions, launches = (int(x) for x in room)
        _check_agent(agent, permission, actions, now)
        return Gate(at, now, policy, (spend, sell, actions, launches))

    async def _send(self, data: str, may_graduate: bool, label: str) -> Fill:
        sent = await self._mf.sender.send(self.signer, WriteRequest(self.account, data, label, may_graduate=may_graduate))
        return fill_from_receipt(sent.receipt, self.account, self._mf.network.launch.factory)

    def _bps(self, slippage: float | None) -> int:
        return self._slippage_bps if slippage is None else slippage_to_bps(slippage)

    async def _curve_of(self, token: str, at: int | None = None) -> str:
        curve = str(await self._mf.rpc.read(LAUNCH_FACTORY, self._mf.network.launch.factory, "curveOf", token, at=at))
        if curve.lower() == ZERO:
            raise local_revert("TokenNotRegistered")
        return curve

    async def _curve_read(self, curve: str, fn: str, *args: object, at: int | None = None) -> Any:
        return await self._mf.rpc.read(BONDING_CURVE, curve, fn, *args, at=at)

    async def _policy(self, at: int | None = None) -> ChainPolicy:
        """The account's policy, from the registry."""
        return await read_policy(self._mf.rpc, self._agents, self.account, at=at)

    async def _balance_of(self, token: str, at: int | None = None) -> int:
        return int(await self._mf.rpc.read(LAUNCH_TOKEN, token, "balanceOf", self.account, at=at))


def _check_agent(agent: AgentInfo, permission: str, actions_left: int, now: int) -> None:
    """The registry's authorize() preamble: active, unexpired, permitted, and an action left in the period."""
    if not agent.active:
        raise local_revert("NotAgent")
    # The transaction lands at least one block-time after `latest`, so a key expiring that soon cannot succeed.
    if now + 1 >= agent.expires_at:
        raise local_revert("AgentExpired")
    if agent.permission_bits & PERMISSIONS[permission] == 0:
        raise local_revert("MissingPermission")
    if actions_left == 0:
        raise local_revert("ActionLimit")


def _block_number(block: dict[str, Any]) -> int:
    return int(block["number"], 16)


def _block_timestamp(block: dict[str, Any]) -> int:
    return int(block["timestamp"], 16)
