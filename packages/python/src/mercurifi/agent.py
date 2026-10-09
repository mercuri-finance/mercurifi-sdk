"""The agent-side client: typed calls to the account, each preflighted against the account's own checks, signed locally
and returned as a measured fill (TS agent.ts)."""
from __future__ import annotations

import asyncio
import re
import secrets
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from .abi import AGENT_ACCOUNT, BONDING_CURVE, LAUNCH_FACTORY, LAUNCH_TOKEN
from .basis import curve_sell_value6, pool_sell_value6, read_basis, recorded_sell_value6
from .curve import PHASE_GRADUATED, PHASE_TRADING, LaunchConfig, buy_impact_bps, may_graduate_buy, quote_fresh_buy, sell_impact_bps
from .errors import BuildMismatchError, InvalidInputError, MercurifiError
from .fills import Fill, fill_from_receipt
from .networks import AgentBook
from .permissions import PERMISSIONS
from .policy import ChainPolicy
from .pool import UINT128_MAX, estimate_pool_impact_bps, quote_exact_in, read_pool_key
from .reads import AgentInfo, read_agent, read_paused, read_policy, read_registry
from .revert import local_revert
from .signers import Signer
from .time import chain_deadline
from .tx import WriteRequest
from .units import (
    SCALE,
    apply_slippage_floor,
    format_usdc6,
    resolve_token_amount,
    resolve_usdc6,
    slippage_to_bps,
    usdc6_to_wei,
    wei_to_usdc6_ceil,
    wei_to_usdc6_floor,
)

if TYPE_CHECKING:
    from decimal import Decimal

    from .client import AsyncClient

ZERO = "0x" + "00" * 20
MAX_UINT256 = 2**256 - 1
_BUILT_PERMISSION = {"buy": "buy", "sell": "sell", "launch": "launch", "swapExactIn": "swap", "claimFees": "claim", "sweepToOwner": "sweep"}
_SALT = re.compile(r"0x[0-9a-fA-F]{64}")


@dataclass(frozen=True)
class ImageUpload:
    data: bytes
    content_type: Literal["image/png", "image/jpeg"]
    filename: str | None = None


def _utf8_len(value: str) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return 1 << 30  # lone surrogates cannot be UTF-8; treated as out of range by every caller


def metadata_uri_problem(uri: object) -> str | None:
    """Why a metadata URI cannot be used, or None: https:// or ipfs://, no credentials, whitespace, control or format
    characters, at most 256 UTF-8 bytes. The value is never echoed."""
    if not isinstance(uri, str) or uri == "":
        return "it is empty or not a string"
    if re.match(r"(?:https|ipfs)://.", uri) is None:
        return "it must start with https:// or ipfs://"
    if any(c.isspace() or unicodedata.category(c) in ("Cc", "Cf", "Cs") for c in uri):
        return "it contains whitespace or control characters"
    # Credentials in a URI would be published on chain and sent to every reader's browser.
    if re.match(r"(?:https|ipfs)://[^/?#]*@", uri) is not None:
        return "it contains embedded credentials"
    if _utf8_len(uri) > 256:
        return "it is longer than 256 bytes"
    return None


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
        at, _ = await rpc.latest_block()
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
        at, _ = await rpc.latest_block()
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
        # Phase first: quoteSell on a graduated curve would revert with the curve's own error instead of NotTrading.
        if int(await self._curve_read(curve, "phase", at=at)) == PHASE_GRADUATED:
            raise local_revert("NotTrading")
        price, quote, basis = await asyncio.gather(
            self._curve_read(curve, "price", at=at), self._curve_read(curve, "quoteSell", tokens_in, at=at), read_basis(rpc, self.account, token, at=at),
        )
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

    async def launch(self, name: str, symbol: str, *, description: str | None = None, links: dict[str, str] | None = None,
                     image: ImageUpload | None = None, metadata_uri: str | None = None, initial_buy_usdc: str | Decimal | None = None,
                     initial_buy_usdc6: int | None = None, salt: str | None = None) -> Fill:
        """Launches a token whose creator is the account. Metadata goes through the API unless `metadata_uri` is given. The
        checks run in the account's order (pause, agent, trade limit), then the factory's cap on the initial buy, then the
        period caps; the request carries a chain-time deadline like a trade. The fill reports the new token and curve."""
        if not isinstance(name, str) or not 1 <= _utf8_len(name) <= 32:
            raise InvalidInputError("name", "name must be 1–32 bytes (UTF-8)")
        if not isinstance(symbol, str) or not 1 <= _utf8_len(symbol) <= 10:
            raise InvalidInputError("symbol", "symbol must be 1–10 bytes (UTF-8)")
        has_metadata = description is not None or links is not None or image is not None
        if metadata_uri is not None and has_metadata:
            raise InvalidInputError("metadata_uri", "pass either metadata_uri or description, links and image, not both")
        if metadata_uri == "":
            self._mf.warn("metadata_uri is empty: the launch is valid, but tokens without Mercurifi-hosted metadata are hidden from the Mercurifi board.")
        if metadata_uri is not None and metadata_uri != "":
            problem = metadata_uri_problem(metadata_uri)
            if problem is not None:
                raise InvalidInputError("metadata_uri", f"metadata_uri is not usable: {problem}")
        if metadata_uri is None and has_metadata and self._mf.api is None:
            raise InvalidInputError("metadata_uri", "Uploading a description, links or an image needs the Mercurifi API; pass metadata_uri to launch chain-only.")
        if salt is not None and not (isinstance(salt, str) and _SALT.fullmatch(salt)):
            raise InvalidInputError("salt", "salt must be 32 bytes of hex (0x plus 64 hex digits)")
        first6 = 0 if initial_buy_usdc is None and initial_buy_usdc6 is None else resolve_usdc6(initial_buy_usdc, initial_buy_usdc6, "initial_buy_usdc")
        rpc, factory = self._mf.rpc, self._mf.network.launch.factory
        g = await self._gate("launch")
        at, policy = g.at, g.policy
        raw, config_hash, launch_paused = await asyncio.gather(
            rpc.read(LAUNCH_FACTORY, factory, "config", at=at), rpc.read(LAUNCH_FACTORY, factory, "configHash", at=at),
            rpc.read(LAUNCH_FACTORY, factory, "paused", at=at),
        )
        config = LaunchConfig.from_abi(raw)
        # The account's own test: the initial buy and the launch fee (usdc6, rounded up) must both fit in maxTradeUsdc.
        if first6 > policy.max_trade_usdc or wei_to_usdc6_ceil(config.launch_fee) > policy.max_trade_usdc - first6:
            raise local_revert("TradeTooLarge", [policy.max_trade_usdc])
        if first6 > MAX_UINT256 // SCALE:
            raise local_revert("AmountTooLarge")
        if launch_paused:
            raise local_revert("EnforcedPause")
        # The initial buy runs tax-exempt in the launch block, before any other trade, so this quote is exact.
        quote = None if first6 == 0 else quote_fresh_buy(config, usdc6_to_wei(first6))
        if quote is not None and quote[0] == 0:
            raise local_revert("ZeroOutput")
        if quote is not None and quote[0] > config.max_initial_buy_tokens:
            raise local_revert("InitialBuyTooLarge")
        # What the account records: the fee plus what the initial buy really uses (a surplus is refunded), rounded up.
        spend6 = wei_to_usdc6_ceil(config.launch_fee + (0 if quote is None else quote[1]))
        if spend6 > g.room[0]:
            raise local_revert("PeriodSpendExceeded", [g.room[0]])
        if spend6 > policy.per_token_period_cap:
            raise local_revert("TokenCapExceeded", [policy.per_token_period_cap])
        if g.room[3] == 0:
            raise local_revert("LaunchLimit")

        uri = metadata_uri if metadata_uri is not None else ""
        if metadata_uri is None and has_metadata:
            assert self._mf.api is not None
            meta: dict[str, Any] = {}
            if description is not None:
                meta["description"] = description
            if links is not None:
                meta["links"] = links
            # The API is untrusted: its answer is checked like user input, and never echoed.
            response = await self._mf.api.upload_launch_metadata(meta, image)
            uri = response.get("metadataURI") if isinstance(response, Mapping) else None  # type: ignore[assignment]
            problem = metadata_uri_problem(uri)
            if problem is not None:
                raise MercurifiError(f"The API returned a metadata URI that cannot be used ({problem}); nothing was signed.", code="API_BAD_RESPONSE")
        # After the upload, so a slow upload cannot use up the deadline window.
        deadline = await chain_deadline(rpc, policy.max_deadline_seconds, self._deadline_seconds)
        request = {"name": name, "symbol": symbol, "metadataURI": uri, "salt": salt if salt is not None else "0x" + secrets.token_hex(32),
                   "expectedConfigHash": config_hash, "initialBuyUsdc": first6, "minTokensOut": 0 if quote is None else quote[0], "deadline": deadline}
        return await self._send(AGENT_ACCOUNT.encode("launch", request), False, "launch")

    async def swap_exact_in(self, token: str, side: Literal["buy", "sell"], *, usdc: str | Decimal | None = None, usdc6: int | None = None,
                            amount: str | Decimal | None = None, amount_wei: int | None = None, slippage: float | None = None) -> Fill:
        """Exact-in swap on a graduated Launch pool. A buy spends usdc6 (the pool's 6-decimal USDC view); a sell spends tokens
        ('all' allowed) for a usdc6 minimum. The pool is derived, never supplied. Buys above maxTradeUsdc and sells valued above
        it are refused locally. A quoted price impact above the policy only warns: the account measures the real one."""
        if side not in ("buy", "sell"):
            raise InvalidInputError("side", "side must be 'buy' or 'sell'")
        buy_token = side == "buy"
        if buy_token and (amount is not None or amount_wei is not None):
            raise InvalidInputError("amount", "a pool buy spends USDC: pass usdc or usdc6")
        if not buy_token and (usdc is not None or usdc6 is not None):
            raise InvalidInputError("usdc", "a pool sell spends tokens: pass amount or amount_wei")
        bps = self._bps(slippage)
        wanted = resolve_usdc6(usdc, usdc6) if buy_token else resolve_token_amount(amount, amount_wei)
        rpc, book = self._mf.rpc, self._mf.network
        g = await self._gate("swap")
        at, policy = g.at, g.policy
        curve = await self._curve_of(token, at)
        if int(await self._curve_read(curve, "phase", at=at)) != PHASE_GRADUATED:
            raise local_revert("NotGraduated")
        balance = 0 if buy_token else await self._balance_of(token, at)
        amount_in = balance if wanted == "all" else wanted
        if amount_in == 0:
            raise InvalidInputError("usdc" if buy_token else "amount", "The account holds none of this token." if wanted == "all" else "The swap amount must be above zero.")
        if amount_in > UINT128_MAX:
            raise local_revert("AmountTooLarge")
        if not buy_token and amount_in > balance:
            raise InvalidInputError("amount", "The account holds less of this token than the amount to sell.")
        key = await read_pool_key(rpc, book, token, at=at)

        basis = None
        if buy_token:
            if policy.allowlist_only and not await read_registry(rpc, self._agents.registry, "tokenAllowed", self.account, token, at=at):
                raise local_revert("TokenNotAllowed")
            if amount_in > policy.max_trade_usdc:
                raise local_revert("TradeTooLarge", [policy.max_trade_usdc])
        else:
            basis = await read_basis(rpc, self.account, token, at=at)
            # Before the swap the account values only the recorded part; the excess is added once the proceeds are known.
            if recorded_sell_value6(basis, amount_in)[1] > policy.max_trade_usdc:
                raise local_revert("TradeTooLarge", [policy.max_trade_usdc])

        zero_for_one = (book.launch.usdc if buy_token else token).lower() == str(key["currency0"]).lower()
        out = await quote_exact_in(rpc, book, key, zero_for_one, amount_in, self.account, at=at)
        if out == 0:
            if buy_token:
                raise local_revert("ZeroOutput")
            raise InvalidInputError("amount", "The sell proceeds are below 1 micro-USDC; sell a larger amount.")
        if buy_token:
            # An exact-in buy spends the whole amount.
            if amount_in > g.room[0]:
                raise local_revert("PeriodSpendExceeded", [g.room[0]])
            spent = int(await read_registry(rpc, self._agents.registry, "tokenSpent", self.account, token, at=at))
            token_left = max(policy.per_token_period_cap - spent, 0)
            if amount_in > token_left:
                raise local_revert("TokenCapExceeded", [token_left])
        else:
            assert basis is not None
            value = pool_sell_value6(basis, amount_in, out * SCALE)
            if value > policy.max_trade_usdc:
                raise local_revert("TradeTooLarge", [policy.max_trade_usdc])
            if value > g.room[1]:
                raise local_revert("PeriodSellExceeded", [g.room[1]])
        impact = await estimate_pool_impact_bps(rpc, book, key, zero_for_one, amount_in, out, self.account, at=at)
        if impact is not None and impact > policy.max_price_impact_bps:
            self._mf.warn(
                f"This swap may move the pool price by about {impact} bps (approximate), above the account limit of {policy.max_price_impact_bps} bps. "
                "The account's own check enforces the real limit and refuses the swap if it is exceeded; try a smaller amount.")
        # Slippage floor on the quote; never zero. (A sell's output is usdc6, a buy's is token wei.)
        min_out = max(apply_slippage_floor(out, bps), 1)
        deadline = await chain_deadline(rpc, policy.max_deadline_seconds, self._deadline_seconds)
        return await self._send(AGENT_ACCOUNT.encode("swapExactIn", token, buy_token, amount_in, min_out, deadline), False, "poolBuy" if buy_token else "poolSell")

    async def claim_fees(self) -> Fill:
        """Claims the account's creator and referral fees into the account itself. No deadline."""
        await self._gate("claim")
        return await self._send(AGENT_ACCOUNT.encode("claimFees"), False, "claim")

    async def sweep_to_owner(self, *, token: str | None = None, usdc: str | Decimal | None = None, usdc6: int | None = None, all: bool = False,
                             amount: str | Decimal | None = None, amount_wei: int | None = None) -> Fill:
        """Moves native USDC (wei; `usdc`/`usdc6`, or everything with `all`) or a registered Launch token (`amount`/`amount_wei`,
        or everything with `all` or amount 'all') to the owner. No deadline."""
        sweep_all = all  # the public keyword shadows the builtin; keep it out of the body
        native = token is None or token.lower() == ZERO
        given = sum(v is not None for v in (usdc, usdc6, amount, amount_wei))
        if sweep_all and given > 0:
            raise InvalidInputError("all", "all cannot be combined with an amount")
        if native and (amount is not None or amount_wei is not None) and amount != "all":
            raise InvalidInputError("amount", "a native sweep is in USDC: pass usdc or usdc6 (or all)")
        if not native and (usdc is not None or usdc6 is not None):
            raise InvalidInputError("usdc", "a token sweep is in token units: pass amount or amount_wei (or all)")
        g = await self._gate("sweep")
        target = ZERO
        if native:
            everything = sweep_all or amount == "all"
            balance = await self._mf.rpc.get_balance(self.account, at=g.at)
            value = balance if everything else usdc6_to_wei(resolve_usdc6(usdc, usdc6))
            if value > balance:
                raise InvalidInputError("usdc", f"The account holds {format_usdc6(balance // SCALE)} USDC, less than the amount to sweep.")
        else:
            assert token is not None
            target = token
            await self._curve_of(token, g.at)  # TokenNotRegistered: only Launch tokens can be swept
            wanted = "all" if sweep_all else resolve_token_amount(amount, amount_wei)
            held = await self._balance_of(token, g.at)
            value = held if wanted == "all" else wanted
            if value > held:
                raise InvalidInputError("amount", "The account holds less of this token than the amount to sweep.")
        if value == 0:
            raise InvalidInputError("amount", "Nothing to sweep.")
        return await self._send(AGENT_ACCOUNT.encode("sweepToOwner", target, value), False, "sweep")

    async def send_built(self, built: Mapping[str, Any], *, function_name: str, exact: Mapping[str, Any] | None = None,
                         at_least: Mapping[str, int] | None = None, deadline: tuple[int, int] | None = None) -> Fill:
        """Verifies API-built calldata against your expectation, then signs and sends it. Refuses on any mismatch.

        Build the expectation from your own request, never from the build response (that would compare the answer with
        itself). It must cover every argument (see verify_built_tx): buy, sell and swap_exact_in need every token, amount
        and flag in `exact`, the min...Out in `at_least` (or `exact`); sweepToOwner needs `token` and `amount`; claimFees
        nothing. A launch needs all eight request fields; its `expectedConfigHash` must be the factory's current
        `configHash()`, which is read here (omit it), and its deadline is checked against a window computed here from the
        latest block and the policy. Your own `deadline` window is intersected with that window, never widened. The local
        permission, pause and cap checks run first, and a buy always gets the graduation gas floor.
        """
        from .build_verify import snapshot_built, snapshot_expectation, verify_built_tx

        if type(function_name) is not str or function_name not in _BUILT_PERMISSION:  # own keys of a dict: no inherited names
            raise InvalidInputError("function_name", "function_name is not an agent trade function")
        exact_c, least_c, caller_window = snapshot_expectation(exact, at_least, deadline)
        snap = snapshot_built(built)
        g = await self._gate(_BUILT_PERMISSION[function_name])
        own = min(self._deadline_seconds, g.policy.max_deadline_seconds)
        if isinstance(own, bool) or not isinstance(own, int) or own < 1:
            raise InvalidInputError("deadline_seconds", "the deadline window must be at least 1 second (check deadline_seconds and the policy max_deadline_seconds)")
        lo, hi = g.timestamp, g.timestamp + own
        if caller_window is not None:
            lo, hi = max(lo, caller_window[0]), min(hi, caller_window[1])  # a caller window may only narrow
        expected = dict(exact_c) if exact_c is not None else None
        if function_name == "launch":
            config_hash = str(await self._mf.rpc.read(LAUNCH_FACTORY, self._mf.network.launch.factory, "configHash", at=g.at))
            if expected is not None and "expectedConfigHash" in expected and str(expected["expectedConfigHash"]).lower() != config_hash.lower():
                raise BuildMismatchError("expectedConfigHash is not the factory's current configHash")
            expected = {**(expected or {}), "expectedConfigHash": config_hash}
        window = None if function_name in ("claimFees", "sweepToOwner") else (lo, hi)
        verify_built_tx(snap, chain_id=self._mf.network.chain_id, account=self.account, function_name=function_name,
                        exact=expected, at_least=least_c, deadline=window)
        # A decoded buy cannot be proven to stay off the graduation path, so it always gets the graduation gas floor.
        return await self._send(snap["data"], function_name == "buy", function_name)

    async def _gate(self, permission: str) -> Gate:
        """The registry's authorize() preamble against one pinned block: Paused first (the account owner's pause or the
        platform pause), then the agent, then the policy and headroom."""
        rpc = self._mf.rpc
        at, now = await rpc.latest_block()
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

