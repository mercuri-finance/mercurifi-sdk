"""Owner and registry calls built by the API: the shared fixtures/vectors/ownerbuild.json (TS verifyOwnerBuild.test.ts)."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from mercurifi.build_verify import verify_built_owner_tx
from mercurifi.errors import BuildMismatchError, InvalidInputError

V = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "ownerbuild.json").read_text()
)
OTHER = "0x00000000000000000000000000000000deadbeef"


def _base(name: str) -> dict[str, Any]:
    return copy.deepcopy(next(a for a in V["accept"] if a["name"] == name))


def _verify(
    built: Mapping[str, Any], vec: Mapping[str, Any], exact: Any = None, **over: Any
) -> tuple[str, dict[str, Any]]:
    kw: dict[str, Any] = {
        "chain_id": V["chainId"],
        "account": V["account"],
        "registry": V["registry"],
        "function_name": vec["function"],
        "exact": copy.deepcopy(vec["exact"]) if exact is None else exact,
    }
    kw.update(over)
    return verify_built_owner_tx(built, **kw)


def _refused(
    built: Mapping[str, Any], vec: Mapping[str, Any], pattern: str, exact: Any = None, **over: Any
) -> None:
    with pytest.raises(BuildMismatchError) as e:
        _verify(built, vec, exact, **over)
    assert re.search(pattern, str(e.value), re.IGNORECASE), str(e.value)


def test_covers_every_owner_function_including_api_vectors() -> None:
    assert len({a["function"] for a in V["accept"]}) == 14
    assert sum(1 for a in V["accept"] if a["source"] == "api") == 3


@pytest.mark.parametrize("vec", V["accept"], ids=[a["name"] for a in V["accept"]])
def test_accepts(vec: dict[str, Any]) -> None:
    assert _verify(vec["built"], vec)[0] == vec["function"]


@pytest.mark.parametrize("vec", V["accept"], ids=[a["name"] for a in V["accept"]])
def test_refuses_every_generic_tamper(vec: dict[str, Any]) -> None:
    b = vec["built"]
    on_registry = b["to"].lower() == V["registry"].lower()
    _refused({**b, "chainId": V["chainId"] + 1}, vec, "chain")
    _refused({**b, "chainId": str(V["chainId"])}, vec, "chainId")
    _refused({**b, "to": V["account"] if on_registry else V["registry"]}, vec, "target")
    _refused({**b, "to": OTHER}, vec, "target")
    _refused({**b, "value": "1"}, vec, "value")
    _refused({**b, "value": "0x0"}, vec, "value")
    _refused({**b, "selector": "0x00000000"}, vec, "selector")
    _refused({**b, "data": b["data"] + "0"}, vec, "hex|trailing")
    _refused({**b, "data": b["data"] + "00" * 32}, vec, "trailing")
    _refused({**b, "function": "buy"}, vec, "function")
    if on_registry:
        data = b["data"][:10] + "0" * 24 + OTHER[2:] + b["data"][74:]
        _refused({**b, "data": data}, vec, "not for your account")
    for k in vec["exact"]:
        exact = copy.deepcopy(vec["exact"])
        del exact[k]
        _refused(b, vec, f"{k} of {vec['function']} is not covered", exact)
    _refused(b, vec, "has no argument extra", {**copy.deepcopy(vec["exact"]), "extra": "1"})
    other = next(
        a for a in V["accept"] if a["function"] != vec["function"] and a["built"]["to"] == b["to"]
    )
    _refused(b, other, "asked for|not covered|has no argument")


def _apply(exact: dict[str, Any], drops: list[str], sets: Mapping[str, Any]) -> dict[str, Any]:
    for p in drops:
        head, _, tail = p.partition(".")
        if tail:
            del exact[head][tail]
        else:
            del exact[head]
    for p, val in sets.items():
        head, _, tail = p.partition(".")
        if tail:
            exact[head][tail] = val
        else:
            exact[head] = val
    return exact


@pytest.mark.parametrize("r", V["refuse"], ids=[r["name"] for r in V["refuse"]])
def test_refuses_vector(r: dict[str, Any]) -> None:
    vec = _base(r["base"])
    built = {**vec["built"], **r.get("built", {})}
    exact = _apply(copy.deepcopy(vec["exact"]), r.get("exactDrop", []), r.get("exactSet", {}))
    _refused(built, vec, r["error"], exact)


def test_refuses_functions_it_does_not_verify() -> None:
    vec = _base("pauseAgents (registry)")
    for fn in ("buy", "__init__", 3):
        with pytest.raises(InvalidInputError):
            _verify(vec["built"], vec, function_name=fn)


def test_registry_required_for_registry_calls_only() -> None:
    pause = _base("pauseAgents (registry)")
    with pytest.raises(InvalidInputError, match="agentRegistry"):
        _verify(pause["built"], pause, registry=None)
    w = _base("withdraw (owner)")
    assert _verify(w["built"], w, registry=None)[0] == "withdraw"


def test_permission_names_or_bitmask_and_number_forms() -> None:
    add = _base("addAgent")
    exact = {**add["exact"], "permissions": 29, "expiresAt": 1_800_086_400}
    assert _verify(add["built"], add, exact)[1]["permissions"] == 29
    for bad in (
        {"permissions": ["buy", "nope"]},
        {"expiresAt": 1.5},
        {"expiresAt": True},
        {"expiresAt": "0x6b4b2400"},
    ):
        with pytest.raises(InvalidInputError):
            _verify(add["built"], add, {**add["exact"], **bad})
    pause = _base("pauseAgents (registry)")
    with pytest.raises(InvalidInputError):
        _verify(pause["built"], pause, {"paused": "true"})


def test_reads_the_expectation_once() -> None:
    reads = 0

    class Lying(Mapping[str, Any]):
        def __getitem__(self, k: str) -> Any:
            nonlocal reads
            reads += 1
            return reads == 1

        def __iter__(self) -> Any:
            return iter(["paused"])

        def __len__(self) -> int:
            return 1

    pause = _base("pauseAgents (registry)")
    assert _verify(pause["built"], pause, Lying())[0] == "pauseAgents"
    assert reads == 1
