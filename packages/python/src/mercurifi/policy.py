"""On-chain agent policy (spec 4.5) with a local mirror of the contract's validation (AgentPolicyLib)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Literal

from .errors import InvalidInputError
from .units import format_usdc6, parse_usdc


@dataclass(frozen=True)
class ChainPolicy:
    """On-chain `Policy`. USDC fields are usdc6 ints."""

    max_trade_usdc: int
    period_spend_cap: int
    per_token_period_cap: int
    period_sell_cap: int
    max_actions_per_period: int
    launches_per_period: int
    max_price_impact_bps: int
    max_snipe_bps: int
    min_token_age_blocks: int
    max_deadline_seconds: int
    allowlist_only: bool

    def to_abi(self) -> dict[str, object]:
        return {ABI_NAMES[f]: getattr(self, f) for f in POLICY_FIELDS}

    @classmethod
    def from_abi(cls, d: Mapping[str, object]) -> ChainPolicy:
        values: dict[str, object] = {}
        for snake, camel in ABI_NAMES.items():
            if camel not in d:
                raise InvalidInputError(f"policy.{snake}", f"missing ABI field {camel}")
            raw = d[camel]
            values[snake] = raw if snake == "allowlist_only" else _as_int(snake, raw)
        return cls(**values)  # type: ignore[arg-type]


def _as_int(name: str, raw: object) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise InvalidInputError(f"policy.{name}", f"policy.{name} must be an int")
    return raw


#: Struct order of `Policy`; also the index order a `BetaCeiling(uint8)` refers to.
POLICY_FIELDS: tuple[str, ...] = (
    "max_trade_usdc",
    "period_spend_cap",
    "per_token_period_cap",
    "period_sell_cap",
    "max_actions_per_period",
    "launches_per_period",
    "max_price_impact_bps",
    "max_snipe_bps",
    "min_token_age_blocks",
    "max_deadline_seconds",
    "allowlist_only",
)
ABI_NAMES: dict[str, str] = {
    "max_trade_usdc": "maxTradeUsdc",
    "period_spend_cap": "periodSpendCap",
    "per_token_period_cap": "perTokenPeriodCap",
    "period_sell_cap": "periodSellCap",
    "max_actions_per_period": "maxActionsPerPeriod",
    "launches_per_period": "launchesPerPeriod",
    "max_price_impact_bps": "maxPriceImpactBps",
    "max_snipe_bps": "maxSnipeBps",
    "min_token_age_blocks": "minTokenAgeBlocks",
    "max_deadline_seconds": "maxDeadlineSeconds",
    "allowlist_only": "allowlistOnly",
}

_USDC_FIELDS = frozenset(
    {"max_trade_usdc", "period_spend_cap", "per_token_period_cap", "period_sell_cap"}
)
_INT_LIMITS: dict[str, int] = {
    "max_actions_per_period": 0xFFFF_FFFF,
    "launches_per_period": 0xFFFF,
    "max_price_impact_bps": 0xFFFF,
    "max_snipe_bps": 0xFFFF,
    "min_token_age_blocks": 0xFFFF_FFFF,
    "max_deadline_seconds": 0xFFFF_FFFF,
}
_UINT64_MAX = 2**64 - 1

DEFAULT_POLICY = ChainPolicy(
    100_000_000, 500_000_000, 100_000_000, 500_000_000, 500, 3, 300, 0, 0, 120, False
)
DEFAULT_PERIOD_SECONDS = 86_400
MIN_PERIOD_SECONDS = 3_600
MAX_PERIOD_SECONDS = 604_800
DEFAULT_INCREASE_DELAY = 3_600
MAX_INCREASE_DELAY = 604_800
MAX_AGENTS = 8
DEFAULT_AGENT_DAYS = 30
MAX_AGENT_DAYS = 180
MAX_DEADLINE_SECONDS = 600
QUEUE_TTL_SECONDS = 604_800


def _check_range(field_name: str, value: object) -> None:
    """Checks one field against its Solidity width (uint64 / uint32 / uint16 / bool)."""
    name = f"policy.{field_name}"
    if field_name in _USDC_FIELDS:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _UINT64_MAX:
            raise InvalidInputError(name, f"{name} must be an int in 0..{_UINT64_MAX} (usdc6)")
    elif field_name == "allowlist_only":
        if not isinstance(value, bool):
            raise InvalidInputError(name, f"{name} must be a bool")
    else:
        limit = _INT_LIMITS[field_name]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= limit:
            raise InvalidInputError(name, f"{name} must be an integer in 0..{limit}")


def merge_policy(base: ChainPolicy, changes: Mapping[str, object]) -> ChainPolicy:
    """Applies human input over a base policy, checking types and integer ranges. None values keep the base."""
    if not isinstance(changes, Mapping):
        raise InvalidInputError("policy", "policy must be a mapping of policy fields")
    updates: dict[str, object] = {}
    for key, raw in changes.items():
        if raw is None:
            continue
        if key not in POLICY_FIELDS:
            raise InvalidInputError(f"policy.{key}", f"unknown policy field {key}")
        if key in _USDC_FIELDS:
            v = parse_usdc(raw, f"policy.{key}")
            _check_range(key, v)
            updates[key] = v
        else:
            _check_range(key, raw)
            updates[key] = raw
    return replace(base, **updates)  # type: ignore[arg-type]


def _show(field_name: str, value: object) -> str:
    if field_name in _USDC_FIELDS:
        return format_usdc6(int(value))  # type: ignore[call-overload]
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def validate_policy(p: ChainPolicy, ceilings: ChainPolicy | None = None) -> None:
    """Mirror of AgentPolicyLib.checkShape plus the factory ceilings. The contract stays authoritative."""
    for f in POLICY_FIELDS:
        _check_range(f, getattr(p, f))
    # Same order as AgentPolicyLib.checkShape: impact, snipe, deadline.
    if p.max_price_impact_bps > 10_000:
        raise InvalidInputError(
            "policy.max_price_impact_bps", "policy.max_price_impact_bps must be at most 10000"
        )
    if p.max_snipe_bps > 10_000:
        raise InvalidInputError(
            "policy.max_snipe_bps", "policy.max_snipe_bps must be at most 10000"
        )
    if not 1 <= p.max_deadline_seconds <= MAX_DEADLINE_SECONDS:
        raise InvalidInputError(
            "policy.max_deadline_seconds",
            f"policy.max_deadline_seconds must be in 1..{MAX_DEADLINE_SECONDS}",
        )
    if ceilings is None:
        return
    for f in POLICY_FIELDS:
        if f == "allowlist_only":
            continue
        value, limit = getattr(p, f), getattr(ceilings, f)
        # min_token_age_blocks is a floor on-chain (AgentPolicyLib.checkCeilings); every other ceiling is an upper bound.
        if f == "min_token_age_blocks":
            if value < limit:
                raise InvalidInputError(
                    f"policy.{f}",
                    f"policy.{f} = {_show(f, value)} is below the beta floor of {_show(f, limit)}",
                )
        elif value > limit:
            raise InvalidInputError(
                f"policy.{f}",
                f"policy.{f} = {_show(f, value)} is above the beta ceiling of {_show(f, limit)}",
            )


def field_direction(
    field: str, current: ChainPolicy, next_: ChainPolicy
) -> Literal["same", "narrow", "widen"]:
    """Per-field direction, identical to AgentPolicyLib.isNarrowing (spec 4.4)."""
    if field not in POLICY_FIELDS:
        raise InvalidInputError(f"policy.{field}", f"unknown policy field {field}")
    a, b = getattr(current, field), getattr(next_, field)
    if a == b:
        return "same"
    if field == "allowlist_only":
        return "narrow" if b else "widen"
    if field == "min_token_age_blocks":
        return "narrow" if b > a else "widen"
    return "narrow" if b < a else "widen"


@dataclass(frozen=True)
class PolicyChange:
    field: str
    current: str
    next: str
    direction: Literal["narrow", "widen"]


@dataclass(frozen=True)
class PolicyPreview:
    changes: tuple[PolicyChange, ...]
    immediate: tuple[str, ...]
    queued: tuple[str, ...]
    outcome: Literal["none", "immediate", "queued", "mixed"]
    #: The policy in force right after the transaction: narrowed fields applied, widened ones not yet.
    immediate_policy: ChainPolicy
    #: The full requested policy, which the queued item applies after the delay.
    target: ChainPolicy


def preview_policy_change(current: ChainPolicy, next_: ChainPolicy) -> PolicyPreview:
    changes: list[PolicyChange] = []
    immediate: list[str] = []
    queued: list[str] = []
    applied: dict[str, object] = {}
    for f in POLICY_FIELDS:
        d = field_direction(f, current, next_)
        if d == "same":
            continue
        changes.append(
            PolicyChange(f, _show(f, getattr(current, f)), _show(f, getattr(next_, f)), d)
        )
        if d == "narrow":
            immediate.append(f)
            applied[f] = getattr(next_, f)
        else:
            queued.append(f)
    outcome: Literal["none", "immediate", "queued", "mixed"] = (
        "none"
        if not changes
        else "immediate"
        if not queued
        else "queued"
        if not immediate
        else "mixed"
    )
    preview = replace(current, **applied)  # type: ignore[arg-type]
    return PolicyPreview(tuple(changes), tuple(immediate), tuple(queued), outcome, preview, next_)
