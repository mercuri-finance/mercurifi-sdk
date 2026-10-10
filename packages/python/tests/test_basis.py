import json
from pathlib import Path
from typing import Any

import pytest

from mercurifi.basis import Basis, curve_sell_value6, pool_sell_value6, recorded_sell_value6

V = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "basis.json").read_text()
)


def basis_of(x: dict[str, Any]) -> Basis:
    return Basis(int(x["costUsdc"]), int(x["tokens"]), int(x["highWater"]))


@pytest.mark.parametrize("case", V["recorded"], ids=lambda c: c["name"])
def test_recorded(case: dict[str, Any]) -> None:
    assert recorded_sell_value6(basis_of(case), int(case["tokensIn"])) == (
        int(case["recorded"]),
        int(case["value6"]),
    )


@pytest.mark.parametrize("case", V["curveExcess"], ids=lambda c: c["name"])
def test_curve_excess(case: dict[str, Any]) -> None:
    assert curve_sell_value6(
        basis_of(case), int(case["tokensIn"]), int(case["excessOutWei"])
    ) == int(case["value6"])


@pytest.mark.parametrize("case", V["poolExcess"], ids=lambda c: c["name"])
def test_pool_excess(case: dict[str, Any]) -> None:
    assert pool_sell_value6(
        basis_of(case), int(case["amountIn"]), int(case["quotedOutWei"])
    ) == int(case["value6"])
