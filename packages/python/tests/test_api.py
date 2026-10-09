import asyncio
import copy
import json
import logging
import pickle
from typing import Any

import httpx
import pytest

from mercurifi.agent import ImageUpload
from mercurifi.api import MAX_BODY_BYTES, HttpApi
from mercurifi.client import create_client
from mercurifi.errors import ApiError, InvalidInputError, MercurifiError

from .helpers import MockRpc

ADDR = "0x00000000000000000000000000000000000000AA"
LOWER = ADDR.lower()
KEY = "mfk_test_supersecret"


def transport(status: int, body: object, headers: dict[str, str] | None = None, seen: list[httpx.Request] | None = None) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, content=b"" if body is None and status != 200 else json.dumps(body).encode(), headers=headers or {})
    return httpx.MockTransport(handle)


def scripted(*responses: httpx.Response, seen: list[httpx.Request]) -> httpx.MockTransport:
    queue = list(responses)

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return queue.pop(0)
    return httpx.MockTransport(handle)


def keyed(t: httpx.AsyncBaseTransport, **over: Any) -> HttpApi:
    return HttpApi("https://x.example", 1, api_key=KEY, transport=t, **over)


async def test_key_header_and_lowercase_path() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi("https://testnet-launch-api.mercuri.finance/", 5042002, api_key="mfk_test_k", transport=transport(200, {"account": ADDR}, seen=seen))
    await api.get_account(ADDR)
    assert str(seen[0].url) == f"https://testnet-launch-api.mercuri.finance/v1/agent-accounts/{LOWER}"
    assert seen[0].headers["X-Api-Key"] == "mfk_test_k"
    assert "authorization" not in seen[0].headers


async def test_live_reads_only_when_asked() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi("https://x.example", 1, api_key="mfk_test_k", transport=transport(200, {"account": ADDR, "live": {"asOfBlock": 100}}, seen=seen))
    await api.get_account(ADDR, live=True)
    assert str(seen[0].url) == f"https://x.example/v1/agent-accounts/{LOWER}?live=1"


async def test_list_pages_from_array_and_next_cursor_header() -> None:
    seen: list[httpx.Request] = []
    t = scripted(
        httpx.Response(200, json=[{"id": "12-0", "action": "buy"}], headers={"Next-Cursor": "c1"}),
        httpx.Response(200, json=[{"id": "10-0", "action": "sell"}]),
        seen=seen,
    )
    api = HttpApi("https://x.example", 1, transport=t)
    assert await api.list_actions(ADDR) == {"items": [{"id": "12-0", "action": "buy"}], "nextCursor": "c1"}
    second = await api.list_actions(ADDR, "c1")
    assert str(seen[1].url) == f"https://x.example/v1/agent-accounts/{LOWER}/actions?cursor=c1"
    assert second["nextCursor"] is None


async def test_owner_accounts_are_an_array_of_summaries() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi("https://x.example", 1, transport=transport(200, [{"account": LOWER, "owner": LOWER, "activeAgents": 1}], seen=seen))
    assert await api.list_accounts(ADDR) == [{"account": LOWER, "owner": LOWER, "activeAgents": 1}]
    assert str(seen[0].url) == f"https://x.example/v1/agent-accounts?owner={LOWER}"


async def test_quote_and_build_bodies_follow_the_api_wire() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi("https://x.example", 1, api_key="mfk_test_k", transport=transport(200, {"advisory": True, "asOfBlock": 7}, seen=seen))
    await api.quote("curve-buy", {"token": LOWER, "usdcIn": "25000000"})
    assert str(seen[0].url) == "https://x.example/v1/quote/curve-buy" and seen[0].method == "POST"
    assert json.loads(seen[0].content) == {"token": LOWER, "usdcIn": "25000000"}
    await api.quote("pool-swap", {"token": LOWER, "buyToken": True, "amountIn": "1000000", "account": LOWER})
    assert json.loads(seen[1].content) == {"token": LOWER, "buyToken": True, "amountIn": "1000000", "account": LOWER}
    body = {"account": LOWER, "function": "buy", "args": {"token": LOWER, "usdcIn": "25000000", "minTokensOut": "1", "deadline": "1800000060"}}
    built = {"chainId": 1, "to": LOWER, "data": "0x12345678", "value": "0", "function": "buy", "selector": "0x12345678"}
    api2 = HttpApi("https://x.example", 1, api_key="mfk_test_k", transport=transport(200, built, seen=seen))
    assert await api2.build_tx(body) == built
    assert str(seen[2].url) == "https://x.example/v1/tx/build"
    assert json.loads(seen[2].content) == body


async def test_error_mapping_and_null_token() -> None:
    api = HttpApi("https://x.example", 1, transport=transport(429, {"error": {"code": "rate_limited", "message": "slow down"}}, {"Retry-After": "5"}))
    with pytest.raises(ApiError) as e:
        await api.get_account(ADDR)
    assert (e.value.status, e.value.api_code, e.value.retry_after_seconds, str(e.value)) == (429, "rate_limited", 5.0, "slow down")
    assert await HttpApi("https://x.example", 1, transport=transport(200, None)).get_token(ADDR) is None


async def test_multipart_upload() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi("https://x.example", 1, transport=transport(200, {"sha256": "a" * 64, "metadataURI": "https://x.example/m/a.json", "status": "clean"}, seen=seen))
    res = await api.upload_launch_metadata({"description": "hi"})
    assert str(seen[0].url) == "https://x.example/v1/uploads/launch-metadata"
    assert res == {"metadataURI": "https://x.example/m/a.json", "imageStatus": None}
    assert b'name="metadata"' in seen[0].content and b'{"description": "hi"}' in seen[0].content
    review = HttpApi("https://x.example", 1, transport=transport(200, {"sha256": "b" * 64, "metadataURI": "https://x.example/m/b.json", "status": "clean", "imageStatus": "review"}))
    assert (await review.upload_launch_metadata({}))["imageStatus"] == "review"
    with_image = HttpApi("https://x.example", 1, transport=transport(200, {"metadataURI": "https://x.example/m/c.json"}, seen=seen))
    await with_image.upload_launch_metadata({}, ImageUpload(b"\x89PNG", "image/png"))
    assert b'name="file"; filename="image.png"' in seen[-1].content
    with pytest.raises(InvalidInputError, match="image"):
        await with_image.upload_launch_metadata({}, ImageUpload(b"x", "image/gif"))  # type: ignore[arg-type]


async def test_https_only_and_default_api() -> None:
    with pytest.raises(Exception, match="https"):
        HttpApi("http://api.example", 1)
    HttpApi("http://127.0.0.1:8080", 1)  # loopback is allowed
    mf = await create_client("testnet", rpc_transport=MockRpc(5042002).transport())
    assert isinstance(mf.api, HttpApi) and mf.api.base_url == "https://testnet-launch-api.mercuri.finance"
    off = await create_client("testnet", api=None, rpc_transport=MockRpc(5042002).transport())
    assert off.api is None


# ------------------------------------------------------------------ hardening (parity with the TypeScript HttpApi tests)

async def test_key_is_held_privately() -> None:
    api = keyed(transport(200, {}))
    for text in (repr(api), str(api), repr(vars(api)), repr(api.__dict__)):
        assert KEY not in text
    assert "[redacted]" in repr(api)
    with pytest.raises(TypeError):
        pickle.dumps(api)
    with pytest.raises(TypeError):
        pickle.dumps(vars(api)["_key"])
    with pytest.raises(TypeError):
        copy.deepcopy(vars(api)["_key"])
    mf = await create_client("testnet", api_key="mfk_test_clientsecret", rpc_transport=MockRpc(5042002).transport())
    for text in (repr(mf), repr(mf.api), repr(mf.settings), repr(vars(mf.api))):
        assert "clientsecret" not in text


async def test_redirects_are_refused_and_never_followed() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"Location": "https://evil.example/steal"})
    with pytest.raises(ApiError) as e:
        await keyed(httpx.MockTransport(handle)).get_account(ADDR)
    assert e.value.api_code == "redirect" and len(seen) == 1
    assert "evil.example" not in str(e.value)


@pytest.mark.parametrize("base", ["https://u:p@x.example", "https://x.example/?k=1", "https://x.example/#f", "not a url", "ftp://x.example",
                                  "https://x.example\\@127.0.0.1", "", "http://x.example", "https://x.example/?"])
def test_hostile_base_urls_are_refused(base: str) -> None:
    with pytest.raises(InvalidInputError):
        HttpApi(base, 1)


def test_other_constructor_inputs_are_checked() -> None:
    for chain in (0, -1, True, "1"):
        with pytest.raises(InvalidInputError):
            HttpApi("https://x.example", chain)  # type: ignore[arg-type]
    for key in ("", "  ", 5):
        with pytest.raises(InvalidInputError):
            HttpApi("https://x.example", 1, api_key=key)  # type: ignore[arg-type]
    for timeout in (0, -1, True, float("inf"), float("nan"), "5"):
        with pytest.raises(InvalidInputError):
            HttpApi("https://x.example", 1, timeout=timeout)  # type: ignore[arg-type]
    assert HttpApi("https://x.example/base/", 1).base_url == "https://x.example/base"


async def test_hostile_parameters_fail_before_any_request() -> None:
    seen: list[httpx.Request] = []
    api = keyed(transport(200, {}, seen=seen))
    with pytest.raises(InvalidInputError):
        await api.get_account("../../admin")
    with pytest.raises(InvalidInputError):
        await api.get_account(5)  # type: ignore[arg-type]
    for cursor in ("a&b=c", "x" * 300, "", "ok\n", 5):
        with pytest.raises(InvalidInputError):
            await api.list_actions(ADDR, cursor)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError):
        await api.quote("curve-buy/../x", {})
    with pytest.raises(InvalidInputError):
        await api.list_accounts("nope")
    assert seen == []


async def test_response_shapes_are_validated() -> None:
    def wrong(body: object, headers: dict[str, str] | None = None) -> HttpApi:
        return keyed(transport(200, body, headers))

    bad_token = "0x00000000000000000000000000000000000000bb"
    cases: list[Any] = [
        wrong({"account": bad_token}).get_account(ADDR), wrong([]).get_account(ADDR), wrong({"account": ADDR, "owner": "nope"}).get_account(ADDR),
        wrong({}).list_accounts(ADDR), wrong([{"account": "nope"}]).list_accounts(ADDR),
        wrong([{"id": 1}]).list_actions(ADDR), wrong([{"id": "a", "token": "nope"}]).list_actions(ADDR),
        wrong({"advisory": False}).quote("curve-buy", {}), wrong([]).quote("curve-buy", {}),
        wrong({"chainId": 1, "to": LOWER, "data": "nothex", "value": "0"}).build_tx({}),
        wrong({"chainId": 1, "to": LOWER, "data": "0x00", "value": "-1"}).build_tx({}),
        wrong({"chainId": True, "to": LOWER, "data": "0x00", "value": "0"}).build_tx({}),
        wrong({"chainId": 1, "to": LOWER, "data": "0x00", "value": 0}).build_tx({}),
        wrong({"chainId": 1, "to": LOWER, "data": "0x00", "value": "0", "selector": "0x12"}).build_tx({}),
        wrong({"metadataURI": 5}).upload_launch_metadata({}),
        wrong({"metadataURI": "ipfs://m", "imageStatus": "weird"}).upload_launch_metadata({}),
        wrong({"address": bad_token}).get_token(ADDR), wrong([]).get_token(ADDR),
    ]
    for case in cases:
        with pytest.raises(MercurifiError) as e:
            await case
        assert e.value.code == "API_BAD_RESPONSE"


async def test_list_size_and_cursor_bounds() -> None:
    many = [{"id": str(i)} for i in range(1_001)]
    for t in (transport(200, many), transport(200, [], {"Next-Cursor": "bad cursor!"}), transport(200, [], {"Next-Cursor": "x" * 300})):
        with pytest.raises(MercurifiError) as e:
            await keyed(t).list_actions(ADDR)
        assert e.value.code == "API_BAD_RESPONSE"
    with pytest.raises(MercurifiError, match="did not advance"):
        await keyed(transport(200, [], {"Next-Cursor": "c1"})).list_actions(ADDR, "c1")


async def test_oversized_bodies_are_refused() -> None:
    big = httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * (MAX_BODY_BYTES + 1)))
    with pytest.raises(MercurifiError) as e:
        await keyed(big).get_account(ADDR)
    assert e.value.code == "API_BAD_RESPONSE"
    declared = httpx.MockTransport(lambda r: httpx.Response(200, content=b"{}", headers={"Content-Length": str(99 * 1024 * 1024)}))
    with pytest.raises(MercurifiError) as e2:
        await keyed(declared).get_account(ADDR)
    assert e2.value.code == "API_BAD_RESPONSE"


async def test_timeout_and_redacted_errors() -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200)
    with pytest.raises(ApiError) as t:
        await keyed(httpx.MockTransport(hang), timeout=0.05).get_account(ADDR)
    assert (t.value.status, t.value.api_code) == (0, "timeout")

    def leaky(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connect failed https://x.example/v1/secret-path?key=abc\nsecond line")
    with pytest.raises(ApiError) as n:
        await keyed(httpx.MockTransport(leaky)).get_account(ADDR)
    assert n.value.api_code == "network"
    assert n.value.__cause__ is None and n.value.__context__ is None
    for bit in ("secret-path", "key=abc", "second line", KEY):
        assert bit not in str(n.value)

    hostile = transport(500, {"error": {"code": "bad code!", "message": "see https://evil.example/p?token=1‮ now\x1b[31m"}})
    with pytest.raises(ApiError) as h:
        await keyed(hostile).get_account(ADDR)
    assert h.value.api_code == "http_error"
    for bit in ("token=1", "‮", "/p", "\x1b"):
        assert bit not in str(h.value)
    junk = httpx.MockTransport(lambda r: httpx.Response(502, content=b"<html>bad gateway</html>"))
    with pytest.raises(ApiError, match="HTTP 502"):
        await keyed(junk).get_account(ADDR)
    nan = httpx.MockTransport(lambda r: httpx.Response(200, content=b'{"account": NaN}'))
    with pytest.raises(MercurifiError):
        await keyed(nan).get_account(ADDR)


async def test_retry_after_is_bounded_and_parsed_strictly() -> None:
    for header, want in (("5", 5.0), ("99999", 3600.0), ("-1", None), ("abc", None), ("nan", None), ("1e9", None), ("", None)):
        with pytest.raises(ApiError) as e:
            await keyed(transport(429, {}, {"Retry-After": header})).get_account(ADDR)
        assert e.value.retry_after_seconds == want


async def test_client_builds_with_an_explicit_base_url() -> None:
    mf = await create_client("testnet", api_base_url="https://api.example.org/", rpc_transport=MockRpc(5042002).transport())
    assert mf.api is not None and mf.api.base_url == "https://api.example.org"
    with pytest.raises(InvalidInputError, match="https"):
        await create_client("testnet", api_base_url="http://api.example.org", rpc_transport=MockRpc(5042002).transport())


async def test_list_accounts_follows_cursors_and_warns_when_truncated() -> None:
    item = {"account": LOWER, "owner": LOWER}
    seen: list[httpx.Request] = []
    t = scripted(httpx.Response(200, json=[item], headers={"Next-Cursor": "c1"}), httpx.Response(200, json=[item]), seen=seen)
    assert len(await HttpApi("https://x.example", 1, transport=t).list_accounts(ADDR)) == 2
    assert str(seen[1].url) == f"https://x.example/v1/agent-accounts?owner={LOWER}&cursor=c1"
    counter = {"n": 0}

    def endless(request: httpx.Request) -> httpx.Response:
        counter["n"] += 1
        return httpx.Response(200, json=[item], headers={"Next-Cursor": f"c{counter['n']}"})
    warnings: list[str] = []
    out = await HttpApi("https://x.example", 1, transport=httpx.MockTransport(endless), on_warning=warnings.append).list_accounts(ADDR)
    assert len(out) == 10 and counter["n"] == 10
    assert "cut off" in warnings[0]


async def test_stream_request_carries_the_key_for_the_stream_client_only() -> None:
    url, headers = keyed(transport(200, {})).stream_request(["token:0xabc", "a b"])
    assert url == "https://x.example/v1/stream?topics=token%3A0xabc,a%20b"
    assert headers["X-Api-Key"] == KEY


async def test_logs_never_carry_the_key_path(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        await keyed(transport(200, {"account": ADDR})).get_account(ADDR)
    assert KEY not in caplog.text
