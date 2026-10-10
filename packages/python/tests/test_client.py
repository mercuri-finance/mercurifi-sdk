import asyncio
import json
import logging
import pickle
import subprocess
import sys
import traceback
from typing import Any

import httpx
import pytest
from eth_utils.crypto import keccak

from mercurifi.abi import AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY
from mercurifi.client import create_client
from mercurifi.errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError
from mercurifi.networks import MAINNET, NETWORKS, TESTNET, is_loopback_url, local_network
from mercurifi.redact import RedactingFilter, redact_url, redact_urls_in
from mercurifi.rpc import Rpc, RpcError

from .helpers import REGISTRY, TESTNET_CODE, A, MockRpc, local_client, local_json, local_rpc, pinned_testnet_rpc

LOCAL = "http://127.0.0.1:8545"
BAD_HASH = "0x" + keccak(b"\x00").hex()


async def test_testnet_verifies_the_pinned_agent_deployment() -> None:
    rpc = pinned_testnet_rpc()
    mf = await create_client("testnet", rpc_transport=rpc.transport(), api=None)
    assert mf.network.chain_id == 5042002
    assert mf.require_agents() is TESTNET.agents
    assert [p[0].lower() for p in rpc.methods("eth_getCode")] == [TESTNET_CODE[k]["address"].lower() for k in ("factory", "implementation", "registry")]


async def test_pins_the_live_testnet_runtime_code() -> None:
    agents = TESTNET.agents
    assert agents is not None
    assert "0x" + keccak(hexstr=TESTNET_CODE["factory"]["code"]).hex() == agents.factory_code_hash
    assert "0x" + keccak(hexstr=TESTNET_CODE["implementation"]["code"]).hex() == agents.implementation_code_hash
    assert "0x" + keccak(hexstr=TESTNET_CODE["registry"]["code"]).hex() == agents.registry_code_hash
    tampered = pinned_testnet_rpc()
    tampered.codes[agents.implementation.lower()] = TESTNET_CODE["implementation"]["code"][:-2] + "00"
    with pytest.raises(NetworkMismatchError, match="implementation .* code hash"):
        await create_client("testnet", rpc_transport=tampered.transport(), api=None)
    with pytest.raises(NetworkMismatchError):
        await create_client("testnet", rpc_transport=MockRpc(TESTNET.chain_id).transport(), api=None)


async def test_mainnet_has_no_agent_deployment() -> None:
    assert MAINNET.agents is None
    mf = await create_client("mainnet", rpc_url="https://rpc.example", rpc_transport=MockRpc(MAINNET.chain_id).transport(), api=None)
    with pytest.raises(NotDeployedError):
        mf.require_agents()


async def test_refuses_other_network() -> None:
    with pytest.raises(NetworkMismatchError, match=r"chain 5042\b.*5042002"):
        await create_client("testnet", rpc_transport=MockRpc(5042).transport(), api=None)


async def test_mainnet_needs_rpc_url() -> None:
    with pytest.raises(InvalidInputError):
        await create_client("mainnet", api=None)


async def test_verifies_factory_implementation_and_registry_code_hashes() -> None:
    mf = await local_client(local_rpc())
    assert mf.require_agents().factory == A(9)
    assert mf.require_agents().registry == REGISTRY
    bad = local_network(local_json(agentFactoryCodeHash=BAD_HASH))
    with pytest.raises(NetworkMismatchError, match="code hash"):
        await create_client(bad, rpc_url=LOCAL, rpc_transport=local_rpc().transport(), api=None)
    bad_registry = local_network(local_json(agentRegistryCodeHash=BAD_HASH))
    with pytest.raises(NetworkMismatchError, match=r"policy registry .* code hash"):
        await create_client(bad_registry, rpc_url=LOCAL, rpc_transport=local_rpc().transport(), api=None)


async def test_refuses_a_factory_whose_implementation_is_not_pinned() -> None:
    rpc = local_rpc().read(A(9), AGENT_ACCOUNT_FACTORY, "implementation", A(11))
    with pytest.raises(NetworkMismatchError, match="implementation"):
        await local_client(rpc)


async def test_refuses_another_registry_and_a_registry_of_another_factory() -> None:
    other = local_rpc().read(A(9), AGENT_ACCOUNT_FACTORY, "registry", A(13))
    with pytest.raises(NetworkMismatchError, match="reports registry"):
        await local_client(other)
    foreign = local_rpc().read(REGISTRY, AGENT_POLICY_REGISTRY, "FACTORY", A(14))
    with pytest.raises(NetworkMismatchError, match="belongs to factory"):
        await local_client(foreign)


async def test_custom_books_only_local_loopback() -> None:
    with pytest.raises(NetworkMismatchError):
        local_network(local_json(chainId=5042))
    with pytest.raises(NetworkMismatchError, match="loopback"):
        await create_client(local_network(local_json()), rpc_url="https://rpc.example.org", rpc_transport=local_rpc().transport(), api=None)


async def test_api_key_network() -> None:
    with pytest.raises(NetworkMismatchError, match="other network"):
        await create_client("testnet", api_key="mfk_live_x", rpc_transport=pinned_testnet_rpc().transport(), api=None)


async def test_mock_filters_logs_by_address_and_positional_topics() -> None:
    rpc = MockRpc(31337)

    def t(n: int) -> str:
        return "0x" + format(n, "064x")

    rpc.logs = [
        {"address": REGISTRY, "topics": [t(1), t(0xAA)], "data": "0x"},
        {"address": REGISTRY, "topics": [t(2), t(0xBB)], "data": "0x"},
        {"address": A(9), "topics": [t(1), t(0xAA)], "data": "0x"},
    ]
    client = Rpc(LOCAL, transport=rpc.transport())
    assert len(await client.get_logs(REGISTRY, 0, 10, topics=[None, t(0xAA)])) == 1
    assert len(await client.get_logs(REGISTRY, 0, 10)) == 2
    assert rpc.methods("eth_getLogs")[0][0]["topics"] == [None, t(0xAA)]
    assert "topics" not in rpc.methods("eth_getLogs")[1][0]
    await client.aclose()


async def test_does_not_resolve_inherited_names_as_networks() -> None:
    for name in ("constructor", "__class__", "__getitem__", "get", "keys", "items", ""):
        with pytest.raises(InvalidInputError):
            await create_client(name, api=None)
    with pytest.raises(InvalidInputError):
        await create_client(5042, api=None)  # type: ignore[arg-type]


async def test_pinned_books_have_no_invented_agent_addresses() -> None:
    # Testnet carries the recorded deployment (checked against the live code above); mainnet has none.
    assert MAINNET.agents is None and TESTNET.agents is not None
    assert TESTNET.agents.deploy_block == 66495930
    assert MAINNET.default_rpc_url is None  # no default third-party RPC on mainnet
    assert "alchemy" not in repr(TESTNET).lower()
    with pytest.raises(TypeError):
        NETWORKS["x"] = TESTNET  # type: ignore[index]


async def test_rejects_malformed_rpc_url() -> None:
    transport = pinned_testnet_rpc().transport()
    for url in ("not a url", "", "ftp://host", "http://", "http://host:99999", "://x"):
        with pytest.raises(InvalidInputError) as info:
            await create_client("testnet", rpc_url=url, rpc_transport=transport, api=None)
        assert info.value.field == "rpc_url"


async def test_blank_api_key_has_its_own_message() -> None:
    transport = pinned_testnet_rpc().transport()
    for key in ("", "  ", "\t\r\n"):
        with pytest.raises(InvalidInputError, match="api_key is empty"):
            await create_client("testnet", api_key=key, rpc_transport=transport, api=None)
    with pytest.raises(NetworkMismatchError, match="other network"):
        await create_client("mainnet", api_key="mfk_test_x", rpc_url="https://rpc.example.org", rpc_transport=MockRpc(5042).transport(), api=None)


async def test_api_key_is_redacted_in_repr_and_not_picklable() -> None:
    mf = await create_client("testnet", api_key="mfk_test_SECRETKEY", rpc_transport=pinned_testnet_rpc().transport(), api=None)
    assert mf.settings.api_key == "mfk_test_SECRETKEY"
    for text in (repr(mf.settings), str(mf.settings), repr(mf)):
        assert "SECRETKEY" not in text and "mfk_test_" not in text
    assert "[redacted]" in repr(mf.settings)
    with pytest.raises(TypeError):
        pickle.dumps(mf.settings)
    await mf.aclose()


async def test_rpc_errors_show_only_the_host() -> None:
    secret = "https://user:pw@rpc.example.org/v2/SECRETKEY123?k=SECRETKEY123"

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"all connection attempts failed for {secret}", request=request)

    err: BaseException | None = None
    try:
        await create_client("mainnet", rpc_url=secret, rpc_transport=httpx.MockTransport(boom), api=None)
    except BaseException as exc:
        err = exc
    assert isinstance(err, MercurifiError) and err.code == "RPC_ERROR"
    text = "".join(traceback.format_exception(err)) + repr(err) + repr(err.__cause__) + repr(err.__context__)
    assert "SECRETKEY123" not in text and "pw@" not in text
    assert "rpc.example.org" in str(err)


async def test_http_status_and_non_json_and_node_errors_are_redacted() -> None:
    url = "https://rpc.example.org/KEYKEY"
    for handler in (
        lambda r: httpx.Response(502, text="bad gateway https://rpc.example.org/KEYKEY"),
        lambda r: httpx.Response(200, text="<html>https://rpc.example.org/KEYKEY</html>"),
        lambda r: httpx.Response(200, json=[1]),
        lambda r: httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "limit on https://rpc.example.org/KEYKEY\nmore"}}),
        lambda r: httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": "nonsense"}),
    ):
        with pytest.raises(MercurifiError) as info:
            await create_client("mainnet", rpc_url=url, rpc_transport=httpx.MockTransport(handler), api=None)
        assert "KEYKEY" not in str(info.value) and "KEYKEY" not in repr(info.value)
        assert "rpc.example.org" in str(info.value)


async def test_rpc_error_carries_code_and_revert_data() -> None:
    rpc = local_rpc().revert(A(9), AGENT_ACCOUNT_FACTORY, "implementation", "0xdeadbeef")
    client = Rpc(LOCAL, transport=rpc.transport())
    with pytest.raises(RpcError) as info:
        await client.call(A(9), AGENT_ACCOUNT_FACTORY.encode("implementation"))
    assert info.value.code == 3 and info.value.data == "0xdeadbeef"
    await client.aclose()


async def test_verify_false_only_for_the_local_book_with_a_loopback_rpc() -> None:
    warnings: list[str] = []
    # Local: skipped (the wrong-chain RPC is not noticed), no warning.
    wrong = MockRpc(1)
    mf = await create_client(local_network(local_json()), rpc_url=LOCAL, rpc_transport=wrong.transport(), verify=False, on_warning=warnings.append, api=None)
    assert wrong.calls == [] and warnings == []
    await mf.aclose()
    # Arc: ignored with a warning, the chain check still runs.
    with pytest.raises(NetworkMismatchError):
        await create_client("testnet", rpc_transport=MockRpc(1).transport(), verify=False, on_warning=warnings.append, api=None)
    assert len(warnings) == 1 and "ignored" in warnings[0]
    # Local book with a non-loopback RPC is refused whatever verify says.
    with pytest.raises(NetworkMismatchError, match="loopback"):
        await create_client(local_network(local_json()), rpc_url="https://rpc.example.org", rpc_transport=wrong.transport(), verify=False, api=None)
    # A spoofed local name on another chain is refused.
    with pytest.raises(NetworkMismatchError, match="31337"):
        from dataclasses import replace

        await create_client(replace(TESTNET, name="local"), rpc_url=LOCAL, rpc_transport=local_rpc().transport(), api=None)


async def test_option_validation() -> None:
    transport = pinned_testnet_rpc().transport()
    bad: list[dict[str, Any]] = [
        {"deadline_seconds": 0}, {"deadline_seconds": 601}, {"deadline_seconds": True}, {"deadline_seconds": 1.5},
        {"receipt_timeout": 0}, {"receipt_timeout": True}, {"poll_interval": -1}, {"poll_interval": float("nan")},
        {"max_fee_per_gas_cap": 0}, {"max_fee_per_gas_cap": 1.5}, {"api_base_url": "http://api.example.org"},
        {"api_base_url": "nonsense"},
    ]
    for opts in bad:
        with pytest.raises(InvalidInputError):
            await create_client("testnet", rpc_transport=transport, api=None, **opts)
    mf = await create_client("testnet", rpc_transport=transport, api=None, api_base_url="https://api.example.org")
    assert mf.api_base_url == "https://api.example.org"
    mf2 = await create_client("testnet", rpc_transport=transport, api=None)
    assert mf2.api_base_url == TESTNET.api_base_url


async def test_local_book_requires_every_key() -> None:
    book = local_json()
    del book["agentRegistry"]
    with pytest.raises(InvalidInputError, match="agentRegistry"):
        local_network(book)
    with pytest.raises(NetworkMismatchError):
        local_network(local_json(chainId=True))


async def test_loopback_urls_and_redaction_helpers() -> None:
    assert is_loopback_url("http://127.0.0.1:8545") and is_loopback_url("http://[::1]:8545") and is_loopback_url("http://localhost")
    assert not is_loopback_url("http://127.0.0.1.evil.org") and not is_loopback_url("not a url")
    assert redact_urls_in("GET https://a.b/c/KEY failed, see http://x.y:8080/z?q=1") == "GET a.b failed, see x.y:8080"
    assert redact_url("nonsense") == "invalid URL"
    assert redact_urls_in("a ftp://f.g/KEY b javascript:x") == "a f.g b invalid URL"


async def test_async_context_manager_closes() -> None:
    async with await local_client(local_rpc()) as mf:
        assert mf.network.name == "local"


KEY_URL = "https://rpc.example.org/v2/SECRETKEY123"


def _ok(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "0x1"})


async def test_httpx_and_httpcore_logs_never_show_the_key(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    before = {n: logging.getLogger(n).level for n in ("httpx", "httpcore")}
    rpc = Rpc(KEY_URL, transport=httpx.MockTransport(_ok))
    Rpc(KEY_URL, transport=httpx.MockTransport(_ok))  # a second client must not add a second filter
    await rpc.request("eth_chainId", [])
    # httpcore only logs on real sockets, so also push a record through its loggers the way it would.
    logging.getLogger("httpcore.connection").debug("connect to %s", KEY_URL)
    logging.getLogger("httpcore").debug("GET %s", KEY_URL)
    await rpc.aclose()
    assert any("rpc.example.org" in r.getMessage() for r in caplog.records)
    assert "SECRETKEY123" not in caplog.text
    assert "SECRETKEY123" not in "".join(r.getMessage() for r in caplog.records)
    for name in ("httpx", "httpcore", "httpcore.connection"):
        assert sum(isinstance(f, RedactingFilter) for f in logging.getLogger(name).filters) == 1
    assert {n: logging.getLogger(n).level for n in before} == before


async def test_rejects_loose_json_rpc_responses() -> None:
    def respond(**over: object) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            doc: dict[str, object] = {"jsonrpc": "2.0", "id": body["id"], "result": "0x1"}
            doc.update(over)
            return httpx.Response(200, json={k: v for k, v in doc.items() if v is not _MISSING})

        return httpx.MockTransport(handler)

    cases: list[dict[str, object]] = [
        {"jsonrpc": "1.0"}, {"jsonrpc": _MISSING}, {"id": 999}, {"id": _MISSING}, {"id": True}, {"result": _MISSING},
    ]
    for over in cases:
        rpc = Rpc(KEY_URL, transport=respond(**over))
        with pytest.raises(MercurifiError) as info:
            await rpc.request("eth_chainId", [])
        assert info.value.code == "RPC_ERROR" and "SECRETKEY123" not in str(info.value), over
        await rpc.aclose()
    for status in (199, 300, 404, 500):
        rpc = Rpc(KEY_URL, transport=httpx.MockTransport(lambda r, s=status: httpx.Response(s, json={"jsonrpc": "2.0", "id": 1, "result": "0x1"})))
        with pytest.raises(MercurifiError, match=f"HTTP {status}"):
            await rpc.request("eth_chainId", [])
        await rpc.aclose()
    good = Rpc(KEY_URL, transport=respond())
    assert await good.chain_id() == 1
    await good.aclose()


_MISSING = object()


async def test_response_size_cap() -> None:
    big = "0x" + "00" * 5_000
    streamed = httpx.MockTransport(lambda r: httpx.Response(200, content=b'{"jsonrpc":"2.0","id":1,"result":"' + big.encode() + b'"}'))
    small = Rpc(KEY_URL, transport=streamed, max_response_bytes=1_000)
    with pytest.raises(MercurifiError, match="larger than 1000 bytes") as info:
        await small.request("eth_getCode", [])
    assert info.value.code == "RPC_ERROR"
    await small.aclose()
    declared = httpx.MockTransport(lambda r: httpx.Response(200, headers={"content-length": "999999999"}, content=b"{}"))
    other = Rpc(KEY_URL, transport=declared, max_response_bytes=1_000)
    with pytest.raises(MercurifiError, match="larger than"):
        await other.request("eth_chainId", [])
    await other.aclose()
    roomy = Rpc(KEY_URL, transport=streamed)
    assert await roomy.request("eth_getCode", []) == big
    await roomy.aclose()


async def test_unexpected_exceptions_are_redacted_after_startup_too() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise RuntimeError(f"bug while calling {KEY_URL}")

    rpc = Rpc(KEY_URL, transport=httpx.MockTransport(boom))
    with pytest.raises(MercurifiError) as info:
        await rpc.block_number()
    text = "".join(traceback.format_exception(info.value)) + repr(info.value.__context__)
    assert "SECRETKEY123" not in text and info.value.code == "RPC_ERROR"
    await rpc.aclose()


async def test_url_checks_reject_backslash_control_chars_and_port_zero() -> None:
    transport = MockRpc(31337).transport()
    assert not is_loopback_url("http://evil.com\\@127.0.0.1")
    assert not is_loopback_url("http://127.0.0.1\n.evil.com") and not is_loopback_url("http://127.0.0.1:0")
    with pytest.raises(InvalidInputError):
        await create_client(local_network(local_json()), rpc_url="http://evil.com\\@127.0.0.1", rpc_transport=transport, api=None)
    for url in ("http://evil.com\\@127.0.0.1", "https://host/a\tb", "http://host:0", "https://rpc.example.org/\x00"):
        with pytest.raises(InvalidInputError):
            await create_client("testnet", rpc_url=url, rpc_transport=transport, api=None)


async def test_local_book_api_fields_are_validated() -> None:
    from dataclasses import replace

    transport = local_rpc().transport()
    book = local_network(local_json())
    for bad in (replace(book, api_base_url="http://api.example.org"), replace(book, api_base_url="nonsense")):
        with pytest.raises(InvalidInputError):
            await create_client(bad, rpc_url=LOCAL, rpc_transport=transport, api=None)
    with pytest.raises(InvalidInputError):
        await create_client(replace(book, api_key_prefix="x_"), rpc_url=LOCAL, rpc_transport=transport, api=None)
    ok = await create_client(replace(book, api_base_url="http://127.0.0.1:9000"), rpc_url=LOCAL, rpc_transport=local_rpc().transport(), api=None)
    await ok.aclose()


async def test_concurrent_requests_each_check_their_own_id() -> None:
    gate = asyncio.Event()
    seen: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body["id"])
        if len(seen) == 2:
            gate.set()
        await gate.wait()  # both requests are in flight before either answers
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": hex(body["id"])})

    rpc = Rpc(LOCAL, transport=httpx.MockTransport(handler))
    a, b = await asyncio.gather(rpc.request("eth_chainId", []), rpc.request("eth_chainId", []))
    await rpc.aclose()
    assert sorted([a, b]) == ["0x1", "0x2"]


def test_log_redaction_is_installed_at_package_import() -> None:
    code = (
        "import logging, mercurifi\n"
        "from mercurifi.redact import RedactingFilter\n"
        "print(all(any(isinstance(f, RedactingFilter) for f in logging.getLogger(n).filters) for n in ('httpx', 'httpcore')))"
    )
    out = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "True"


async def test_reads_the_head_block_fresh_every_time() -> None:
    """Parity guard with the TypeScript client's viem setting (cacheTime 0): head reads pin later reads, so a cached head right after the
    caller's own transaction would miss it (a just-launched token, a just-queued item). Every call must reach the node."""
    head = 100
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal head
        body = json.loads(request.content)
        calls.append(body["method"])
        head += 1  # the chain moves between any two reads
        if body["method"] == "eth_blockNumber":
            result: Any = hex(head)
        else:
            result = {"number": hex(head), "timestamp": hex(1_000 + head)}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    rpc = Rpc(LOCAL, transport=httpx.MockTransport(handler))
    numbers = [await rpc.block_number() for _ in range(3)]
    blocks = [await rpc.latest_block() for _ in range(2)]
    stamps = [await rpc.latest_timestamp() for _ in range(2)]
    await rpc.aclose()
    assert numbers == [101, 102, 103]
    assert blocks == [(104, 1_104), (105, 1_105)]
    assert stamps == [1_106, 1_107]
    assert calls == ["eth_blockNumber"] * 3 + ["eth_getBlockByNumber"] * 4
