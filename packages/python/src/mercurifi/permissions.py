"""Agent key permission bits (spec 4.3)."""
from __future__ import annotations

from collections.abc import Iterable

from .errors import InvalidInputError

PERMISSIONS: dict[str, int] = {"buy": 1, "sell": 2, "launch": 4, "swap": 8, "claim": 16, "sweep": 32}
_ORDER: tuple[str, ...] = ("buy", "sell", "launch", "swap", "claim", "sweep")

#: `sell` is opt-in and never preselected (spec 4.3).
DEFAULT_AGENT_PERMISSIONS: tuple[str, ...] = ("buy", "launch", "swap", "claim")

SELL_RISK_WARNING = (
    "You are giving this agent key the sell permission. A stolen key with sell can dump the account holdings into a "
    "price an attacker pushed down; the loss is bounded by periodSellCap at cost basis per period, not prevented. "
    "Keep holdings small and sweep profits to the owner."
)

#: AgentAction.action ids (AgentTypes.sol).
ACTIONS: dict[int, str] = {1: "buy", 2: "sell", 3: "launch", 4: "poolBuy", 5: "poolSell", 6: "claim", 7: "sweep"}


def encode_permissions(perms: Iterable[str]) -> int:
    items = list(perms)
    if not items:
        raise InvalidInputError("permissions", "grant at least one permission")
    bits = 0
    for p in items:
        if not isinstance(p, str) or p not in PERMISSIONS:
            raise InvalidInputError("permissions", f"unknown permission {p!r}; expected one of {', '.join(_ORDER)}")
        bits |= PERMISSIONS[p]
    return bits


def decode_permissions(bits: int) -> list[str]:
    if isinstance(bits, bool) or not isinstance(bits, int) or not 0 <= bits <= 63:
        raise InvalidInputError("permissions", f"unknown permission bits in {bits!r}")
    return [p for p in _ORDER if bits & PERMISSIONS[p]]
