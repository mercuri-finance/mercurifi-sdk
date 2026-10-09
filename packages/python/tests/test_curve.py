import json
from pathlib import Path

import pytest

from mercurifi.curve import LaunchConfig, buy_impact_bps, is_sell_out_quote, may_graduate_buy, quote_fresh_buy, sell_impact_bps

V = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "curve.json").read_text())
C = LaunchConfig.from_abi({k: (int(v) if isinstance(v, str) else v) for k, v in V["config"].items()})


@pytest.mark.parametrize("case", V["freshBuy"])
def test_fresh_buy(case: dict[str, str]) -> None:
    assert quote_fresh_buy(C, int(case["valueWei"])) == (int(case["tokensOut"]), int(case["usdcUsed"]), int(case["fee"]))


@pytest.mark.parametrize("case", V["sellOut"])
def test_sell_out(case: dict[str, object]) -> None:
    got = is_sell_out_quote(int(str(case["usdcIn"])), int(str(case["usdcUsed"])), int(str(case["tokensOut"])), int(str(case["tokensRemaining"])))
    assert got is case["out"]


def test_may_graduate_also_when_taking_half_of_what_is_left() -> None:
    assert may_graduate_buy(100, 100, 5, 10) is True  # half of 10
    assert may_graduate_buy(100, 100, 4, 10) is False
    assert may_graduate_buy(100, 99, 1, 10) is True  # exact sell-out rule


def test_impact_roundings_mirror_agent_policy_lib() -> None:
    # avg = ceil(24.75e18 * 1e18 / 1e24) = 24.75e12; impact = ceil(14.75e12 * 1e4 / 1e13) = 14750
    assert buy_impact_bps(24_750_000_000_000_000_000, 10**24, 10**13) == 14_750
    assert buy_impact_bps(24_750_000_000_000_000_000, 10**24, 25_000_000_000_000) == 0
    # avg = floor(10e18 * 1e18 / 5e18) = 2e18; price 4e18 -> impact 5000
    assert sell_impact_bps(10 * 10**18, 5 * 10**18, 4 * 10**18) == 5_000
    assert sell_impact_bps(10 * 10**18, 5 * 10**18, 2 * 10**18) == 0
    assert sell_impact_bps(10 * 10**18 - 1, 5 * 10**18, 2 * 10**18) == 1
