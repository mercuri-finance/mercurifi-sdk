"""Agent calls built by the API: the shared fixtures/vectors/agentbuild.json (TS agentBuildVectors.test.ts)."""
from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from mercurifi.build_verify import verify_built_owner_tx, verify_built_tx
from mercurifi.errors import BuildMismatchError, InvalidInputError

V = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "agentbuild.json").read_text())


def _verify(built: Mapping[str, Any], vec: Mapping[str, Any], exact: Any = None, **over: Any) -> tuple[str, dict[str, Any]]:
    kw: dict[str, Any] = {
        "chain_id": V["chainId"], "account": V["account"], "function_name": vec["function"],
        "exact": copy.deepcopy(vec["exact"]) if exact is None else exact,
        "at_least": {k: int(x) for k, x in vec["atLeast"].items()},
        "deadline": (int(vec["deadline"][0]), int(vec["deadline"][1])) if "deadline" in vec else None,
    }
    kw.update(over)
    return verify_built_tx(built, **kw)


def _refused(built: Mapping[str, Any], vec: Mapping[str, Any], pattern: str, exact: Any = None) -> None:
    with pytest.raises(BuildMismatchError) as e:
        _verify(built, vec, exact)
    assert re.search(pattern, str(e.value), re.IGNORECASE), str(e.value)


@pytest.mark.parametrize("vec", V["accept"], ids=[a["name"] for a in V["accept"]])
def test_accepts(vec: dict[str, Any]) -> None:
    assert _verify(vec["built"], vec)[0] == vec["function"]


@pytest.mark.parametrize("vec", V["accept"], ids=[a["name"] for a in V["accept"]])
def test_refuses_the_generic_tampers(vec: dict[str, Any]) -> None:
    b = vec["built"]
    _refused({**b, "chainId": V["chainId"] + 1}, vec, "chain")
    _refused({**b, "chainId": 0}, vec, "positive safe integer")
    _refused({**b, "chainId": 2**53}, vec, "positive safe integer")
    _refused({**b, "to": V["registry"]}, vec, "not your account")
    _refused({**b, "value": "1"}, vec, "value")
    _refused({**b, "selector": "0x00000000"}, vec, "selector")
    _refused({**b, "data": b["data"] + "00" * 32}, vec, "trailing")
    _refused({**b, "function": "withdraw"}, vec, "function")
    with pytest.raises(InvalidInputError):
        verify_built_owner_tx(b, chain_id=V["chainId"], account=V["account"], registry=V["registry"], function_name=vec["function"], exact={})


@pytest.mark.parametrize("r", V["refuse"], ids=[r["name"] for r in V["refuse"]])
def test_refuses_vector(r: dict[str, Any]) -> None:
    vec = copy.deepcopy(next(a for a in V["accept"] if a["name"] == r["base"]))
    built = {**vec["built"], **r.get("built", {})}
    for k, x in r.get("built", {}).items():
        if x is None:
            del built[k]
    exact = copy.deepcopy(vec["exact"])
    for k in r.get("exactDrop", []):
        del exact[k]
    exact.update(r.get("exactSet", {}))
    _refused(built, vec, r["error"], exact)


@pytest.mark.parametrize("chain_id", [0, -1, 1.5, 2**53, "5042002", True])
def test_refuses_an_expectation_chain_id_that_is_not_a_positive_safe_integer(chain_id: Any) -> None:
    vec = V["accept"][0]
    with pytest.raises(InvalidInputError):
        _verify(vec["built"], vec, chain_id=chain_id)
    with pytest.raises(InvalidInputError):
        verify_built_owner_tx(vec["built"], chain_id=chain_id, account=V["account"], registry=V["registry"], function_name="pauseAgents",
                              exact={"paused": True})
