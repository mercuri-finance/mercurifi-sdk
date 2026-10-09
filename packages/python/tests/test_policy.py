import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from mercurifi.errors import InvalidInputError
from mercurifi.permissions import DEFAULT_AGENT_PERMISSIONS, decode_permissions, encode_permissions
from mercurifi.policy import (
    ABI_NAMES, DEFAULT_POLICY, ChainPolicy, field_direction, merge_policy, preview_policy_change, validate_policy,
)

V = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "policy.json").read_text())
SNAKE = {camel: snake for snake, camel in ABI_NAMES.items()}
CEILINGS = ChainPolicy(1_000_000_000, 10_000_000_000, 2_000_000_000, 10_000_000_000, 5_000, 20, 2_000, 9_900, 0, 600, False)


def test_defaults_match_spec() -> None:
    assert DEFAULT_POLICY.to_abi() == {
        "maxTradeUsdc": 100_000_000, "periodSpendCap": 500_000_000, "perTokenPeriodCap": 100_000_000, "periodSellCap": 500_000_000,
        "maxActionsPerPeriod": 500, "launchesPerPeriod": 3, "maxPriceImpactBps": 300, "maxSnipeBps": 0,
        "minTokenAgeBlocks": 0, "maxDeadlineSeconds": 120, "allowlistOnly": False,
    }


@pytest.mark.parametrize("case", V["direction"])
def test_direction(case: dict[str, Any]) -> None:
    field = SNAKE[case["field"]]
    conv = (lambda x: int(x)) if isinstance(getattr(DEFAULT_POLICY, field), int) and not isinstance(getattr(DEFAULT_POLICY, field), bool) else (lambda x: x)
    patch_current: dict[str, Any] = {field: conv(case["current"])}
    patch_next: dict[str, Any] = {field: conv(case["next"])}
    current = replace(DEFAULT_POLICY, **patch_current)
    nxt = replace(DEFAULT_POLICY, **patch_next)
    assert field_direction(field, current, nxt) == case["out"]


def test_merge_and_ceilings() -> None:
    p = merge_policy(DEFAULT_POLICY, {"max_trade_usdc": "250", "max_deadline_seconds": 60})
    assert p.max_trade_usdc == 250_000_000
    validate_policy(p, CEILINGS)
    with pytest.raises(InvalidInputError, match="max_trade_usdc.*beta ceiling"):
        validate_policy(merge_policy(DEFAULT_POLICY, {"max_trade_usdc": "1000.000001"}), CEILINGS)
    with pytest.raises(InvalidInputError, match="launches_per_period"):
        merge_policy(DEFAULT_POLICY, {"launches_per_period": 1.5})
    with pytest.raises(InvalidInputError, match="max_deadline_seconds"):
        validate_policy(replace(DEFAULT_POLICY, max_deadline_seconds=0))


def test_preview_mixed() -> None:
    pv = preview_policy_change(DEFAULT_POLICY, replace(DEFAULT_POLICY, max_trade_usdc=50_000_000, period_spend_cap=900_000_000))
    assert (pv.outcome, pv.immediate, pv.queued) == ("mixed", ("max_trade_usdc",), ("period_spend_cap",))
    assert pv.immediate_policy.period_spend_cap == 500_000_000
    assert [c for c in pv.changes if c.field == "period_spend_cap"][0].next == "900"


def test_permissions() -> None:
    assert "sell" not in DEFAULT_AGENT_PERMISSIONS
    assert encode_permissions(DEFAULT_AGENT_PERMISSIONS) == 29
    assert decode_permissions(63) == ["buy", "sell", "launch", "swap", "claim", "sweep"]
    with pytest.raises(InvalidInputError):
        encode_permissions([])


def test_ceiling_floor_for_min_token_age() -> None:
    ceil = replace(CEILINGS, min_token_age_blocks=10)
    with pytest.raises(InvalidInputError, match="below the beta floor"):
        validate_policy(replace(DEFAULT_POLICY, min_token_age_blocks=5), ceil)
    validate_policy(replace(DEFAULT_POLICY, min_token_age_blocks=10), ceil)
    validate_policy(replace(DEFAULT_POLICY, min_token_age_blocks=50), ceil)
    validate_policy(replace(DEFAULT_POLICY, min_token_age_blocks=10, allowlist_only=True), replace(ceil, allowlist_only=False))


def test_shared_ranges_and_order() -> None:
    for kw in ({"launches_per_period": 0x1_0000}, {"max_actions_per_period": 2**32}, {"max_trade_usdc": 2**64}, {"allowlist_only": 1}):
        with pytest.raises(InvalidInputError):
            validate_policy(replace(DEFAULT_POLICY, **kw))  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError, match="max_price_impact_bps"):
        validate_policy(replace(DEFAULT_POLICY, max_price_impact_bps=10_001, max_snipe_bps=10_001, max_deadline_seconds=0))
    with pytest.raises(InvalidInputError, match="max_snipe_bps"):
        validate_policy(replace(DEFAULT_POLICY, max_snipe_bps=10_001, max_deadline_seconds=0))
    with pytest.raises(InvalidInputError):
        merge_policy(DEFAULT_POLICY, {"max_trade_usdc": "18446744073709.551616"})
    assert merge_policy(DEFAULT_POLICY, {"max_trade_usdc": "18446744073709.551615"}).max_trade_usdc == 2**64 - 1
    for bad in (True, 1.0, 2**32):
        with pytest.raises(InvalidInputError):
            merge_policy(DEFAULT_POLICY, {"max_actions_per_period": bad})
    with pytest.raises(InvalidInputError):
        merge_policy(DEFAULT_POLICY, {"nope": 1})


@pytest.mark.parametrize("bad", [None, [], "x", 5])
def test_merge_non_mapping(bad: object) -> None:
    with pytest.raises(InvalidInputError, match="policy"):
        merge_policy(DEFAULT_POLICY, bad)  # type: ignore[arg-type]


def test_abi_roundtrip_and_none_skipped() -> None:
    assert ChainPolicy.from_abi(DEFAULT_POLICY.to_abi()) == DEFAULT_POLICY
    assert merge_policy(DEFAULT_POLICY, {"max_trade_usdc": None}) == DEFAULT_POLICY


@pytest.mark.parametrize("bad", ["__class__", "toString", "constructor", "SELL", 1, None, True])
def test_encode_rejects_unknown(bad: object) -> None:
    with pytest.raises(InvalidInputError):
        encode_permissions([bad])  # type: ignore[list-item]


@pytest.mark.parametrize("case", V["permissionsDecode"])
def test_decode_vectors(case: dict[str, Any]) -> None:
    if "error" in case:
        with pytest.raises(InvalidInputError):
            decode_permissions(case["in"])
    else:
        assert decode_permissions(case["in"]) == case["out"]


def test_decode_rejects_bool_and_float() -> None:
    for bad in (True, 2.0, "1", None):
        with pytest.raises(InvalidInputError):
            decode_permissions(bad)  # type: ignore[arg-type]


def test_preview_sequences_are_tuples() -> None:
    pv = preview_policy_change(DEFAULT_POLICY, replace(DEFAULT_POLICY, max_trade_usdc=1))
    assert isinstance(pv.changes, tuple) and isinstance(pv.immediate, tuple) and isinstance(pv.queued, tuple)
