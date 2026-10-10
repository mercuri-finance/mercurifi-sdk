"""ERC-8004 identity helpers against the shared vectors (fixtures/vectors/identity.json), as in identity.test.ts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from eth_utils.crypto import keccak

from mercurifi.codec import to_hex
from mercurifi.errors import (
    InvalidInputError,
    MercurifiError,
    NetworkMismatchError,
    NotDeployedError,
)
from mercurifi.identity import (
    AGENT_ACCOUNT_SERVICE,
    ERC8004_REGISTRIES,
    IDENTITY_REGISTRY,
    IDENTITY_REGISTRY_ABI,
    AgentIdentity,
    RegisteredAgent,
    agent_id_from_receipt,
    agent_uri_problem,
    build_registration_file,
    encode_register,
    encode_set_agent_uri,
    erc8004_registries,
    get_agent,
    registration_data_uri,
    registration_file_json,
)
from mercurifi.rpc import Rpc

from .helpers import MockRpc, NodeError

V: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "identity.json").read_text(
        encoding="utf-8"
    )
)
TESTNET = ERC8004_REGISTRIES["testnet"]
_PY_NAMES = {
    "agentId": "agent_id",
    "x402Support": "x402_support",
    "supportedTrust": "supported_trust",
}


def _kwargs(inp: dict[str, Any]) -> dict[str, Any]:
    out = {_PY_NAMES.get(k, k): v for k, v in inp.items()}
    if "agent_id" in out:
        out["agent_id"] = int(out["agent_id"])
    return out


def test_pins_the_per_network_addresses() -> None:
    for net, book in V["registries"].items():
        b = ERC8004_REGISTRIES[net]
        assert (b.chain_id, b.identity_registry, b.reputation_registry, b.validation_registry) == (
            book["chainId"],
            book["identityRegistry"],
            book["reputationRegistry"],
            book["validationRegistry"],
        )


def test_uses_the_selectors_and_topics_found_in_the_deployed_implementation() -> None:
    for sig, sel in V["selectors"].items():
        assert to_hex(keccak(text=sig)[:4]) == sel
    fns = {
        IDENTITY_REGISTRY.selector(i["name"])
        for i in IDENTITY_REGISTRY_ABI
        if i["type"] == "function"
    }
    assert fns == set(V["selectors"].values())
    for sig, topic in V["events"].items():
        assert to_hex(keccak(text=sig)) == topic


def test_keeps_mainnet_refused_while_agent_accounts_are_not_deployed_there() -> None:
    with pytest.raises(NotDeployedError):
        erc8004_registries("mainnet")
    with pytest.raises(NotDeployedError):
        encode_register("mainnet", "https://a.example/a.json")
    with pytest.raises(InvalidInputError):
        erc8004_registries("local")


@pytest.mark.parametrize("case", V["register"], ids=lambda c: c["agentURI"][:40])
def test_register_calldata(case: dict[str, Any]) -> None:
    assert encode_register("testnet", case["agentURI"]) == {
        "chainId": 5042002,
        "to": TESTNET.identity_registry,
        "data": case["data"],
        "value": 0,
    }


@pytest.mark.parametrize("case", V["setAgentURI"], ids=lambda c: c["agentURI"])
def test_set_agent_uri_calldata(case: dict[str, Any]) -> None:
    got = encode_set_agent_uri("testnet", int(case["agentId"]), case["agentURI"])
    assert got == {
        "chainId": 5042002,
        "to": TESTNET.identity_registry,
        "data": case["data"],
        "value": 0,
    }


def test_refuses_an_unusable_agent_uri_or_id() -> None:
    with pytest.raises(InvalidInputError):
        encode_register("testnet", "http://a.example/a.json")
    for bad in (-1, True, "1", 2**256):
        with pytest.raises(InvalidInputError, match="agentId"):
            encode_set_agent_uri("testnet", bad, "https://a.example/a.json")  # type: ignore[arg-type]


@pytest.mark.parametrize("case", V["agentUriProblems"], ids=lambda c: c["uri"][:40])
def test_agent_uri_problem(case: dict[str, Any]) -> None:
    assert agent_uri_problem(case["uri"]) == case["problem"]


@pytest.mark.parametrize("case", V["files"], ids=lambda c: c["name"])
def test_registration_file_json_and_data_uri(case: dict[str, Any]) -> None:
    file = build_registration_file(**_kwargs(case["input"]))
    assert registration_file_json(file) == case["json"]
    assert registration_data_uri(file) == case["dataUri"]
    assert agent_uri_problem(registration_data_uri(file)) is None


def test_links_the_account_as_a_service_entry_never_as_the_agent_wallet() -> None:
    file = build_registration_file(**_kwargs(V["files"][0]["input"]))
    assert file["services"][0] == {
        "name": AGENT_ACCOUNT_SERVICE,
        "endpoint": "eip155:5042002:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    }
    assert "agentWallet" not in registration_file_json(file)


@pytest.mark.parametrize("case", V["refuse"], ids=lambda c: c["name"])
def test_refuses(case: dict[str, Any]) -> None:
    with pytest.raises(InvalidInputError) as info:
        build_registration_file(**_kwargs(case["input"]))
    assert info.value.field == case["pyField"]
    assert case["error"] in str(info.value)


def test_refuses_wrong_types_and_unknown_service_fields() -> None:
    base: dict[str, Any] = {"network": "testnet", "account": TESTNET.identity_registry, "name": "a"}
    with pytest.raises(InvalidInputError, match="active"):
        build_registration_file(**base, active="yes")  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError, match="x402Support"):
        build_registration_file(**base, x402_support=1)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError, match="unknown field url"):
        build_registration_file(
            **base, services=[{"name": "web", "endpoint": "https://a.example", "url": "x"}]
        )
    with pytest.raises(InvalidInputError, match="agentId"):
        build_registration_file(**base, agent_id=True)
    with pytest.raises(InvalidInputError, match="supportedTrust"):
        build_registration_file(**base, supported_trust="reputation")


def _receipt(**over: Any) -> dict[str, Any]:
    r: dict[str, Any] = dict(V["receipt"])
    r.update(over)
    return r


def test_reads_the_registered_log_of_a_real_testnet_receipt() -> None:
    e = V["receiptExpect"]
    assert agent_id_from_receipt("testnet", _receipt()) == RegisteredAgent(
        int(e["agentId"]), e["owner"], e["agentURI"]
    )


def test_falls_back_to_the_mint_transfer_without_a_registered_log() -> None:
    logs = [
        lg
        for lg in V["receipt"]["logs"]
        if lg["topics"][0] == V["events"]["Transfer(address,address,uint256)"]
    ]
    e = V["receiptExpect"]
    assert agent_id_from_receipt("testnet", _receipt(logs=logs)) == RegisteredAgent(
        int(e["agentId"]), e["owner"], None
    )


def test_ignores_logs_from_any_other_address() -> None:
    logs = [
        {**lg, "address": "0x000000000000000000000000000000000000dEaD"}
        for lg in V["receipt"]["logs"]
    ]
    with pytest.raises(MercurifiError, match="no agent registration event"):
        agent_id_from_receipt("testnet", _receipt(logs=logs))


def test_refuses_a_reverted_receipt_and_two_registrations() -> None:
    with pytest.raises(MercurifiError, match="reverted"):
        agent_id_from_receipt("testnet", _receipt(status="0x0"))
    with pytest.raises(MercurifiError) as info:
        agent_id_from_receipt("testnet", _receipt(logs=V["receipt"]["logs"] * 2))
    assert info.value.code == "MISSING_EVENT"


OWNER = V["receiptExpect"]["owner"]


def _mocked(chain_id: int = 5042002) -> MockRpc:
    reg = TESTNET.identity_registry
    return (
        MockRpc(chain_id)
        .read(reg, IDENTITY_REGISTRY, "ownerOf", OWNER)
        .read(reg, IDENTITY_REGISTRY, "tokenURI", "https://agentcard.example.com/agent-9258.json")
        .read(reg, IDENTITY_REGISTRY, "getAgentWallet", OWNER)
    )


def _rpc(mock: MockRpc) -> Rpc:
    return Rpc("https://rpc.example/v2/SUPERSECRETKEY123", transport=mock.transport())


async def test_get_agent_reads_owner_uri_and_wallet() -> None:
    rpc = _rpc(_mocked())
    try:
        got = await get_agent(rpc, "testnet", 897205)
    finally:
        await rpc.aclose()
    assert got == AgentIdentity(
        897205, OWNER, "https://agentcard.example.com/agent-9258.json", OWNER
    )


async def test_get_agent_refuses_an_rpc_on_another_chain() -> None:
    rpc = _rpc(_mocked(5042))
    try:
        with pytest.raises(NetworkMismatchError):
            await get_agent(rpc, "testnet", 1)
    finally:
        await rpc.aclose()


async def test_get_agent_reports_an_unknown_id() -> None:
    nonexistent = to_hex(
        keccak(text="ERC721NonexistentToken(uint256)")[:4] + (9).to_bytes(32, "big")
    )
    rpc = _rpc(
        _mocked().revert(TESTNET.identity_registry, IDENTITY_REGISTRY, "ownerOf", nonexistent)
    )
    try:
        with pytest.raises(MercurifiError) as info:
            await get_agent(rpc, "testnet", 9)
    finally:
        await rpc.aclose()
    assert info.value.code == "AGENT_NOT_FOUND"


async def test_get_agent_keeps_the_rpc_url_out_of_failures() -> None:
    def node_error(_params: list[Any]) -> Any:
        raise NodeError(-32000, "upstream https://rpc.example/v2/SUPERSECRETKEY123 failed")

    def transport_error(_params: list[Any]) -> Any:
        raise RuntimeError("connect failed")

    for handler in (node_error, transport_error):
        rpc = _rpc(_mocked().on("eth_call", handler))
        try:
            with pytest.raises(MercurifiError) as info:
                await get_agent(rpc, "testnet", 1)
        finally:
            await rpc.aclose()
        assert info.value.code == "RPC_ERROR"
        assert "SUPERSECRETKEY123" not in str(info.value)
        assert info.value.__cause__ is None and info.value.__context__ is None
