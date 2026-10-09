"""Bonding-curve mirrors: the launch config, the graduation rule, the fresh-buy quote and AgentPolicyLib's impact roundings."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

PHASE_TRADING, PHASE_PENDING, PHASE_GRADUATED = 0, 1, 2
_BPS = 10_000
_WAD = 10**18


def _mul_div_up(a: int, b: int, d: int) -> int:
    return (a * b + d - 1) // d


@dataclass(frozen=True)
class LaunchConfig:
    """LaunchFactory.config() (LaunchTypes.sol). Native amounts are 18-decimal wei."""

    virtual_usdc: int
    virtual_tokens: int
    curve_supply: int
    pool_supply: int
    launch_fee: int
    max_initial_buy_tokens: int
    trade_fee_bps: int
    creator_share_bps: int
    referrer_share_bps: int
    snipe_start_bps: int
    snipe_blocks: int

    @classmethod
    def from_abi(cls, d: Mapping[str, Any]) -> LaunchConfig:
        return cls(
            int(d["virtualUsdc"]), int(d["virtualTokens"]), int(d["curveSupply"]), int(d["poolSupply"]), int(d["launchFee"]),
            int(d["maxInitialBuyTokens"]), int(d["tradeFeeBps"]), int(d["creatorShareBps"]), int(d["referrerShareBps"]),
            int(d["snipeStartBps"]), int(d["snipeBlocks"]),
        )


def is_sell_out_quote(usdc_in: int, usdc_used: int, tokens_out: int, tokens_remaining: int) -> bool:
    """True when a quoteBuy result is the buy that completes the curve (and so graduates inline). Same rule as the web app."""
    return usdc_used < usdc_in or tokens_out >= tokens_remaining


def may_graduate_buy(usdc_in: int, usdc_used: int, tokens_out: int, tokens_remaining: int) -> bool:
    """Whether a buy may complete the curve by the time it is included: the exact rule, or a buy taking half or more of
    what is left (other buys can land first, and a graduating buy that runs out of gas reverts the whole trade)."""
    return is_sell_out_quote(usdc_in, usdc_used, tokens_out, tokens_remaining) or tokens_out >= tokens_remaining // 2


def quote_fresh_buy(config: LaunchConfig, value_wei: int) -> tuple[int, int, int]:
    """BondingCurve._quoteBuy on a fresh curve with no tax (the launch's initial buy): (tokens_out, usdc_used, fee)."""
    fee_bps = config.trade_fee_bps
    fee = value_wei * fee_bps // _BPS
    net = value_wei - fee
    x, y, remaining = config.virtual_usdc, config.virtual_tokens, config.curve_supply
    used = value_wei
    tokens = net * y // (x + net)
    if tokens >= remaining:
        tokens = remaining
        cost = _mul_div_up(x, remaining, y - remaining)
        gross = _mul_div_up(cost, _BPS * _BPS, (_BPS - fee_bps) * _BPS)
        if gross < value_wei:
            used = gross
            fee = gross * fee_bps // _BPS
    return tokens, used, fee


def buy_impact_bps(net: int, tokens_out: int, price: int) -> int:
    """AgentPolicyLib.buyImpactBps: avg = ceil(net x 1e18 / tokens_out), impact ceil((avg - price) x 10,000 / price), 0 when avg <= price."""
    avg = _mul_div_up(net, _WAD, tokens_out)
    return _mul_div_up(avg - price, _BPS, price) if avg > price else 0


def sell_impact_bps(gross: int, tokens_in: int, price: int) -> int:
    """AgentPolicyLib.sellImpactBps: avg = floor(gross x 1e18 / tokens_in), impact ceil((price - avg) x 10,000 / price), 0 when avg >= price."""
    avg = gross * _WAD // tokens_in
    return _mul_div_up(price - avg, _BPS, price) if price > avg else 0
