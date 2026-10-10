"""Decimal and basis-point helpers. Amounts are exact ints in base units; floats are never accepted for money."""

from __future__ import annotations

import math
import re
from decimal import Decimal
from typing import Literal

from .errors import InvalidInputError

USDC_DECIMALS = 6
TOKEN_DECIMALS = 18
#: Native USDC wei per usdc6 unit (18 - 6 decimals).
SCALE = 10**12
#: Largest accepted slippage fraction (exclusive).
MAX_SLIPPAGE = 0.5

_WS = " \t\n\r"
_MAX_TEXT = 80
_MAX_EXPONENT = 40
_DECIMAL = re.compile(r"(0|[1-9][0-9]*)(\.[0-9]+)?", re.ASCII)


def parse_decimal(
    value: object, decimals: int, field: str, base_unit_hint: str | None = None
) -> int:
    """Parse a plain non-negative ASCII decimal string into base units; numbers are refused.

    More fractional digits than `decimals` are an error even when the extra digits are zeros
    ("1.0000000" is rejected for USDC): the caller must state an exact amount, nothing is rounded or trimmed.
    """
    hint = base_unit_hint if base_unit_hint is not None else f"{field}6"
    if not isinstance(value, str):
        raise InvalidInputError(
            field,
            f'{field} must be a decimal string such as "25" or "0.5" (got {type(value).__name__}). '
            f"For base units use {hint} with an int.",
        )
    text = value.strip(
        _WS
    )  # ASCII whitespace only; Unicode spaces, \x1f, \x85 and U+FEFF are rejected
    if len(text) > _MAX_TEXT:
        raise InvalidInputError(field, f"{field} is too long")
    if _DECIMAL.fullmatch(text) is None:
        raise InvalidInputError(
            field, f'{field} must be a plain decimal string such as "25" or "0.5"'
        )
    whole, _, frac = text.partition(".")
    if len(frac) > decimals:
        raise InvalidInputError(field, f"{field} has more than {decimals} decimal places")
    result: int = int(whole) * 10**decimals + int(frac.ljust(decimals, "0") or "0")
    return result


def format_decimal(value: int, decimals: int) -> str:
    negative = value < 0
    base = 10**decimals
    whole, rem = divmod(abs(value), base)
    frac = str(rem).rjust(decimals, "0").rstrip("0")
    return f"{'-' if negative else ''}{whole}{'.' + frac if frac else ''}"


def parse_usdc(value: object, field: str = "usdc") -> int:
    return parse_decimal(value, USDC_DECIMALS, field)


def format_usdc6(v: int) -> str:
    return format_decimal(v, USDC_DECIMALS)


def parse_tokens(value: object, field: str = "amount") -> int:
    return parse_decimal(value, TOKEN_DECIMALS, field, "amount_wei")


def format_tokens(v: int) -> str:
    return format_decimal(v, TOKEN_DECIMALS)


def usdc6_to_wei(v: int) -> int:
    return v * SCALE


def wei_to_usdc6_floor(w: int) -> int:
    return w // SCALE


def wei_to_usdc6_ceil(w: int) -> int:
    return (w + SCALE - 1) // SCALE


def slippage_to_bps(s: object) -> int:
    """Slippage fraction (0.02 = 2%) to whole basis points; must be in [0, 0.5)."""
    if (
        isinstance(s, bool)
        or not isinstance(s, (int, float))
        or (
            isinstance(s, float) and not math.isfinite(s)
        )  # never float() an int: huge ints overflow
        or s < 0
        or s >= MAX_SLIPPAGE
    ):
        raise InvalidInputError(
            "slippage",
            "slippage is a fraction: 0.02 means 2%. It must be at least 0 and below 0.5.",
        )
    if s == 0:
        return 0  # normalises -0.0
    bps = round(s * 10_000)
    if abs(bps - s * 10_000) > 1e-6:
        raise InvalidInputError(
            "slippage", "slippage must be a whole number of basis points (steps of 0.0001)"
        )
    return int(bps)


def apply_slippage_floor(amount: int, bps: int) -> int:
    """Minimum acceptable output for a quote, rounded down."""
    if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
        raise InvalidInputError("amount", "amount must be a non-negative int of base units")
    if isinstance(bps, bool) or not isinstance(bps, int) or not 0 <= bps <= 10_000:
        raise InvalidInputError("slippage", "bps must be an integer from 0 to 10000")
    return amount * (10_000 - bps) // 10_000


def _human(value: str | Decimal) -> object:
    """A Decimal becomes its plain positional string; anything else is passed on to be rejected or parsed."""
    if isinstance(value, Decimal):
        exponent = value.as_tuple().exponent
        if not value.is_finite() or not isinstance(exponent, int) or abs(exponent) > _MAX_EXPONENT:
            return "NaN"  # rejected by parse_decimal; never expand a huge exponent
        return format(value, "f")
    return value


def resolve_usdc6(usdc: str | Decimal | None, usdc6: int | None, field: str = "usdc") -> int:
    """Exactly one of `usdc` (decimal string or Decimal) or `usdc6` (int base units)."""
    if (usdc is None) == (usdc6 is None):
        raise InvalidInputError(
            field, f"pass exactly one of {field} (decimal string) or {field}6 (int)"
        )
    if usdc6 is not None:
        if isinstance(usdc6, bool) or not isinstance(usdc6, int) or usdc6 < 0:
            raise InvalidInputError(
                f"{field}6", f"{field}6 must be an int of base units (1 USDC = 1000000)"
            )
        return usdc6
    assert usdc is not None
    return parse_usdc(_human(usdc), field)


def resolve_token_amount(
    amount: str | Decimal | None, amount_wei: int | None
) -> int | Literal["all"]:
    """Exactly one of `amount` (decimal string, Decimal or 'all') or `amount_wei` (int, 18 decimals)."""
    if (amount is None) == (amount_wei is None):
        raise InvalidInputError(
            "amount", "pass exactly one of amount (decimal string or 'all') or amount_wei (int)"
        )
    if amount_wei is not None:
        if isinstance(amount_wei, bool) or not isinstance(amount_wei, int) or amount_wei < 0:
            raise InvalidInputError(
                "amount_wei", "amount_wei must be an int of 18-decimal base units"
            )
        return amount_wei
    assert amount is not None
    return "all" if amount == "all" else parse_tokens(_human(amount), "amount")
