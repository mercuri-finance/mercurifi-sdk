"""Threat T15: decode API-built calldata and refuse anything that differs from what the caller asked for (TS api/verifyBuild.ts).

Verification is total and fails closed: every decoded argument (launch request fields flattened) must be covered by
`exact`, by `at_least` (minimum outputs only) or be `deadline` with a deadline window; an uncovered argument is refused by
name. The expectation must come from your own request, never from the build response or from the `args` this function
returns (that would only compare the answer with itself).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, TypeGuard

from .abi import AGENT_ACCOUNT
from .codec import AbiUnknownSelectorError
from .errors import BuildMismatchError, InvalidInputError, MercurifiError
from .redact import neutralize_untrusted, pre_bound, truncate_chars

AGENT_FUNCTIONS = ("buy", "sell", "launch", "swapExactIn", "claimFees", "sweepToOwner")

_HEX_ID = re.compile(r"0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})")  # addresses and bytes32 values compare case-insensitively
_MIN_OUT = re.compile(r"min[A-Za-z0-9]*Out")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_CALLDATA = re.compile(r"0x(?:[0-9a-fA-F]{2}){4,}")
_DECIMAL = re.compile(r"[0-9]{1,78}")
_SELECTOR_LEN = 10


def _is_int(v: object) -> TypeGuard[int]:
    return isinstance(v, int) and not isinstance(v, bool)


def _show(v: object) -> str:
    """A value for an error message: it may be attacker-chosen (a metadata URI), so sanitised and bounded."""
    text = v if isinstance(v, str) else repr(v)
    return truncate_chars(neutralize_untrusted(pre_bound(text, 80)), 80, "...")


def _same(got: object, want: object) -> bool:
    """Strict comparison; nothing is coerced. A numeric expectation is an int or a plain decimal string (else InvalidInputError)."""
    if isinstance(got, bool):
        return isinstance(want, bool) and got == want
    if isinstance(got, int):
        if _is_int(want):
            return got == want
        if isinstance(want, str) and _DECIMAL.fullmatch(want):
            return got == int(want)
        raise InvalidInputError("exact", "a numeric expectation must be an int or a decimal string")
    if isinstance(got, str) and isinstance(want, str):
        if _HEX_ID.fullmatch(got) and _HEX_ID.fullmatch(want):
            return got.lower() == want.lower()
        return got == want
    return False


def _entries(name: str, v: object) -> dict[str, Any] | None:
    if v is None:
        return None
    if not isinstance(v, Mapping):
        raise InvalidInputError(name, f"{name} must be a mapping")
    out: dict[str, Any] = {}
    for k, value in v.items():  # each value is read exactly once
        if type(k) is not str:
            raise InvalidInputError(name, f"{name} keys must be strings")
        out[k] = value
    return out


def snapshot_expectation(
    exact: Mapping[str, Any] | None, at_least: Mapping[str, int] | None, deadline: tuple[int, int] | None,
) -> tuple[dict[str, Any] | None, dict[str, int] | None, tuple[int, int] | None]:
    """Reads exact, at_least and deadline (and each value) once into plain copies, so a mapping with a lying
    __getitem__ cannot show one value to validation and another to comparison. Validates their shapes."""
    e = _entries("exact", exact)
    a = _entries("at_least", at_least)
    d: tuple[int, int] | None = None
    if deadline is not None:
        try:
            lo, hi = deadline
        except (TypeError, ValueError):
            raise InvalidInputError("deadline", "the deadline window must be a (min, max) pair of ints") from None
        if not _is_int(lo) or not _is_int(hi) or lo > hi:
            raise InvalidInputError("deadline", "the deadline window needs int min <= max")
        d = (lo, hi)
    if a is not None:
        for k, v in a.items():
            if _MIN_OUT.fullmatch(k) is None:
                raise InvalidInputError("at_least", f"at_least applies to minimum-output arguments only, not {_show(k)}")
            if not _is_int(v) or v < 0:
                raise InvalidInputError("at_least", f"at_least.{k} must be a non-negative int")
    return e, a, d


def snapshot_built(built: Mapping[str, Any]) -> dict[str, Any]:
    """The five fields verification and sending use, read once each, so the bytes verified are the bytes signed."""
    if not isinstance(built, Mapping):
        raise BuildMismatchError("the built transaction is not a mapping")
    return {k: built[k] for k in ("chainId", "to", "data", "value", "selector") if k in built}


def verify_built_tx(
    built: Mapping[str, Any], *, chain_id: int, account: str, function_name: str, exact: Mapping[str, Any] | None = None,
    at_least: Mapping[str, int] | None = None, deadline: tuple[int, int] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Checks: chain, target = own account, zero value, the server's selector (when sent) matching the calldata, an agent
    trade function of AgentAccount, strict (canonical, no trailing bytes) encoding and every argument covered by the
    expectation. Owner calls on AgentPolicyRegistry never decode against AgentAccount and are refused.

    exact: arguments that must equal these values (addresses and bytes32 compare case-insensitively; numbers are int or
    decimal strings). at_least: minimum-output arguments (min...Out) that must be at least these ints. deadline: the
    (min, max) window for the `deadline` argument; claimFees and sweepToOwner take none.
    """
    if type(function_name) is not str or function_name not in AGENT_FUNCTIONS:
        raise InvalidInputError("function_name", f"{_show(function_name)} is not an agent trade function")
    if not isinstance(account, str) or _ADDRESS.fullmatch(account) is None:
        raise InvalidInputError("account", "account is not an address")
    exact_c, least_c, window = snapshot_expectation(exact, at_least, deadline)
    exact_d = exact_c if exact_c is not None else {}
    least_d = least_c if least_c is not None else {}
    b = snapshot_built(built)
    if not _is_int(b.get("chainId")) or b["chainId"] != chain_id:
        raise BuildMismatchError(f"chain {_show(b.get('chainId'))} is not {chain_id}")
    to = b.get("to")
    if not isinstance(to, str) or _ADDRESS.fullmatch(to) is None or to.lower() != account.lower():
        raise BuildMismatchError(f"target is not your account {account}")
    value = b.get("value")
    if not isinstance(value, str) or _DECIMAL.fullmatch(value) is None or int(value) != 0:
        raise BuildMismatchError("agent calls never carry value")
    data = b.get("data")
    if not isinstance(data, str) or _CALLDATA.fullmatch(data) is None:
        raise BuildMismatchError("calldata is not hex")
    selector = b.get("selector")
    if "selector" in b and (not isinstance(selector, str) or selector.lower() != data[:_SELECTOR_LEN].lower()):
        raise BuildMismatchError(f"the server's selector {_show(selector)} does not match the calldata")
    try:
        name, args = AGENT_ACCOUNT.decode_input(data)  # strict: re-encodes and compares, so trailing or non-canonical bytes fail
    except AbiUnknownSelectorError:
        raise BuildMismatchError("calldata does not decode against AgentAccount (unknown selector)") from None
    except MercurifiError:
        raise BuildMismatchError("calldata has trailing or non-canonical bytes, or is malformed") from None
    if name not in AGENT_FUNCTIONS:
        raise BuildMismatchError(f"{name} is not an agent trade function")
    if name != function_name:
        raise BuildMismatchError(f"built {name}, asked for {function_name}")

    named: dict[str, Any] = {}
    for key, val in args.items():
        # launch(LaunchRequest): the 8 request fields, deadline last, become top-level names.
        if isinstance(val, dict):
            named.update(val)
        else:
            named[key] = val
    for arg in named:
        covered = arg in exact_d or (arg in least_d and _MIN_OUT.fullmatch(arg) is not None) or (arg == "deadline" and window is not None)
        if not covered:
            raise BuildMismatchError(f"{arg} of {name} is not covered by your expectation")
    for key, want in exact_d.items():
        if key not in named:
            raise BuildMismatchError(f"{name} has no argument {_show(key)}")
        if not _same(named[key], want):
            raise BuildMismatchError(f"{key} is {_show(named[key])}, asked for {_show(want)}")
    for key, minimum in least_d.items():
        got = named.get(key)
        if not _is_int(got):
            raise BuildMismatchError(f"{name} has no numeric argument {_show(key)}")
        if got < minimum:
            raise BuildMismatchError(f"{key} {got} is below your minimum {minimum}")
    if window is not None:
        got = named.get("deadline")
        if not _is_int(got):
            raise BuildMismatchError(f"{name} takes no deadline")
        if got < window[0] or got > window[1]:
            raise BuildMismatchError(f"deadline {got} is outside [{window[0]}, {window[1]}]")
    return name, named
