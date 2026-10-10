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

from .abi import AGENT_ACCOUNT, AGENT_POLICY_REGISTRY
from .codec import AbiUnknownSelectorError
from .errors import BuildMismatchError, InvalidInputError, MercurifiError
from .permissions import encode_permissions
from .redact import neutralize_untrusted, pre_bound, truncate_chars

AGENT_FUNCTIONS = ("buy", "sell", "launch", "swapExactIn", "claimFees", "sweepToOwner")

_HEX_ID = re.compile(
    r"0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
)  # addresses and bytes32 values compare case-insensitively
_MIN_OUT = re.compile(r"min[A-Za-z0-9]*Out")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_CALLDATA = re.compile(r"0x(?:[0-9a-fA-F]{2}){4,}")
_DECIMAL = re.compile(r"[0-9]{1,78}")
_SELECTOR_LEN = 10


def _is_int(v: object) -> TypeGuard[int]:
    return type(v) is int  # exactly int: not bool, and not a subclass that overrides comparison


_MAX_SAFE = 2**53 - 1


def is_chain_id(v: object) -> TypeGuard[int]:
    """A chain id: a positive int within JavaScript's safe range (as the TypeScript SDK requires)."""
    return _is_int(v) and 0 < v <= _MAX_SAFE


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
        if type(want) is str and _DECIMAL.fullmatch(want):
            return got == int(want)
        raise InvalidInputError("exact", "a numeric expectation must be an int or a decimal string")
    if type(got) is str and type(want) is str:
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
    exact: Mapping[str, Any] | None,
    at_least: Mapping[str, int] | None,
    deadline: tuple[int, int] | None,
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
            raise InvalidInputError(
                "deadline", "the deadline window must be a (min, max) pair of ints"
            ) from None
        if not _is_int(lo) or not _is_int(hi) or lo > hi:
            raise InvalidInputError("deadline", "the deadline window needs int min <= max")
        d = (lo, hi)
    if a is not None:
        for k, v in a.items():
            if _MIN_OUT.fullmatch(k) is None:
                raise InvalidInputError(
                    "at_least", f"at_least applies to minimum-output arguments only, not {_show(k)}"
                )
            if not _is_int(v) or v < 0:
                raise InvalidInputError("at_least", f"at_least.{k} must be a non-negative int")
    return e, a, d


def snapshot_built(built: Mapping[str, Any]) -> dict[str, Any]:
    """The fields verification and sending use, read once each, so the bytes verified are the bytes signed."""
    if not isinstance(built, Mapping):
        raise BuildMismatchError("the built transaction is not a mapping")
    snap = {
        k: built[k]
        for k in ("chainId", "to", "data", "value", "selector", "function")
        if k in built
    }
    for k in ("to", "data", "value", "selector", "function"):
        # Exactly str: a subclass could answer differently each time it is read, compared or converted.
        if k in snap and type(snap[k]) is not str:
            raise BuildMismatchError(f"{k} is a {type(snap[k]).__name__}, not a string")
    if "chainId" in snap and type(snap["chainId"]) is not int:
        raise BuildMismatchError(f"chainId is a {type(snap['chainId']).__name__}, not an integer")
    return snap


def _check_chain(b: Mapping[str, Any], chain_id: int) -> None:
    got = b.get("chainId")
    if not is_chain_id(got):
        raise BuildMismatchError(f"chainId {_show(got)} is not a positive safe integer")
    if got != chain_id:
        raise BuildMismatchError(f"chain {got} is not {chain_id}")


def _check_server_function(b: Mapping[str, Any], name: str) -> None:
    if "function" in b and b["function"] != name:
        raise BuildMismatchError(
            f"the server's function {_show(b['function'])} does not match the calldata"
        )


def verify_built_tx(
    built: Mapping[str, Any],
    *,
    chain_id: int,
    account: str,
    function_name: str,
    exact: Mapping[str, Any] | None = None,
    at_least: Mapping[str, int] | None = None,
    deadline: tuple[int, int] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Checks: chain, target = own account, zero value, the server's selector (when sent) matching the calldata, an agent
    trade function of AgentAccount, strict (canonical, no trailing bytes) encoding and every argument covered by the
    expectation. Owner calls on AgentPolicyRegistry never decode against AgentAccount and are refused.

    exact: arguments that must equal these values (addresses and bytes32 compare case-insensitively; numbers are int or
    decimal strings). at_least: minimum-output arguments (min...Out) that must be at least these ints. deadline: the
    (min, max) window for the `deadline` argument; claimFees and sweepToOwner take none.
    """
    if not is_chain_id(chain_id):
        raise InvalidInputError("chain_id", "chain_id must be a positive safe integer")
    if type(function_name) is not str or function_name not in AGENT_FUNCTIONS:
        raise InvalidInputError(
            "function_name", f"{_show(function_name)} is not an agent trade function"
        )
    if not isinstance(account, str) or _ADDRESS.fullmatch(account) is None:
        raise InvalidInputError("account", "account is not an address")
    exact_c, least_c, window = snapshot_expectation(exact, at_least, deadline)
    exact_d = exact_c if exact_c is not None else {}
    least_d = least_c if least_c is not None else {}
    b = snapshot_built(built)
    _check_chain(b, chain_id)
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
    if "selector" in b and (
        not isinstance(selector, str) or selector.lower() != data[:_SELECTOR_LEN].lower()
    ):
        raise BuildMismatchError(
            f"the server's selector {_show(selector)} does not match the calldata"
        )
    try:
        name, args = AGENT_ACCOUNT.decode_input(
            data
        )  # strict: re-encodes and compares, so trailing or non-canonical bytes fail
    except AbiUnknownSelectorError:
        raise BuildMismatchError(
            "calldata does not decode against AgentAccount (unknown selector)"
        ) from None
    except MercurifiError:
        raise BuildMismatchError(
            "calldata has trailing or non-canonical bytes, or is malformed"
        ) from None
    if name not in AGENT_FUNCTIONS:
        raise BuildMismatchError(f"{name} is not an agent trade function")
    if name != function_name:
        raise BuildMismatchError(f"built {name}, asked for {function_name}")
    _check_server_function(b, name)

    named: dict[str, Any] = {}
    for key, val in args.items():
        # launch(LaunchRequest): the 8 request fields, deadline last, become top-level names.
        if isinstance(val, dict):
            named.update(val)
        else:
            named[key] = val
    for arg in named:
        covered = (
            arg in exact_d
            or (arg in least_d and _MIN_OUT.fullmatch(arg) is not None)
            or (arg == "deadline" and window is not None)
        )
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


# Owner, pending-owner and permissionless functions POST /v1/tx/build encodes (TS api/verifyOwnerBuild.ts). withdraw and
# withdrawMany go to the account; every other one goes to the AgentPolicyRegistry paired with the account's factory,
# with the account first. Argument names are the API's (server) names, in contract order after the leading account;
# the contract's own names differ for a few (a, oldA, newA, d, p) and are mapped by position, never by name.
OWNER_FUNCTIONS: dict[str, tuple[bool, tuple[str, ...]]] = {
    "withdraw": (False, ("token", "amount")),
    "withdrawMany": (False, ("tokens",)),
    "addAgent": (True, ("agent", "expiresAt", "permissions")),
    "setAgent": (True, ("agent", "expiresAt", "permissions")),
    "revokeAgent": (True, ("agent",)),
    "rotateAgent": (True, ("oldAgent", "newAgent", "expiresAt", "permissions")),
    "setPolicy": (True, ("policy",)),
    "setTokenAllowed": (True, ("token", "allowed")),
    "setIncreaseDelay": (True, ("delay",)),
    "transferOwnership": (True, ("newOwner",)),
    "acceptOwnership": (True, ("id",)),
    "executeQueued": (True, ("id",)),
    "cancelQueued": (True, ("id",)),
    "pauseAgents": (True, ("paused",)),
}
_UINT = re.compile(r"uint[0-9]+")


def _snapshot_deep(v: object, depth: int = 0) -> object:
    """Copies exact (and nested lists and mappings) once, so a lying mapping cannot show validation one value and
    comparison another."""
    if depth > 2:
        raise InvalidInputError("exact", "exact is nested too deeply")
    if isinstance(v, Mapping):
        out: dict[str, object] = {}
        for k, x in v.items():
            if type(k) is not str:
                raise InvalidInputError("exact", "exact keys must be strings")
            out[k] = _snapshot_deep(x, depth + 1)
        return out
    if isinstance(v, (list, tuple)):
        return [_snapshot_deep(x, depth + 1) for x in v]
    return v


def _want_int(path: str, want: object) -> int:
    if _is_int(want) and want >= 0:
        return want
    if type(want) is str and _DECIMAL.fullmatch(want):
        return int(want)
    raise InvalidInputError("exact", f"{path} must be a non-negative int or decimal string")


def _want_addr(path: str, want: object) -> str:
    if type(want) is not str or _ADDRESS.fullmatch(want) is None:
        raise InvalidInputError("exact", f"{path} must be an address")
    return want.lower()


def _show_owner(v: object) -> str:
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_show_owner(x) for x in v) + "]"
    if isinstance(v, Mapping):
        return "an object"
    if isinstance(v, bool):
        return "true" if v else "false"
    return _show(v)


def _owner_mismatch(fn: str, path: str, got: object, want: object) -> BuildMismatchError:
    return BuildMismatchError(
        f"{path} of {fn} is {_show_owner(got)}, asked for {_show_owner(want)}"
    )


def _compare(fn: str, path: str, param: Mapping[str, Any], got: object, want: object) -> None:
    """Compares one decoded argument with its expectation by the ABI type; any type it does not know is refused."""
    t = param.get("type")
    if t == "address":
        if type(got) is not str or got.lower() != _want_addr(path, want):
            raise _owner_mismatch(fn, path, got, want)
        return
    if t == "address[]":
        if not isinstance(want, list):
            raise InvalidInputError("exact", f"{path} must be a list of addresses")
        w = [_want_addr(f"{path}[{i}]", x) for i, x in enumerate(want)]
        if (
            not isinstance(got, (list, tuple))
            or len(got) != len(w)
            or any(type(g) is not str or g.lower() != x for g, x in zip(got, w, strict=True))
        ):
            raise _owner_mismatch(fn, path, got, want)
        return
    if t == "bool":
        if type(want) is not bool:
            raise InvalidInputError("exact", f"{path} must be a bool")
        if type(got) is not bool or got is not want:
            raise _owner_mismatch(fn, path, got, want)
        return
    if isinstance(t, str) and _UINT.fullmatch(t):
        num = (
            encode_permissions(want)
            if path == "permissions" and isinstance(want, list)
            else _want_int(path, want)
        )
        if not _is_int(got) or got != num:
            raise _owner_mismatch(fn, path, got, want)
        return
    if t == "tuple":
        if not isinstance(want, dict):
            raise InvalidInputError("exact", f"{path} must be a mapping with every field")
        if not isinstance(got, dict):
            raise BuildMismatchError(f"{path} of {fn} did not decode as a struct")
        components = param.get("components", [])
        names = [c.get("name", "") for c in components]
        for n in names:
            if n not in want:
                raise BuildMismatchError(f"{path}.{n} of {fn} is not covered by your expectation")
        for k in want:
            if k not in names:
                raise BuildMismatchError(f"{fn} has no argument {path}.{_show(k)}")
        for c in components:
            n = c.get("name", "")
            _compare(fn, f"{path}.{n}", c, got.get(n), want[n])
        return
    raise BuildMismatchError(
        f"{path} of {fn} has type {_show(t)}, which this verifier does not check"
    )


def verify_built_owner_tx(
    built: Mapping[str, Any],
    *,
    chain_id: int,
    account: str,
    function_name: str,
    exact: Mapping[str, Any],
    registry: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """Decodes owner or registry calldata the API built (POST /v1/tx/build) and checks it against what you asked for,
    before anything is signed. It mirrors verify_built_tx for agent calls and fails closed: the function
    must be one of OWNER_FUNCTIONS; the target must be your account (withdraw, withdrawMany) or `registry` (every other
    function: the network book's agentRegistry, also factory.registry()), whose first argument must be your account;
    value 0; your chain; the server's selector (when sent) matching the calldata; strict encoding with no trailing bytes;
    and every argument covered by `exact`, with no argument left over on either side.

    exact uses the API's argument names (agent, oldAgent, newAgent, delay, policy, ...). Addresses compare
    case-insensitively; numbers are int or decimal strings; permissions may also be a list of permission names; policy
    is a mapping with every Policy field; tokens is the exact ordered list. The expectation must come from your own
    request, never from the build response or from the args this returns.
    """
    if not is_chain_id(chain_id):
        raise InvalidInputError("chain_id", "chain_id must be a positive safe integer")
    if type(function_name) is not str or function_name not in OWNER_FUNCTIONS:
        raise InvalidInputError("function_name", f"{_show(function_name)} is not an owner function")
    on_registry, arg_names = OWNER_FUNCTIONS[function_name]
    if not isinstance(account, str) or _ADDRESS.fullmatch(account) is None:
        raise InvalidInputError("account", "account is not an address")
    if on_registry and (not isinstance(registry, str) or _ADDRESS.fullmatch(registry) is None):
        raise InvalidInputError(
            "registry",
            f"{function_name} goes to the AgentPolicyRegistry: pass its address (the network book's agentRegistry)",
        )
    exact_c = _snapshot_deep(exact)
    if not isinstance(exact_c, dict):
        raise InvalidInputError("exact", "exact must be a mapping with every argument")
    b = snapshot_built(built)
    _check_chain(b, chain_id)
    target = registry if on_registry and registry is not None else account
    to = b.get("to")
    if not isinstance(to, str) or _ADDRESS.fullmatch(to) is None or to.lower() != target.lower():
        raise BuildMismatchError(
            f"target is not the agent policy registry {target}"
            if on_registry
            else f"target is not your account {account}",
        )
    value = b.get("value")
    if not isinstance(value, str) or _DECIMAL.fullmatch(value) is None or int(value) != 0:
        raise BuildMismatchError("owner calls never carry value")
    data = b.get("data")
    if not isinstance(data, str) or _CALLDATA.fullmatch(data) is None:
        raise BuildMismatchError("calldata is not hex")
    selector = b.get("selector")
    if "selector" in b and (
        not isinstance(selector, str) or selector.lower() != data[:_SELECTOR_LEN].lower()
    ):
        raise BuildMismatchError(
            f"the server's selector {_show(selector)} does not match the calldata"
        )
    contract = AGENT_POLICY_REGISTRY if on_registry else AGENT_ACCOUNT
    try:
        name, decoded = contract.decode_input(
            data
        )  # strict: re-encodes and compares, so trailing or non-canonical bytes fail
    except AbiUnknownSelectorError:
        raise BuildMismatchError(
            f"calldata does not decode against {contract.name} (unknown selector)"
        ) from None
    except MercurifiError:
        raise BuildMismatchError(
            "calldata has trailing or non-canonical bytes, or is malformed"
        ) from None
    if name not in OWNER_FUNCTIONS or OWNER_FUNCTIONS[name][0] is not on_registry:
        raise BuildMismatchError(f"{name} is not an owner function of {contract.name}")
    if name != function_name:
        raise BuildMismatchError(f"built {name}, asked for {function_name}")
    _check_server_function(b, name)
    inputs = contract.function(name).get("inputs", [])
    values = list(decoded.values())
    lead = 1 if on_registry else 0
    # A changed ABI (an argument added, removed or retyped at the front) is refused, never guessed.
    if (
        len(inputs) != lead + len(arg_names)
        or len(values) != len(inputs)
        or (
            on_registry
            and (inputs[0].get("type") != "address" or inputs[0].get("name") != "account")
        )
    ):
        raise BuildMismatchError(f"the {name} ABI does not have the arguments this verifier checks")
    if on_registry:
        first = values[0]
        if type(first) is not str or first.lower() != account.lower():
            raise BuildMismatchError(
                f"the registry call is not for your account {account} (it names {_show(first)})"
            )
    for k in arg_names:
        if k not in exact_c:
            raise BuildMismatchError(f"{k} of {name} is not covered by your expectation")
    for k in exact_c:
        if k not in arg_names:
            raise BuildMismatchError(f"{name} has no argument {_show(k)}")
    args: dict[str, Any] = {}
    for i, k in enumerate(arg_names):
        _compare(name, k, inputs[lead + i], values[lead + i], exact_c[k])
        args[k] = values[lead + i]
    return name, args
