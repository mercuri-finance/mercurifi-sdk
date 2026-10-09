import json
from pathlib import Path
from typing import Any

import pytest
from eth_utils import keccak, to_checksum_address

from mercurifi.abi import REVERT_DECODER, REVERT_ORDER, UNIVERSAL_ROUTER, V4_QUOTER, ALL, AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY, LAUNCH_FACTORY
from mercurifi.codec import AbiDecodeError, AbiEncodeError, AbiUnknownSelectorError, Contract, ErrorDecoder
from mercurifi.policy import DEFAULT_POLICY

TOKEN = to_checksum_address("0x" + "00" * 19 + "bb")
ACCOUNT = to_checksum_address("0x" + "00" * 19 + "aa")
AGENT = to_checksum_address("0x" + "00" * 19 + "cc")


def test_all_follows_the_ts_sources_order() -> None:
    assert [c.name for c in ALL] == [
        "AgentAccount", "AgentPolicyRegistry", "AgentAccountFactory", "BondingCurve", "LaunchFactory", "FeeManager",
        "GraduationManager", "LaunchHook", "LaunchToken", "V4Quoter", "UniversalRouter",
    ]


def test_selector_is_keccak_of_canonical_signature() -> None:
    assert AGENT_ACCOUNT.selector("buy") == "0x" + keccak(text="buy(address,uint256,uint256,uint256)")[:4].hex()


def test_round_trips_registry_calls_with_structs() -> None:
    # Owner functions live on the registry and take the account first.
    data = AGENT_POLICY_REGISTRY.encode("setPolicy", ACCOUNT, DEFAULT_POLICY.to_abi())
    name, args = AGENT_POLICY_REGISTRY.decode_input(data)
    assert name == "setPolicy"
    assert args["account"] == ACCOUNT
    assert list(args.values())[1] == DEFAULT_POLICY.to_abi()
    with pytest.raises(KeyError):
        AGENT_ACCOUNT.function("setPolicy")


def test_round_trips_account_calls() -> None:
    buy = AGENT_ACCOUNT.encode("buy", TOKEN, 25_000_000, 1, 2)
    assert AGENT_ACCOUNT.decode_input(buy) == ("buy", {"token": TOKEN, "usdcIn": 25_000_000, "minTokensOut": 1, "deadline": 2})


def test_round_trips_the_eight_field_launch_request() -> None:
    request = {
        "name": "Example", "symbol": "EX", "metadataURI": "ipfs://m", "salt": "0x" + "cd" * 32, "expectedConfigHash": "0x" + "92" * 32,
        "initialBuyUsdc": 10_000_000, "minTokensOut": 1_757_100_783_706_883_641_990_715, "deadline": 1_700_000_060,
    }
    name, args = AGENT_ACCOUNT.decode_input(AGENT_ACCOUNT.encode("launch", request))
    assert name == "launch"
    assert list(args.values()) == [request]
    assert list(request) == [c["name"] for c in AGENT_ACCOUNT.function("launch")["inputs"][0]["components"]]


def test_errors_and_results() -> None:
    data = AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 12_500_000)
    assert AGENT_POLICY_REGISTRY.decode_error(data) == ("PeriodSpendExceeded", [12_500_000])
    assert AGENT_ACCOUNT.decode_error(data) is None  # registry error: decoding merges ABIs
    assert AGENT_ACCOUNT.decode_error(AGENT_ACCOUNT.encode_error("TradeTooLarge", 100_000_000)) == ("TradeTooLarge", [100_000_000])
    assert AGENT_ACCOUNT.decode_error("0xdeadbeef") is None
    headroom = AGENT_POLICY_REGISTRY.encode_result("headroom", (1, 2, 3, 4))
    assert AGENT_POLICY_REGISTRY.decode_output("headroom", headroom) == (1, 2, 3, 4)
    assert AGENT_POLICY_REGISTRY.decode_input(AGENT_POLICY_REGISTRY.encode("headroom", ACCOUNT)) == ("headroom", {"account": ACCOUNT})
    queued = AGENT_POLICY_REGISTRY.encode_result("queued", (1, 1_700_003_600, 1, 5, "0x1234"))
    assert AGENT_POLICY_REGISTRY.decode_output("queued", queued) == (1, 1_700_003_600, 1, 5, "0x1234")
    basis = AGENT_ACCOUNT.encode_result("basis", (25_000_000, 10**24, 10**23))
    assert AGENT_ACCOUNT.decode_output("basis", basis) == (25_000_000, 10**24, 10**23)


def test_logs_round_trip_indexed_and_plain_arguments() -> None:
    topics, data = AGENT_ACCOUNT.encode_log("AgentAction", {"agent": TOKEN, "action": 1, "token": TOKEN, "usdcSpent": 5, "tokenDelta": -7, "periodId": 9})
    name, args = AGENT_ACCOUNT.decode_log(topics, data)  # type: ignore[misc]
    assert name == "AgentAction"
    assert (args["agent"], args["token"], args["usdcSpent"], args["tokenDelta"], args["periodId"]) == (TOKEN, TOKEN, 5, -7, 9)
    assert AGENT_ACCOUNT_FACTORY.decode_log(topics, data) is None
    assert LAUNCH_FACTORY.function("createToken")["name"] == "createToken"


def test_registry_queue_events_carry_the_account_as_topic_one() -> None:
    topics, data = AGENT_POLICY_REGISTRY.encode_log(
        "AgentQueued", {"account": ACCOUNT, "id": 4, "agent": AGENT, "expiresAt": 1_800_000_000, "permissions": 29, "eta": 1_700_003_600}
    )
    assert len(topics) == 4  # topic0 + account + id + agent
    assert topics[1] == "0x" + "00" * 12 + ACCOUNT[2:].lower()
    name, args = AGENT_POLICY_REGISTRY.decode_log(topics, data)  # type: ignore[misc]
    assert name == "AgentQueued"
    assert (args["account"], args["id"], args["agent"], args["permissions"], args["eta"]) == (ACCOUNT, 4, AGENT, 29, 1_700_003_600)
    assert AGENT_ACCOUNT.decode_log(topics, data) is None


PAD = "00" * 32


def test_decode_input_is_strict_about_trailing_bytes() -> None:
    buy = AGENT_ACCOUNT.encode("buy", TOKEN, 1, 2, 3)
    for tail in ("00", PAD):
        with pytest.raises(AbiDecodeError):
            AGENT_ACCOUNT.decode_input(buy + tail)
        assert AGENT_ACCOUNT.decode_input(buy + tail, strict=False)[0] == "buy"
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_input(buy[:-2])  # truncated


def test_decode_input_rejects_dirty_padding_and_non_canonical_offsets() -> None:
    request = {"name": "E", "symbol": "X", "metadataURI": "", "salt": "0x" + "00" * 32, "expectedConfigHash": "0x" + "00" * 32,
               "initialBuyUsdc": 0, "minTokensOut": 0, "deadline": 1}
    good = AGENT_ACCOUNT.encode("launch", request)
    assert AGENT_ACCOUNT.decode_input(good)[0] == "launch"
    body = bytes.fromhex(good[2 + 8:])
    # Shift the dynamic tuple offset (first word) by 32 bytes and insert a padding word: eth-abi still decodes it.
    shifted = bytes.fromhex(good[2:10]) + (int.from_bytes(body[:32], "big") + 32).to_bytes(32, "big") + bytes(32) + body[32:]
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_input("0x" + shifted.hex())
    assert AGENT_ACCOUNT.decode_input("0x" + shifted.hex(), strict=False)[0] == "launch"
    # Dirty address padding.
    buy = AGENT_ACCOUNT.encode("buy", TOKEN, 1, 2, 3)
    dirty = buy[:10] + "ff" + buy[12:]
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_input(dirty)


def test_decode_output_and_error_are_strict() -> None:
    headroom = AGENT_POLICY_REGISTRY.encode_result("headroom", (1, 2, 3, 4))
    with pytest.raises(AbiDecodeError):
        AGENT_POLICY_REGISTRY.decode_output("headroom", headroom + "00")
    assert AGENT_POLICY_REGISTRY.decode_output("headroom", headroom + "00", strict=False) == (1, 2, 3, 4)
    with pytest.raises(AbiDecodeError):
        AGENT_POLICY_REGISTRY.decode_output("headroom", headroom[:-2])
    err = AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 5)
    with pytest.raises(AbiDecodeError):
        AGENT_POLICY_REGISTRY.decode_error(err + PAD)
    assert AGENT_POLICY_REGISTRY.decode_error(err + PAD, strict=False) == ("PeriodSpendExceeded", [5])


def test_logs_check_topic_count_and_strict_data() -> None:
    topics, data = AGENT_ACCOUNT.encode_log("AgentAction", {"agent": AGENT, "action": 1, "token": TOKEN})
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_log(topics + [topics[1]], data)  # extra topic
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_log(topics[:-1], data)  # missing topic
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_log(topics, data + "00")
    with pytest.raises(AbiDecodeError):
        AGENT_ACCOUNT.decode_log([topics[0], topics[1], "0x" + "ff" * 12 + topics[2][26:]], data)  # dirty address topic
    assert AGENT_ACCOUNT.decode_log(topics, data) is not None


def test_codec_errors_are_typed() -> None:
    with pytest.raises(AbiUnknownSelectorError) as unknown:
        AGENT_ACCOUNT.decode_input("0xdeadbeef")
    assert unknown.value.code == "ABI_UNKNOWN_SELECTOR"
    with pytest.raises(AbiDecodeError) as odd:
        AGENT_ACCOUNT.decode_input("0x123")
    assert odd.value.code == "ABI_MALFORMED"
    with pytest.raises(AbiEncodeError) as missing:
        AGENT_ACCOUNT.encode("launch", {"name": "x"})
    assert missing.value.code == "ABI_ENCODE"
    with pytest.raises(AbiEncodeError):
        AGENT_ACCOUNT.encode("buy", TOKEN)  # wrong arity
    with pytest.raises(AbiEncodeError):
        AGENT_ACCOUNT.encode("buy", TOKEN, -1, 0, 0)  # out of range
    with pytest.raises(AbiEncodeError):
        AGENT_ACCOUNT.encode_error("Nope")


def _fn(name: str, inputs: list[str]) -> dict[str, Any]:
    return {"type": "function", "name": name, "inputs": [{"name": f"a{i}", "type": t} for i, t in enumerate(inputs)], "outputs": []}


def test_duplicate_selectors_and_overloads() -> None:
    same = _fn("f", ["uint256"])
    assert Contract([same, dict(same)], "Dup").selector("f") == Contract([same], "One").selector("f")  # identical signature: accepted
    over = Contract([_fn("g", ["uint256"]), _fn("g", ["uint256", "uint256"])], "Over")
    with pytest.raises(AbiEncodeError):
        over.selector("g")
    assert over.function("g", 2)["inputs"][1]["name"] == "a1"


def _error(name: str, inputs: list[str]) -> dict[str, Any]:
    return {"type": "error", "name": name, "inputs": [{"name": f"a{i}", "type": t} for i, t in enumerate(inputs)]}


def test_error_decoder_merges_in_order() -> None:
    a = Contract([_error("Shared", ["uint256"]), _error("OnlyA", [])], "A")
    b = Contract([_error("Shared", ["uint256"]), _error("OnlyB", [])], "B")
    dec = ErrorDecoder([a, b])
    assert dec.decode(b.encode_error("Shared", 3)) == ("A", "Shared", [3])  # first match wins
    assert dec.decode(b.encode_error("OnlyB")) == ("B", "OnlyB", [])
    assert dec.decode("0xdeadbeef") is None
    # Same name, different signature: a different selector, so not a conflict. Force a real conflict by faking a signature.
    c = Contract([_error("OnlyA", [])], "C")
    c._errors = {sel: {**item, "name": "Other"} for sel, item in a._errors.items() if item["name"] == "OnlyA"}
    with pytest.raises(ValueError):
        ErrorDecoder([a, c])


def test_revert_decoder_follows_the_ts_order_and_merges_agent_abis() -> None:
    assert [c.name for c in REVERT_ORDER[:3]] == ["AgentAccount", "AgentPolicyRegistry", "AgentAccountFactory"]
    assert REVERT_ORDER.index(UNIVERSAL_ROUTER) < REVERT_ORDER.index(V4_QUOTER)
    assert ALL.index(V4_QUOTER) < ALL.index(UNIVERSAL_ROUTER)  # ALL keeps the generator order
    assert set(REVERT_ORDER) == set(ALL)
    assert REVERT_DECODER.decode(AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 7)) == ("AgentPolicyRegistry", "PeriodSpendExceeded", [7])
    assert REVERT_DECODER.decode(AGENT_ACCOUNT.encode_error("TradeTooLarge", 9)) == ("AgentAccount", "TradeTooLarge", [9])


def _unnamed(params: list[dict[str, Any]], where: str) -> list[str]:
    bad = []
    for p in params:
        if p["type"].startswith("tuple"):
            bad += _unnamed(p["components"], where)
            if any(not c.get("name") for c in p["components"]):
                bad.append(where)
    return bad


def test_no_abi_has_unnamed_struct_components() -> None:
    bad: list[str] = []
    for c in ALL:
        for item in c.abi:
            for key in ("inputs", "outputs"):
                bad += _unnamed(item.get(key, []), f"{c.name}.{item.get('name')}")
    assert bad == []


VECTORS = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "abi.json").read_text())
BY_FILE = {c.name[0].lower() + c.name[1:]: c for c in ALL}


def _revive(x: Any) -> Any:
    if isinstance(x, str) and x.lstrip("-").isdigit():
        return int(x)
    if isinstance(x, list):
        return [_revive(i) for i in x]
    if isinstance(x, dict):
        return {k: _revive(v) for k, v in x.items()}
    return x


@pytest.mark.parametrize("vec", VECTORS["calls"], ids=lambda v: v["fn"])
def test_call_vectors_match_typescript(vec: dict[str, Any]) -> None:
    c = BY_FILE[vec["contract"]]
    assert c.encode(vec["fn"], *_revive(vec["args"])) == vec["data"]
    name, args = c.decode_input(vec["data"])
    assert name == vec["fn"] and list(args.values()) == _revive(vec["args"])


@pytest.mark.parametrize("vec", VECTORS["logs"], ids=lambda v: v["event"])
def test_log_vectors_match_typescript(vec: dict[str, Any]) -> None:
    c = BY_FILE[vec["contract"]]
    values = _revive(vec["values"])
    assert c.encode_log(vec["event"], values) == (vec["topics"], vec["data"])
    decoded = c.decode_log(vec["topics"], vec["data"])
    assert decoded is not None and decoded[0] == vec["event"]
    assert {k: decoded[1][k] for k in values} == values
