import json
from decimal import Decimal
from pathlib import Path

import pytest

from mercurifi.errors import InvalidInputError
from mercurifi.units import (
    apply_slippage_floor, format_usdc6, parse_tokens, parse_usdc, resolve_token_amount, resolve_usdc6,
    slippage_to_bps, wei_to_usdc6_ceil, wei_to_usdc6_floor,
)

V = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "units.json").read_text())


@pytest.mark.parametrize("case", V["parseUsdc"])
def test_parse_usdc(case: dict) -> None:
    if "error" in case:
        with pytest.raises(InvalidInputError) as e:
            parse_usdc(case["in"])
        assert e.value.code == case["error"]
    else:
        assert parse_usdc(case["in"]) == int(case["out"])


@pytest.mark.parametrize("case", V["parseTokens"])
def test_parse_tokens(case: dict) -> None:
    assert parse_tokens(case["in"]) == int(case["out"])


@pytest.mark.parametrize("case", V["formatUsdc6"])
def test_format_usdc6(case: dict) -> None:
    assert format_usdc6(int(case["in"])) == case["out"]


@pytest.mark.parametrize("case", V["slippageToBps"])
def test_slippage(case: dict) -> None:
    if "error" in case:
        with pytest.raises(InvalidInputError):
            slippage_to_bps(case["in"])
    else:
        assert slippage_to_bps(case["in"]) == case["out"]


@pytest.mark.parametrize("case", V["applySlippageFloor"])
def test_floor(case: dict) -> None:
    if "error" in case:
        with pytest.raises(InvalidInputError):
            apply_slippage_floor(int(case["amount"]), case["bps"])
    else:
        assert apply_slippage_floor(int(case["amount"]), case["bps"]) == int(case["out"])


@pytest.mark.parametrize("case", V["weiToUsdc6"])
def test_rounding(case: dict) -> None:
    assert wei_to_usdc6_floor(int(case["wei"])) == int(case["floor"])
    assert wei_to_usdc6_ceil(int(case["wei"])) == int(case["ceil"])


def test_rejects_int_and_float() -> None:  # Review Focus 1
    for bad in (25, 25.0, True):
        with pytest.raises(InvalidInputError, match="usdc6"):
            resolve_usdc6(bad, None)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError, match="usdc6 must be an int"):
        resolve_usdc6(None, 25.0)  # type: ignore[arg-type]


def test_amount_forms() -> None:
    assert resolve_usdc6(Decimal("2.5"), None) == 2_500_000
    assert resolve_usdc6(None, 7) == 7
    with pytest.raises(InvalidInputError, match="exactly one"):
        resolve_usdc6("1", 1)
    assert resolve_token_amount("all", None) == "all"
    assert resolve_token_amount("1", None) == 10**18
    assert resolve_token_amount(None, 5) == 5
    with pytest.raises(InvalidInputError):
        parse_usdc("１２")  # full-width digits are not ASCII decimals


@pytest.mark.parametrize(
    "bad", [".5", "1.", "0x10", "1E3", "+1", "1_0", "١٢", "NaN", "Infinity", "1\n2", "1 2", 25, 25.0, True, None, b"1"]
)
def test_parse_rejects(bad: object) -> None:
    with pytest.raises(InvalidInputError):
        parse_usdc(bad)


def test_hint_names_base_unit_field() -> None:
    with pytest.raises(InvalidInputError, match="amount_wei"):
        parse_tokens(5)
    with pytest.raises(InvalidInputError, match="usdc6"):
        parse_usdc(5)


def test_slippage_edges() -> None:
    assert slippage_to_bps(-0.0) == 0
    for bad in (True, float("nan"), float("inf"), None, "0.01"):
        with pytest.raises(InvalidInputError):
            slippage_to_bps(bad)
    for bad_bps in (-1, 10_001, True, 1.0):
        with pytest.raises(InvalidInputError):
            apply_slippage_floor(1000, bad_bps)  # type: ignore[arg-type]


def test_decimal_and_all() -> None:
    assert resolve_usdc6(Decimal("1E+3"), None) == 1_000_000_000
    with pytest.raises(InvalidInputError):
        resolve_usdc6(Decimal("NaN"), None)
    with pytest.raises(InvalidInputError):
        resolve_usdc6(Decimal("-1"), None)
    with pytest.raises(InvalidInputError):
        resolve_token_amount(None, True)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError):
        resolve_token_amount(None, None)
