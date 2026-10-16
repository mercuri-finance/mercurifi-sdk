import asyncio
import copy
import json
import logging
import pickle
from pathlib import Path
from typing import Any

import httpx
import pytest

from mercurifi.agent import ImageUpload
from mercurifi.api import MAX_BODY_BYTES, HttpApi, check_body
from mercurifi.client import create_client
from mercurifi.errors import ApiError, InvalidInputError, MercurifiError

from .helpers import pinned_testnet_rpc

ADDR = "0x00000000000000000000000000000000000000AA"
LOWER = ADDR.lower()
KEY = "mfk_test_supersecret"


def transport(
    status: int,
    body: object,
    headers: dict[str, str] | None = None,
    seen: list[httpx.Request] | None = None,
) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(
            status,
            content=b"" if body is None and status != 200 else json.dumps(body).encode(),
            headers=headers or {},
        )

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
    api = HttpApi(
        "https://testnet-launch-api.mercuri.finance/",
        5042002,
        api_key="mfk_test_k",
        transport=transport(200, {"account": ADDR}, seen=seen),
    )
    await api.get_account(ADDR)
    assert (
        str(seen[0].url) == f"https://testnet-launch-api.mercuri.finance/v1/agent-accounts/{LOWER}"
    )
    assert seen[0].headers["X-Api-Key"] == "mfk_test_k"
    assert "authorization" not in seen[0].headers


async def test_live_reads_only_when_asked() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi(
        "https://x.example",
        1,
        api_key="mfk_test_k",
        transport=transport(200, {"account": ADDR, "live": {"asOfBlock": 100}}, seen=seen),
    )
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
    assert await api.list_actions(ADDR) == {
        "items": [{"id": "12-0", "action": "buy"}],
        "nextCursor": "c1",
    }
    second = await api.list_actions(ADDR, "c1")
    assert str(seen[1].url) == f"https://x.example/v1/agent-accounts/{LOWER}/actions?cursor=c1"
    assert second["nextCursor"] is None


async def test_owner_accounts_are_an_array_of_summaries() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi(
        "https://x.example",
        1,
        transport=transport(
            200, [{"account": LOWER, "owner": LOWER, "activeAgents": 1}], seen=seen
        ),
    )
    assert await api.list_accounts(ADDR) == [{"account": LOWER, "owner": LOWER, "activeAgents": 1}]
    assert str(seen[0].url) == f"https://x.example/v1/agent-accounts?owner={LOWER}"


async def test_quote_and_build_bodies_follow_the_api_wire() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi(
        "https://x.example",
        1,
        api_key="mfk_test_k",
        transport=transport(200, {"advisory": True, "asOfBlock": 7}, seen=seen),
    )
    await api.quote("curve-buy", {"token": LOWER, "usdcIn": "25000000"})
    assert str(seen[0].url) == "https://x.example/v1/quote/curve-buy" and seen[0].method == "POST"
    assert json.loads(seen[0].content) == {"token": LOWER, "usdcIn": "25000000"}
    await api.quote(
        "pool-swap", {"token": LOWER, "buyToken": True, "amountIn": "1000000", "account": LOWER}
    )
    assert json.loads(seen[1].content) == {
        "token": LOWER,
        "buyToken": True,
        "amountIn": "1000000",
        "account": LOWER,
    }
    body = {
        "account": LOWER,
        "function": "buy",
        "args": {
            "token": LOWER,
            "usdcIn": "25000000",
            "minTokensOut": "1",
            "deadline": "1800000060",
        },
    }
    built = {
        "chainId": 1,
        "to": LOWER,
        "data": "0x12345678",
        "value": "0",
        "function": "buy",
        "selector": "0x12345678",
    }
    api2 = HttpApi(
        "https://x.example", 1, api_key="mfk_test_k", transport=transport(200, built, seen=seen)
    )
    assert await api2.build_tx(body) == built
    assert str(seen[2].url) == "https://x.example/v1/tx/build"
    assert json.loads(seen[2].content) == body


async def test_error_mapping_and_null_token() -> None:
    api = HttpApi(
        "https://x.example",
        1,
        transport=transport(
            429, {"error": {"code": "rate_limited", "message": "slow down"}}, {"Retry-After": "5"}
        ),
    )
    with pytest.raises(ApiError) as e:
        await api.get_account(ADDR)
    assert (e.value.status, e.value.api_code, e.value.retry_after_seconds, str(e.value)) == (
        429,
        "rate_limited",
        5.0,
        "slow down",
    )
    assert (
        await HttpApi("https://x.example", 1, transport=transport(200, None)).get_token(ADDR)
        is None
    )


async def test_multipart_upload() -> None:
    seen: list[httpx.Request] = []
    api = HttpApi(
        "https://x.example",
        1,
        transport=transport(
            200,
            {"sha256": "a" * 64, "metadataURI": "https://x.example/m/a.json", "status": "clean"},
            seen=seen,
        ),
    )
    res = await api.upload_launch_metadata({"description": "hi"})
    assert str(seen[0].url) == "https://x.example/v1/uploads/launch-metadata"
    assert res == {"metadataURI": "https://x.example/m/a.json", "imageStatus": None}
    assert b'name="metadata"' in seen[0].content and b'{"description": "hi"}' in seen[0].content
    review = HttpApi(
        "https://x.example",
        1,
        transport=transport(
            200,
            {
                "sha256": "b" * 64,
                "metadataURI": "https://x.example/m/b.json",
                "status": "clean",
                "imageStatus": "review",
            },
        ),
    )
    assert (await review.upload_launch_metadata({}))["imageStatus"] == "review"
    with_image = HttpApi(
        "https://x.example",
        1,
        transport=transport(200, {"metadataURI": "https://x.example/m/c.json"}, seen=seen),
    )
    await with_image.upload_launch_metadata({}, ImageUpload(b"\x89PNG", "image/png"))
    assert b'name="file"; filename="image.png"' in seen[-1].content
    with pytest.raises(InvalidInputError, match="image"):
        await with_image.upload_launch_metadata({}, ImageUpload(b"x", "image/gif"))  # type: ignore[arg-type]


async def test_https_only_and_default_api() -> None:
    with pytest.raises(Exception, match="https"):
        HttpApi("http://api.example", 1)
    HttpApi("http://127.0.0.1:8080", 1)  # loopback is allowed
    mf = await create_client("testnet", rpc_transport=pinned_testnet_rpc().transport())
    assert (
        isinstance(mf.api, HttpApi)
        and mf.api.base_url == "https://testnet-launch-api.mercuri.finance"
    )
    off = await create_client("testnet", api=None, rpc_transport=pinned_testnet_rpc().transport())
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
    mf = await create_client(
        "testnet", api_key="mfk_test_clientsecret", rpc_transport=pinned_testnet_rpc().transport()
    )
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


@pytest.mark.parametrize(
    "base",
    [
        "https://u:p@x.example",
        "https://x.example/?k=1",
        "https://x.example/#f",
        "not a url",
        "ftp://x.example",
        "https://x.example\\@127.0.0.1",
        "",
        "http://x.example",
        "https://x.example/?",
    ],
)
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
        wrong({"account": bad_token}).get_account(ADDR),
        wrong([]).get_account(ADDR),
        wrong({"account": ADDR, "owner": "nope"}).get_account(ADDR),
        wrong({}).list_accounts(ADDR),
        wrong([{"account": "nope"}]).list_accounts(ADDR),
        wrong([{"id": 1}]).list_actions(ADDR),
        wrong([{"id": "a", "token": "nope"}]).list_actions(ADDR),
        wrong({"advisory": False}).quote("curve-buy", {}),
        wrong([]).quote("curve-buy", {}),
        wrong({"chainId": 1, "to": LOWER, "data": "nothex", "value": "0"}).build_tx({}),
        wrong({"chainId": 1, "to": LOWER, "data": "0x00", "value": "-1"}).build_tx({}),
        wrong({"chainId": True, "to": LOWER, "data": "0x00", "value": "0"}).build_tx({}),
        wrong({"chainId": 1, "to": LOWER, "data": "0x00", "value": 0}).build_tx({}),
        wrong(
            {"chainId": 1, "to": LOWER, "data": "0x00", "value": "0", "selector": "0x12"}
        ).build_tx({}),
        wrong({"metadataURI": 5}).upload_launch_metadata({}),
        wrong({"metadataURI": "ipfs://m", "imageStatus": "weird"}).upload_launch_metadata({}),
        wrong({"address": bad_token}).get_token(ADDR),
        wrong([]).get_token(ADDR),
    ]
    for case in cases:
        with pytest.raises(MercurifiError) as e:
            await case
        assert e.value.code == "API_BAD_RESPONSE"


async def test_list_size_and_cursor_bounds() -> None:
    many = [{"id": str(i)} for i in range(1_001)]
    for t in (
        transport(200, many),
        transport(200, [], {"Next-Cursor": "bad cursor!"}),
        transport(200, [], {"Next-Cursor": "x" * 300}),
    ):
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
    declared = httpx.MockTransport(
        lambda r: httpx.Response(
            200, content=b"{}", headers={"Content-Length": str(99 * 1024 * 1024)}
        )
    )
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
        raise httpx.ConnectError(
            "connect failed https://x.example/v1/secret-path?key=abc\nsecond line"
        )

    with pytest.raises(ApiError) as n:
        await keyed(httpx.MockTransport(leaky)).get_account(ADDR)
    assert n.value.api_code == "network"
    assert n.value.__cause__ is None and n.value.__context__ is None
    for bit in ("secret-path", "key=abc", "second line", KEY):
        assert bit not in str(n.value)

    hostile = transport(
        500,
        {
            "error": {
                "code": "bad code!",
                "message": "see https://evil.example/p?token=1‮ now\x1b[31m",
            }
        },
    )
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
    for header, want in (
        ("5", 5.0),
        ("99999", 3600.0),
        ("-1", None),
        ("abc", None),
        ("nan", None),
        ("1e9", None),
        ("", None),
        ("5.5", None),
        ("+5", None),
    ):
        with pytest.raises(ApiError) as e:
            await keyed(transport(429, {}, {"Retry-After": header})).get_account(ADDR)
        assert e.value.retry_after_seconds == want


async def test_client_builds_with_an_explicit_base_url() -> None:
    mf = await create_client(
        "testnet",
        api_base_url="https://api.example.org/",
        rpc_transport=pinned_testnet_rpc().transport(),
    )
    assert mf.api is not None and mf.api.base_url == "https://api.example.org"
    with pytest.raises(InvalidInputError, match="https"):
        await create_client(
            "testnet",
            api_base_url="http://api.example.org",
            rpc_transport=pinned_testnet_rpc().transport(),
        )


async def test_list_accounts_follows_cursors_and_warns_when_truncated() -> None:
    item = {"account": LOWER, "owner": LOWER}
    seen: list[httpx.Request] = []
    t = scripted(
        httpx.Response(200, json=[item], headers={"Next-Cursor": "c1"}),
        httpx.Response(200, json=[item]),
        seen=seen,
    )
    assert len(await HttpApi("https://x.example", 1, transport=t).list_accounts(ADDR)) == 2
    assert str(seen[1].url) == f"https://x.example/v1/agent-accounts?owner={LOWER}&cursor=c1"
    counter = {"n": 0}

    def endless(request: httpx.Request) -> httpx.Response:
        counter["n"] += 1
        return httpx.Response(200, json=[item], headers={"Next-Cursor": f"c{counter['n']}"})

    warnings: list[str] = []
    out = await HttpApi(
        "https://x.example", 1, transport=httpx.MockTransport(endless), on_warning=warnings.append
    ).list_accounts(ADDR)
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


@pytest.mark.parametrize(
    "bad",
    [
        "mfk_test_k\n",
        " mfk_test_k",
        "mfk_test_\r\nX-Evil: 1",
        "mfk_test_\x00k",
        "mfk_test_é",
        "",
        "  ",
        "a" * 257,
    ],
)
async def test_malformed_api_keys_are_refused_without_echo(bad: str) -> None:
    with pytest.raises(InvalidInputError) as e:
        HttpApi("https://x.example", 1, api_key=bad)
    assert bad.strip() not in str(e.value) or bad.strip() == ""
    with pytest.raises(InvalidInputError) as e2:
        await create_client("testnet", api_key=bad, rpc_transport=pinned_testnet_rpc().transport())
    assert "é" not in str(e2.value) and "X-Evil" not in str(e2.value)


@pytest.mark.parametrize(
    "body",
    [
        {"error": {"code": "unauthorized", "message": f"bad key {KEY} (X-Api-Key: {KEY})"}},
        {"error": {"code": KEY, "message": "nope"}},
    ],
)
async def test_a_key_echoed_in_a_server_error_body_is_redacted(body: dict[str, Any]) -> None:
    with pytest.raises(ApiError) as e:
        await keyed(transport(401, body)).get_account(ADDR)
    assert KEY not in f"{e.value} {e.value.api_code}"
    if body["error"]["code"] == "unauthorized":
        assert "[redacted]" in str(e.value) and e.value.api_code == "unauthorized"


def test_a_256_character_key_is_accepted() -> None:
    HttpApi("https://x.example", 1, api_key="k" * 256)


async def test_a_key_in_a_transport_failure_is_redacted_and_requests_ask_for_identity_encoding() -> (
    None
):
    def leaky(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"Illegal header value b'{KEY}'")

    with pytest.raises(ApiError) as e:
        await keyed(httpx.MockTransport(leaky)).get_account(ADDR)
    assert KEY not in str(e.value) and "[redacted]" in str(e.value)
    seen: list[httpx.Request] = []
    await keyed(transport(200, {"account": ADDR}, seen=seen)).get_account(ADDR)
    assert seen[0].headers["Accept-Encoding"] == "identity"


async def test_http_clients_ignore_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    api = keyed(transport(200, {}))
    assert (
        api._http._trust_env is False
    )  # no env proxies, netrc or SSL_CERT_* for a client that carries a key


VECTORS: dict[str, Any] = json.loads(
    (Path(__file__).parents[3] / "fixtures/vectors/notes.json").read_text()
)
TOKEN: str = VECTORS["token"]
NOTE: dict[str, Any] = VECTORS["note"]
PAGE: dict[str, Any] = VECTORS["page"]
BEARER = "bearer-secret"
SOCIAL_KEY = "mfk_test_abc"
NONCE = "0123456789abcdef0123456789abcdef"
SIG = "0x" + "11" * 65


def social(t: httpx.AsyncBaseTransport, api_key: str | None = SOCIAL_KEY) -> HttpApi:
    return HttpApi("https://x.example", 1, api_key=api_key, transport=t)


async def test_social_write_sends_the_bearer_not_the_key() -> None:
    seen: list[httpx.Request] = []
    await social(transport(201, NOTE, seen=seen)).post_note(TOKEN, "volume picking up", BEARER)
    assert str(seen[0].url) == f"https://x.example/v1/tokens/{TOKEN}/notes"
    assert seen[0].method == "POST"
    assert json.loads(seen[0].content) == {"body": "volume picking up"}
    assert seen[0].headers["Authorization"] == f"Bearer {BEARER}"
    assert "X-Api-Key" not in seen[0].headers


async def test_public_read_keeps_the_key_with_no_authorization() -> None:
    seen: list[httpx.Request] = []
    page = await social(transport(200, PAGE, seen=seen)).list_notes(TOKEN)
    assert seen[0].headers["X-Api-Key"] == SOCIAL_KEY
    assert "Authorization" not in seen[0].headers
    assert page["notes"][0]["agent"] is True


async def test_bearer_is_cut_from_echoed_errors() -> None:
    echo = transport(400, {"error": {"code": "bad", "message": f"saw {BEARER} here"}})
    with pytest.raises(ApiError) as e:
        await social(echo).post_note(TOKEN, "x", BEARER)
    assert BEARER not in str(e.value) and "[redacted]" in str(e.value)
    assert e.value.api_code == "bad"
    coded = transport(401, {"error": {"code": BEARER, "message": "no"}})
    with pytest.raises(ApiError) as c:
        await social(coded).sign_out(BEARER)
    assert c.value.api_code == "http_error"

    def leaky(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"Illegal header value b'Bearer {BEARER}'")

    with pytest.raises(ApiError) as n:
        await social(httpx.MockTransport(leaky)).agree(7, True, BEARER)
    assert n.value.api_code == "network" and BEARER not in str(n.value)


async def test_bearer_or_key_split_by_a_zero_width_character_is_cut() -> None:
    def split(secret: str) -> str:
        return f"{secret[:4]}\u200b{secret[4:]}"

    echo = transport(
        400, {"error": {"code": "bad", "message": f"saw {split(BEARER)} and {split(SOCIAL_KEY)}"}}
    )
    with pytest.raises(ApiError) as e:
        await social(echo).post_note(TOKEN, "x", BEARER)
    assert str(e.value) == "saw [redacted] and [redacted]"


async def test_reads_the_shared_note_vectors() -> None:
    page = await social(transport(200, PAGE)).list_notes(TOKEN)
    assert page == PAGE
    replies = await social(transport(200, VECTORS["replies"])).list_replies(7)
    assert replies["notes"][0]["holdBps"] is None
    assert (
        await social(transport(200, VECTORS["marks"])).note_marks(TOKEN, 0, 100)
        == (VECTORS["marks"])
    )
    reactions = await social(transport(200, VECTORS["reactions"])).get_reactions(TOKEN)
    assert reactions == VECTORS["reactions"]
    assert await social(transport(200, NOTE)).get_note(7) == NOTE


async def test_sign_in_sends_neither_the_key_nor_authorization() -> None:
    challenge = {
        "nonce": NONCE,
        "message": "Agent sign-in for account ...",
        "issuedAt": 1760616000,
        "expiresAt": 1760616300,
    }
    signer = VECTORS["replies"]["notes"][0]["address"]
    seen: list[httpx.Request] = []
    got = await social(transport(200, challenge, seen=seen)).sign_in_challenge(
        "agent", NOTE["address"], signer
    )
    assert got == challenge
    assert str(seen[0].url) == "https://x.example/v1/agent-auth/nonce"
    assert json.loads(seen[0].content) == {
        "kind": "agent",
        "account": NOTE["address"],
        "signer": signer,
    }
    assert "X-Api-Key" not in seen[0].headers and "Authorization" not in seen[0].headers
    session = {"token": "A" * 43, "kind": "agent", "account": NOTE["address"], "expiresAt": 1}
    seen.clear()
    assert await social(transport(200, session, seen=seen)).sign_in(NONCE, SIG) == session
    assert str(seen[0].url) == "https://x.example/v1/agent-auth/session"
    assert json.loads(seen[0].content) == {"nonce": NONCE, "signature": SIG}
    assert "X-Api-Key" not in seen[0].headers and "Authorization" not in seen[0].headers


async def test_a_sign_in_refusal_keeps_its_code() -> None:
    off = transport(403, {"error": {"code": "posting_off", "message": "posting is off"}})
    with pytest.raises(ApiError) as e:
        await social(off).sign_in(NONCE, SIG)
    assert (e.value.status, e.value.api_code, str(e.value)) == (
        403,
        "posting_off",
        "posting is off",
    )


async def test_each_write_goes_to_its_route_with_its_body() -> None:
    a = NOTE["address"]
    cases: list[tuple[str, Any, object, str, str, object]] = [
        (
            "sign_out",
            lambda api: api.sign_out(BEARER),
            None,
            "DELETE",
            "/v1/agent-auth/session",
            None,
        ),
        (
            "put_reaction",
            lambda api: api.put_reaction(TOKEN, "bullish", BEARER),
            None,
            "PUT",
            f"/v1/tokens/{TOKEN}/reactions",
            {"key": "bullish"},
        ),
        (
            "put_reaction off",
            lambda api: api.put_reaction(TOKEN, "bearish", BEARER, False),
            None,
            "PUT",
            f"/v1/tokens/{TOKEN}/reactions",
            {"key": "bearish", "active": False},
        ),
        (
            "put_reaction none",
            lambda api: api.put_reaction(TOKEN, None, BEARER),
            None,
            "PUT",
            f"/v1/tokens/{TOKEN}/reactions",
            {"key": None},
        ),
        (
            "post_reply",
            lambda api: api.post_reply(7, "not so sure", BEARER),
            VECTORS["replies"]["notes"][0],
            "POST",
            "/v1/notes/7/replies",
            {"body": "not so sure"},
        ),
        (
            "agree",
            lambda api: api.agree(7, True, BEARER),
            None,
            "PUT",
            "/v1/notes/7/agree",
            {"active": True},
        ),
        ("report", lambda api: api.report(7, BEARER), None, "POST", "/v1/notes/7/report", None),
        (
            "delete_note",
            lambda api: api.delete_note(7, BEARER),
            None,
            "DELETE",
            "/v1/notes/7",
            None,
        ),
        (
            "set_posting",
            lambda api: api.set_posting(a, True, BEARER),
            {"enabled": True, "updatedAt": 1760616000},
            "PUT",
            f"/v1/agent-accounts/{a.lower()}/posting",
            {"enabled": True},
        ),
        (
            "delete_agent_notes",
            lambda api: api.delete_agent_notes(a, BEARER),
            {"deleted": 3},
            "DELETE",
            f"/v1/agent-accounts/{a.lower()}/notes",
            None,
        ),
    ]
    for name, call, answer, method, path, body in cases:
        seen: list[httpx.Request] = []
        t = transport(204, None, seen=seen) if answer is None else transport(200, answer, seen=seen)
        out = await call(social(t))
        req = seen[0]
        assert (name, str(req.url), req.method) == (name, f"https://x.example{path}", method)
        assert (name, json.loads(req.content) if req.content else None) == (name, body)
        assert req.headers["Authorization"] == f"Bearer {BEARER}", name
        assert "X-Api-Key" not in req.headers, name
        if answer is not None:
            assert out == answer, name


async def test_reads_pages_marks_and_the_posting_switch_from_their_routes() -> None:
    seen: list[httpx.Request] = []
    await social(transport(200, PAGE, seen=seen)).list_notes(
        TOKEN, cursor="eyJzIjoibm90ZXMifQ", limit=50
    )
    await social(transport(200, VECTORS["replies"], seen=seen)).list_replies(7, limit=5)
    await social(transport(200, [], seen=seen)).note_marks(TOKEN, 100, 100 + 90 * 86_400)
    posting = await social(
        transport(200, {"enabled": False, "updatedAt": None}, seen=seen)
    ).get_posting(NOTE["address"])
    assert posting == {"enabled": False, "updatedAt": None}
    assert [str(r.url) for r in seen] == [
        f"https://x.example/v1/tokens/{TOKEN}/notes?cursor=eyJzIjoibm90ZXMifQ&limit=50",
        "https://x.example/v1/notes/7/replies?limit=5",
        f"https://x.example/v1/tokens/{TOKEN}/notes/marks?from=100&to={100 + 90 * 86_400}",
        f"https://x.example/v1/agent-accounts/{NOTE['address'].lower()}/posting",
    ]
    for r in seen:
        assert r.headers["X-Api-Key"] == SOCIAL_KEY and "Authorization" not in r.headers


async def test_social_arguments_are_refused_before_any_request() -> None:
    seen: list[httpx.Request] = []
    api = social(transport(200, {}, seen=seen))
    for nid in (0, -1, 1.5, True, 2**53, "7"):
        with pytest.raises(InvalidInputError):
            await api.get_note(nid)  # type: ignore[arg-type]
    for limit in (0, 51, True):
        with pytest.raises(InvalidInputError):
            await api.list_notes(TOKEN, limit=limit)
    with pytest.raises(InvalidInputError):
        await api.list_replies(7, cursor="a&b=c")
    with pytest.raises(InvalidInputError):
        await api.list_notes("nope")
    for start, end, field in (
        (-1, 5, "start"),
        (10, 5, "end"),
        (0, 90 * 86_400 + 1, "end"),
        (0.5, 5, "start"),
        (True, 5, "start"),
        (0, None, "end"),
    ):
        with pytest.raises(InvalidInputError) as refused:
            await api.note_marks(TOKEN, start, end)  # type: ignore[arg-type]
        assert refused.value.field == field
    with pytest.raises(InvalidInputError):
        await api.put_reaction(TOKEN, None, BEARER, False)
    with pytest.raises(InvalidInputError):
        await api.put_reaction(TOKEN, "Bull ish", BEARER)
    with pytest.raises(InvalidInputError):
        await api.put_reaction(TOKEN, "bullish", BEARER, 1)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError):
        await api.agree(7, 1, BEARER)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError):
        await api.set_posting(TOKEN, "yes", BEARER)  # type: ignore[arg-type]
    with pytest.raises(InvalidInputError):
        await api.sign_in_challenge("admin", TOKEN, TOKEN)
    with pytest.raises(InvalidInputError):
        await api.sign_in("nonce", "nothex")
    with pytest.raises(InvalidInputError):
        await api.sign_in("bad nonce!", SIG)
    for bearer in ("", "a b", "x\r\nX-Evil: 1", "é", None):
        with pytest.raises(InvalidInputError) as e:
            await api.report(7, bearer)  # type: ignore[arg-type]
        assert "X-Evil" not in str(e.value)
    assert seen == []


async def test_social_response_shapes_are_validated() -> None:
    def wrong(body: object) -> HttpApi:
        return social(transport(200, body))

    cases: list[Any] = [
        wrong({**NOTE, "side": "neutral"}).get_note(7),
        wrong({**NOTE, "id": 8}).get_note(7),
        wrong({**NOTE, "address": "nope"}).get_note(7),
        wrong({**NOTE, "body": "x" * 281}).get_note(7),
        wrong({**NOTE, "agreeCount": -1}).get_note(7),
        wrong({**NOTE, "agent": 1}).get_note(7),
        wrong({**NOTE, "holdBps": "120"}).get_note(7),
        wrong({"notes": [NOTE] * 51, "nextCursor": None}).list_notes(TOKEN),
        wrong({**PAGE, "nextCursor": "bad cursor!"}).list_notes(TOKEN),
        wrong([{"id": 1, "createdAt": 2, "side": "up", "agent": False}]).note_marks(TOKEN, 0, 1),
        wrong([VECTORS["marks"][0]] * 2_001).note_marks(TOKEN, 0, 1),
        wrong({**VECTORS["reactions"], "mine": 5}).get_reactions(TOKEN),
        wrong({**VECTORS["reactions"], "selected": [1]}).get_reactions(TOKEN),
        wrong({**VECTORS["reactions"], "counts": {"bullish": -1}}).get_reactions(TOKEN),
        wrong({"enabled": "yes", "updatedAt": None}).get_posting(TOKEN),
        wrong({"deleted": -1}).delete_agent_notes(TOKEN, BEARER),
        wrong({"nonce": "n", "message": 7, "issuedAt": 1, "expiresAt": 2}).sign_in_challenge(
            "owner", TOKEN, TOKEN
        ),
        wrong(
            {"nonce": "n", "message": "m" * 1_025, "issuedAt": 1, "expiresAt": 2}
        ).sign_in_challenge("owner", TOKEN, TOKEN),
        wrong({"token": "a b", "kind": "agent", "account": TOKEN, "expiresAt": 1}).sign_in(
            NONCE, SIG
        ),
        wrong({"token": "abc", "kind": "agent", "account": "nope", "expiresAt": 1}).sign_in(
            NONCE, SIG
        ),
        wrong({"token": "abc", "kind": "admin", "account": TOKEN, "expiresAt": 1}).sign_in(
            NONCE, SIG
        ),
        wrong(NOTE).post_reply(7, "x", BEARER),
        wrong({**NOTE, "side": None}).post_note(TOKEN, "x", BEARER),
    ]
    for case in cases[:-2]:
        with pytest.raises(MercurifiError) as e:
            await case
        assert e.value.code == "API_BAD_RESPONSE"
    assert (await cases[-2])["id"] == 7  # a reply is a note: post_reply accepts it
    with pytest.raises(MercurifiError) as e:
        await cases[-1]
    assert e.value.code == "API_BAD_RESPONSE"
    rockets = await wrong({**NOTE, "body": "\U0001f680" * 280}).get_note(7)
    assert len(rockets["body"]) == 280


def testcheck_body_strips_trims_and_counts_code_points_like_the_api() -> None:
    assert check_body("  volume\u200b picking up\x07 \n") == "volume picking up"
    assert check_body("a\u2028b\u2029c") == "abc"
    assert check_body("\U0001f680" * 280) == "\U0001f680" * 280
    for bad in ("\U0001f680" * 281, " \u200b\t ", 5):
        with pytest.raises(InvalidInputError) as e:
            check_body(bad)  # type: ignore[arg-type]
        assert e.value.field == "body"
        assert str(e.value) == "a note body must be 1 to 280 characters"


async def test_check_body_maps_a_lone_surrogate_to_the_replacement_character() -> None:
    assert check_body("up \ud800 only") == "up \ufffd only"
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={**NOTE, "body": "\ufffd"})

    api = HttpApi("https://api.example", 5042002, transport=httpx.MockTransport(handle))
    await api.post_note(TOKEN, check_body("\udfff"), BEARER)
    assert json.loads(seen[0].content) == {"body": "\ufffd"}
