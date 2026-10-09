from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from eth_account.typed_transactions.typed_transaction import TypedTransaction
from hexbytes import HexBytes

from mercurifi.abi import AGENT_ACCOUNT, AGENT_POLICY_REGISTRY
from mercurifi.client import AsyncClient, create_client
from mercurifi.codec import from_hex
from mercurifi.errors import MercurifiError, NetworkMismatchError, TxDroppedError
from mercurifi.gas import fees_with_floor, gas_limit_for
from mercurifi.networks import local_network
from mercurifi.nonce import NonceManager
from mercurifi.revert import ContractRevertError
from mercurifi.signers import local_key
from mercurifi.time import chain_deadline
from mercurifi.tx import TxSender, WriteRequest

from .helpers import ACCOUNT, OWNER_KEY, TOKEN, MockRpc, NodeError, Revert, local_client, local_json, local_rpc

V = json.loads((Path(__file__).resolve().parents[3] / "fixtures" / "vectors" / "gas.json").read_text())
BUY = AGENT_ACCOUNT.encode("buy", TOKEN, 1_000_000, 1, 1)
SECRET_URL = "https://h.example/v2/SECRET"
SECRET_KEY = OWNER_KEY[2:20]


def sent_tx(rpc: MockRpc, i: int = 0) -> dict[str, Any]:
    return dict(TypedTransaction.from_bytes(HexBytes(from_hex(rpc.sent[i]))).as_dict())


def req(**over: Any) -> WriteRequest:
    return WriteRequest(ACCOUNT, BUY, "buy", **over)


@pytest.mark.parametrize("case", V["fees"])
def test_fees(case: dict[str, Any]) -> None:
    out = case["out"]
    assert fees_with_floor(int(case["baseFee"]), int(case["priority"])) == (int(out["maxFeePerGas"]), int(out["maxPriorityFeePerGas"]))


@pytest.mark.parametrize("case", V["cappedFees"])
def test_capped(case: dict[str, Any]) -> None:
    if "error" in case:
        with pytest.raises(MercurifiError) as e:
            fees_with_floor(int(case["baseFee"]), int(case["priority"]), int(case["cap"]))
        assert e.value.code == case["error"]
    else:
        out = case["out"]
        assert fees_with_floor(int(case["baseFee"]), int(case["priority"]), int(case["cap"])) == (int(out["maxFeePerGas"]), int(out["maxPriorityFeePerGas"]))


@pytest.mark.parametrize("case", V["gasLimit"])
def test_gas_limit(case: dict[str, Any]) -> None:
    assert gas_limit_for(int(case["estimate"]), case["mayGraduate"]) == int(case["out"])


async def _client(rpc: MockRpc, **over: Any) -> AsyncClient:
    rpc.read(ACCOUNT, AGENT_ACCOUNT, "buy", 5)
    return await local_client(rpc, **over)


async def test_floor_and_type2() -> None:
    rpc = local_rpc()
    rpc.block["base_fee"] = 0
    mf = await _client(rpc)
    await mf.sender.send(local_key(OWNER_KEY), req())
    tx = sent_tx(rpc)
    assert (tx["maxFeePerGas"], tx["gas"], tx["nonce"], tx["chainId"]) == (20_000_000_000, 180_000, 7, 31337)


async def test_floors_when_node_reports_tiny_base_fee_and_tip() -> None:
    rpc = local_rpc()
    rpc.block["base_fee"] = 1
    rpc.on("eth_maxPriorityFeePerGas", lambda p: "0x1")
    mf = await _client(rpc)
    await mf.sender.send(local_key(OWNER_KEY), req())
    assert sent_tx(rpc)["maxFeePerGas"] >= 20_000_000_000


async def test_graduation_floor() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    await mf.sender.send(local_key(OWNER_KEY), req(may_graduate=True))
    assert sent_tx(rpc)["gas"] == 1_800_000
    call = [p for p in rpc.methods("eth_call") if p[0]["to"].lower() == ACCOUNT.lower()][0]
    assert int(call[0]["gas"], 16) == 1_800_000


async def test_preflight_revert_signs_nothing() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    # PeriodSpendExceeded is a registry error that bubbles through the account call (merged decoding).
    rpc.revert(ACCOUNT, AGENT_ACCOUNT, "buy", AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 3_000_000))
    with pytest.raises(ContractRevertError, match="3 USDC") as e:
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert rpc.sent == [] and e.value.__cause__ is None and e.value.__context__ is None


async def test_dropped_rereads_nonce() -> None:  # Review Focus 3
    rpc = local_rpc()
    mf = await _client(rpc, receipt_timeout=0.005)
    rpc.receipt_mode = "none"
    with pytest.raises(TxDroppedError):
        await mf.sender.send(local_key(OWNER_KEY), req())
    rpc.receipt_mode = "success"
    await mf.sender.send(local_key(OWNER_KEY), req())
    assert sent_tx(rpc, 1)["nonce"] == 7
    assert len(rpc.methods("eth_getTransactionCount")) == 2


async def test_failed_attempt_rereads_nonce_even_before_sending() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    calls = {"n": 0}

    def flaky(p: list[Any]) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise NodeError(-32000, "boom")
        return "0x1"

    rpc.on("eth_maxPriorityFeePerGas", flaky)
    rpc.on("eth_estimateGas", lambda p: (_ for _ in ()).throw(NodeError(-32000, "no")) if calls["n"] == 0 else "0x1")
    with pytest.raises(MercurifiError):
        await mf.sender.send(local_key(OWNER_KEY), req())
    rpc.on("eth_estimateGas", lambda p: "0x30d40")
    await mf.sender.send(local_key(OWNER_KEY), req())
    assert len(rpc.methods("eth_getTransactionCount")) == 2


async def test_concurrent_sends_are_ordered() -> None:
    import asyncio

    rpc = local_rpc()
    mf = await _client(rpc)
    s = local_key(OWNER_KEY)
    await asyncio.gather(*(mf.sender.send(s, req()) for _ in range(3)))
    assert [sent_tx(rpc, i)["nonce"] for i in range(3)] == [7, 8, 9]
    assert len(rpc.methods("eth_getTransactionCount")) == 1


async def test_chain_time_not_local_clock(monkeypatch: pytest.MonkeyPatch) -> None:  # Review Focus 2
    import time as _time

    rpc = local_rpc()
    mf = await _client(rpc)
    monkeypatch.setattr(_time, "time", lambda: rpc.block["timestamp"] + 600)
    assert await chain_deadline(mf.rpc, 120, 60) == rpc.block["timestamp"] + 60
    assert await chain_deadline(mf.rpc, 30, 60) == rpc.block["timestamp"] + 30


async def test_chain_is_rechecked_before_each_send_and_nothing_is_signed_on_mismatch() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    await mf.sender.send(local_key(OWNER_KEY), req())
    rpc.chain_id = 5042
    with pytest.raises(NetworkMismatchError):
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert len(rpc.sent) == 1


async def test_chain_is_rechecked_with_verify_false_on_the_local_book() -> None:
    rpc = MockRpc(31337)
    mf = await create_client(local_network(local_json()), rpc_url="http://127.0.0.1:8545", rpc_transport=rpc.transport(), verify=False, on_warning=lambda m: None, api=None)
    assert rpc.calls == []
    rpc.chain_id = 1
    with pytest.raises(NetworkMismatchError):
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert rpc.sent == [] and [m for m, _ in rpc.calls] == ["eth_getTransactionCount", "eth_chainId"]


@pytest.mark.parametrize("method", ["eth_chainId", "eth_call", "eth_estimateGas", "eth_getBlockByNumber", "eth_sendRawTransaction", "eth_getTransactionReceipt"])
async def test_transport_failure_is_a_credential_free_rpc_error(method: str) -> None:
    rpc = local_rpc()
    mf = await _client(rpc)

    def boom(p: list[Any]) -> Any:
        raise httpx.ConnectError(f"All connection attempts failed for {SECRET_URL}\nbody")

    rpc.on(method, boom)
    with pytest.raises(MercurifiError) as e:
        await mf.sender.send(local_key(OWNER_KEY), req(may_graduate=True))
    err = e.value
    assert err.code == "RPC_ERROR"
    assert "SECRET" not in f"{err}{err!r}{err.args}"
    assert err.__cause__ is None and err.__context__ is None


async def test_non_sdk_exception_from_the_rpc_layer_is_redacted() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)

    async def bad(*a: Any, **k: Any) -> Any:
        raise ValueError(f"failed at {SECRET_URL}")

    mf.rpc.get_block = bad  # type: ignore[method-assign]
    with pytest.raises(MercurifiError) as e:
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert e.value.code == "RPC_ERROR" and "SECRET" not in str(e.value) and "h.example" in str(e.value)
    assert e.value.__cause__ is None and e.value.__context__ is None


async def test_preflight_also_redacts() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    rpc.on("eth_call", lambda p: (_ for _ in ()).throw(NodeError(-32000, f"failed at {SECRET_URL}")))
    with pytest.raises(MercurifiError) as e:
        await mf.sender.preflight(local_key(OWNER_KEY).address, req())
    assert "SECRET" not in str(e.value) and e.value.code == "RPC_ERROR"
    assert e.value.__cause__ is None and e.value.__context__ is None


async def test_queued_send_is_preflighted_after_its_predecessor_and_never_signed_if_it_reverts() -> None:
    import asyncio

    rpc = local_rpc()
    mf = await _client(rpc)
    data = AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 0)

    def buy(args: list[Any]) -> int:
        if rpc.sent:
            raise Revert(data)
        return 5

    rpc.read(ACCOUNT, AGENT_ACCOUNT, "buy", buy)
    s = local_key(OWNER_KEY)
    first, second = await asyncio.gather(mf.sender.send(s, req()), mf.sender.send(s, req()), return_exceptions=True)
    assert not isinstance(first, BaseException)
    assert isinstance(second, ContractRevertError)
    assert len(rpc.sent) == 1


async def test_gas_fallback_only_on_node_estimation_errors() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    rpc.on("eth_estimateGas", lambda p: (_ for _ in ()).throw(NodeError(-32000, "gas required exceeds allowance")))
    await mf.sender.send(local_key(OWNER_KEY), req(may_graduate=True))
    assert sent_tx(rpc)["gas"] == 1_800_000
    rpc.on("eth_estimateGas", lambda p: (_ for _ in ()).throw(httpx.ReadError("socket hang up")))
    with pytest.raises(MercurifiError) as e:
        await mf.sender.send(local_key(OWNER_KEY), req(may_graduate=True))
    assert e.value.code == "RPC_ERROR" and len(rpc.sent) == 1
    # a node error on an ordinary buy is not papered over
    rpc.on("eth_estimateGas", lambda p: (_ for _ in ()).throw(NodeError(-32000, "nope")))
    with pytest.raises(MercurifiError):
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert len(rpc.sent) == 1


async def test_priority_fee_is_capped_by_default_and_by_option() -> None:
    quote = lambda p: hex(500_000_000_000)  # noqa: E731
    rpc = local_rpc().on("eth_maxPriorityFeePerGas", quote)
    mf = await _client(rpc)
    await mf.sender.send(local_key(OWNER_KEY), req())
    assert sent_tx(rpc)["maxPriorityFeePerGas"] == 100_000_000_000
    rpc2 = local_rpc().on("eth_maxPriorityFeePerGas", quote)
    mf2 = await _client(rpc2, max_priority_fee_per_gas=2_000_000_000)
    await mf2.sender.send(local_key(OWNER_KEY), req())
    assert sent_tx(rpc2)["maxPriorityFeePerGas"] == 2_000_000_000


async def test_invalid_timings_are_rejected() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    for over in ({"receipt_timeout": 0}, {"receipt_timeout": -1}, {"receipt_timeout": float("inf")}, {"poll_interval": 0}, {"poll_interval": float("nan")}):
        args: dict[str, Any] = {"receipt_timeout": 1.0, "poll_interval": 0.1, **over}
        with pytest.raises(MercurifiError) as e:
            TxSender(mf.rpc, 31337, NonceManager(lambda a: _zero()), args["receipt_timeout"], args["poll_interval"], None)
        assert e.value.code == "INVALID_INPUT"
    with pytest.raises(MercurifiError):
        await local_client(local_rpc(), max_priority_fee_per_gas=0)


async def _zero() -> int:
    return 0


async def test_receipt_wait_uses_the_monotonic_budget() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    rpc.receipt_mode = "none"
    slept: list[float] = []

    async def sleep(s: float) -> None:
        slept.append(s)
        import time

        time.sleep(s)

    sender = TxSender(mf.rpc, 31337, mf.nonces, 0.05, 0.02, None, sleep=sleep)
    with pytest.raises(TxDroppedError):
        await sender.send(local_key(OWNER_KEY), req())
    assert slept and all(0 < s <= 0.02 for s in slept) and sum(slept) >= 0.05 - 0.02


async def test_signer_failure_is_redacted_and_chained_to_nothing() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)

    class Bad:
        address = local_key(OWNER_KEY).address

        async def sign_transaction(self, tx: dict[str, Any]) -> bytes:
            raise RuntimeError("kms down at https://kms.example/secret-key-path\nbody")

    with pytest.raises(MercurifiError) as e:
        await mf.sender.send(Bad(), req())
    assert e.value.code == "SIGNER_ERROR" and "kms.example" in str(e.value) and "secret-key-path" not in str(e.value)
    assert e.value.__cause__ is None and e.value.__context__ is None
    assert rpc.sent == []


async def test_private_key_stays_out_of_surfaced_errors() -> None:
    rpc = local_rpc()
    mf = await _client(rpc, receipt_timeout=0.005)
    rpc.receipt_mode = "none"
    with pytest.raises(TxDroppedError) as e:
        await mf.sender.send(local_key(OWNER_KEY), req())
    import traceback

    assert SECRET_KEY not in "".join(traceback.format_exception(e.value)) + repr(e.value)


async def test_malformed_receipt_is_an_rpc_error() -> None:
    rpc = local_rpc()
    mf = await _client(rpc)
    rpc.on("eth_getTransactionReceipt", lambda p: {"status": "0x0"})
    with pytest.raises(MercurifiError) as e:
        await mf.sender.send(local_key(OWNER_KEY), req())
    assert e.value.code == "RPC_ERROR"


async def test_chain_deadline_validates_both_arguments() -> None:
    mf = await _client(local_rpc())
    for args in ((0, 60), (120, 0), (120, True), (120.5, 60), (120, "60")):
        with pytest.raises(MercurifiError) as e:
            await chain_deadline(mf.rpc, *args)
        assert e.value.code == "INVALID_INPUT"


def test_nonce_locks_are_per_event_loop() -> None:
    import asyncio

    async def fetch(address: str) -> int:
        return 3

    manager = NonceManager(fetch)

    async def two() -> list[int]:
        async def fn(n: int) -> int:
            await asyncio.sleep(0.001)
            return n

        return list(await asyncio.gather(manager.with_nonce("0xAb", fn), manager.with_nonce("0xab", fn)))

    for _ in range(2):  # a fresh loop per call, as a sync wrapper using asyncio.run would
        assert asyncio.run(two()) == [3, 4]
        manager.reset("0xab")


def test_nonce_lock_entries_do_not_accumulate_across_loops() -> None:
    import asyncio
    import gc

    async def fetch(address: str) -> int:
        return 0

    manager = NonceManager(fetch)

    async def contended() -> None:
        async def fn(n: int) -> int:
            await asyncio.sleep(0.001)
            return n

        await asyncio.gather(*(manager.with_nonce("0xab", fn) for _ in range(3)))

    for _ in range(50):
        asyncio.run(contended())
    gc.collect()
    assert len(manager._locks) <= 1
    asyncio.run(contended())  # one more access prunes everything closed
    gc.collect()
    assert len(manager._locks) <= 1
