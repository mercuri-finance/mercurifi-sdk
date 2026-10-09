"""The account's cost basis and its sell valuation, mirroring AgentAccount._recordedValue (TS basis.ts)."""
from __future__ import annotations

from dataclasses import dataclass

from .reads import read_account
from .rpc import Rpc
from .units import SCALE

HIGH_WATER_SCALE = 10**36
"""Scale of `Basis.high_water`: usdc6 per token unit x 1e36 (AgentTypes.sol HIGH_WATER_SCALE)."""


@dataclass(frozen=True)
class Basis:
    cost_usdc6: int
    """USDC paid for `tokens`, usdc6."""
    tokens: int
    """Tokens bought and still held, 18-decimal units."""
    high_water: int
    """Highest average cost the open position has had, usdc6 per token unit x 1e36 (stored rounded up); 0 once closed."""


def _ceil_div(a: int, b: int) -> int:
    return (a + b - 1) // b


async def read_basis(rpc: Rpc, account: str, token: str, *, at: int | None = None) -> Basis:
    cost, tokens, high_water = await read_account(rpc, account, "basis", token, at=at)
    return Basis(int(cost), int(tokens), int(high_water))


def recorded_sell_value6(b: Basis, tokens_in: int) -> tuple[int, int]:
    """(recorded, value6): the recorded part at the higher of the average cost rounded up and the high-water cost rounded
    down, so a crash buy cannot stretch the sell cap and a lot sold whole is charged exactly what it cost."""
    recorded = min(tokens_in, b.tokens)
    if recorded <= 0:
        return 0, 0
    average = _ceil_div(recorded * b.cost_usdc6, b.tokens)
    high_water = recorded * b.high_water // HIGH_WATER_SCALE
    return recorded, max(average, high_water)


def curve_sell_value6(b: Basis, tokens_in: int, excess_out_wei: int) -> int:
    """A curve sell's value: the recorded part plus the unrecorded excess at its curve quote, rounded up to usdc6."""
    return recorded_sell_value6(b, tokens_in)[1] + _ceil_div(excess_out_wei, SCALE)


def pool_sell_value6(b: Basis, amount_in: int, quoted_out_wei: int) -> int:
    """A pool sell's value, as AgentAccount.swapExactIn: the recorded part plus ceil(ceil(proceeds_wei x excess / amount_in) / 1e12).
    `quoted_out_wei` is the proceeds in native wei (a usdc6 quote times 1e12); the contract uses the proceeds it measures,
    so a quote makes this advisory."""
    recorded, value6 = recorded_sell_value6(b, amount_in)
    if amount_in <= recorded:
        return value6
    return value6 + _ceil_div(_ceil_div(quoted_out_wei * (amount_in - recorded), amount_in), SCALE)
