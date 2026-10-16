import asyncio
import gc
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from mercurifi.client import create_client
from mercurifi.errors import InvalidInputError, StreamError
from mercurifi.stream import StreamEvent, open_stream, validate_topics

from .helpers import pinned_testnet_rpc

REQ = ("https://x.example/v1/stream?topics=launches", {"X-Api-Key": "mfk_test_k"})


class Chunks(httpx.AsyncByteStream):
    def __init__(
        self, chunks: list[bytes], hang: bool = False, closed: list[bool] | None = None
    ) -> None:
        self.chunks, self.hang, self.closed = chunks, hang, closed

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for c in self.chunks:
            yield c
        if self.hang:
            await asyncio.Event().wait()

    async def aclose(self) -> None:
        if self.closed is not None:
            self.closed.append(True)


def sse(
    status: int = 200,
    chunks: list[str] | list[bytes] | None = None,
    headers: dict[str, str] | None = None,
    **kw: Any,
) -> httpx.Response:
    data = [c.encode() if isinstance(c, str) else c for c in (chunks or [])]
    return httpx.Response(status, headers=headers, stream=Chunks(data, **kw))


def scripted(
    *responses: httpx.Response | Exception, seen: list[httpx.Request] | None = None
) -> httpx.MockTransport:
    queue = list(responses)

    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return httpx.MockTransport(handle)


async def collect(gen: AsyncIterator[StreamEvent]) -> list[StreamEvent]:
    return [ev async for ev in gen]


async def no_sleep(_: float) -> None:
    return None


def sleeps() -> tuple[list[float], Any]:
    waits: list[float] = []

    async def sleep(s: float) -> None:
        waits.append(s)

    return waits, sleep


def one(*chunks: str) -> httpx.Response:
    return sse(200, list(chunks))


async def test_parses_split_chunks_and_skips_comments() -> None:
    t = scripted(one(": open\n\nid: 1-0\nevent: la", 'unch\ndata: {"a":1}\n\n: ping\n\n'))
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent("1-0", "launch", {"a": 1})
    ]


async def test_resume_and_dedupe() -> None:
    seen: list[httpx.Request] = []
    t = scripted(
        one("id: 1-0\nevent: trade\ndata: 1\n\nid: 2-0\nevent: trade\ndata: 2\n\n"),
        one("id: 2-0\nevent: trade\ndata: 2\n\nid: 3-0\nevent: trade\ndata: 3\n\n"),
        seen=seen,
    )
    events = await collect(open_stream(REQ, transport=t, max_reconnects=1, sleep=no_sleep))
    assert [e.id for e in events] == ["1-0", "2-0", "3-0"]
    assert (
        seen[1].headers["Last-Event-ID"] == "2-0" and seen[1].headers["X-Api-Key"] == "mfk_test_k"
    )
    assert "Last-Event-ID" not in seen[0].headers


async def test_on_open_runs_once_per_opened_connection_before_its_events() -> None:
    log: list[str] = []

    def opened() -> None:
        log.append("open")
        raise RuntimeError("observer failed")  # a throwing observer must not break the stream

    t = scripted(
        sse(503), one("id: 1\nevent: trade\ndata: 1\n\n"), one("id: 2\nevent: trade\ndata: 2\n\n")
    )
    async for ev in open_stream(REQ, transport=t, max_reconnects=2, sleep=no_sleep, on_open=opened):
        log.append(str(ev.id))
    assert log == ["open", "1", "open", "2"]


async def test_reset_event() -> None:
    t = scripted(one("event: reset\ndata: {}\n\n"))
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent(None, "reset", {})
    ]


async def test_retry_after_and_fatal() -> None:
    waits, sleep = sleeps()
    t = scripted(sse(429, headers={"Retry-After": "5"}))
    await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=sleep, random=lambda: 0))
    assert waits == [5.0]
    with pytest.raises(StreamError) as info:
        await collect(open_stream(REQ, transport=scripted(sse(400)), sleep=no_sleep))
    assert info.value.status == 400


async def test_topics() -> None:
    assert validate_topics(["launches", "agent-account:0x" + "A" * 40]) == [
        "launches",
        "agent-account:0x" + "a" * 40,
    ]
    for bad, match in [
        (["account:0x" + "a" * 40], "reserved"),
        (["orders"], "browser session"),
        (["follows"], "browser session"),
        (["nope"], "unknown topic"),
        (["launches"] * 21, "at most 20"),
        ([], "at most 20"),
        ([5], "must be a string"),
        ([None], "must be a string"),
        ("launches", "at most 20"),
        (["tradeK"], "unknown topic"),
        (["agent-account:0x" + "a" * 39], "unknown topic"),
    ]:
        with pytest.raises(InvalidInputError, match=match):
            validate_topics(bad)  # type: ignore[arg-type]
    assert validate_topics(["\tTrades \n"]) == ["trades"]
    assert validate_topics(["launches"] * 20) == ["launches"] * 20
    # ASCII-only lowercase: the Kelvin sign does not fold into "k"
    with pytest.raises(InvalidInputError):
        validate_topics(["toKen:0x" + "a" * 40])


async def test_error_never_carries_key_or_path() -> None:
    req = (
        "https://x.example/secret-path/v1/stream?topics=launches&k=SECRETQ",
        {"X-Api-Key": "mfk_live_SECRET"},
    )
    with pytest.raises(StreamError) as info:
        await collect(open_stream(req, transport=scripted(sse(403)), sleep=no_sleep))
    text = str(info.value) + repr(info.value) + repr(vars(info.value))
    assert info.value.status == 403
    assert "SECRET" not in text and "secret-path" not in text and "x.example" in text


async def test_redirect_refused_and_key_not_forwarded() -> None:
    seen: list[httpx.Request] = []
    t = scripted(sse(302, headers={"Location": "https://evil.example/"}), seen=seen)
    with pytest.raises(StreamError, match="HTTP 302"):
        await collect(open_stream(REQ, transport=t, sleep=no_sleep))
    assert len(seen) == 1


async def test_crlf_cr_and_split_endings() -> None:
    t = scripted(
        one(
            "id: 1-0\r",
            "\nevent: trade\r\ndata: 1\r\n\r",
            "\n",
            "id: 2-0\revent: trade\rdata: 2\r\r",
        )
    )
    events = await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep))
    assert events == [StreamEvent("1-0", "trade", 1), StreamEvent("2-0", "trade", 2)]


async def test_trailing_cr_is_a_line_end_at_eof() -> None:
    t = scripted(one("event: note\rdata: x\r\r"))
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent(None, "note", "x")
    ]


async def test_multiline_data_and_non_json_text() -> None:
    t = scripted(one("event: note\ndata: a\ndata: b\n\n"))
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent(None, "note", "a\nb")
    ]


async def test_malformed_events_skipped() -> None:
    t = scripted(
        one(
            "event: <script>\ndata: 1\n\nid: bad id!\nevent: trade\ndata: 2\n\nid: 5-0\nevent: trade\ndata: 3\n\n"
        )
    )
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent("5-0", "trade", 3)
    ]


async def test_bom_and_nul_id() -> None:
    body = b"\xef\xbb\xbf" + b"id: 1-0\nevent: t\ndata: 1\n\nid: 2\x000\nevent: t\ndata: 2\n\n"
    t = scripted(sse(200, [body]))
    assert await collect(open_stream(REQ, transport=t, max_reconnects=0, sleep=no_sleep)) == [
        StreamEvent("1-0", "t", 1)
    ]


async def test_oversize_line_event_and_tail() -> None:
    big = "x" * (70 * 1024)
    for chunks in (
        [f"data: {big}\n\n"],
        [big],
        [f"data: {'y' * 60_000}\n" * 6 + "\n"],
        [big[:40_000], big[:40_000]],
    ):
        with pytest.raises(StreamError, match="size limit"):
            await collect(open_stream(REQ, transport=scripted(one(*chunks)), sleep=no_sleep))


async def test_reset_reconnects_with_first_step_backoff() -> None:
    waits, sleep = sleeps()
    seen: list[httpx.Request] = []
    t = scripted(
        one("id: 1-0\nevent: trade\ndata: 1\n\nevent: reset\ndata: {}\n\n"),
        one("id: 2-0\nevent: trade\ndata: 2\n\n"),
        seen=seen,
    )
    events = await collect(
        open_stream(REQ, transport=t, max_reconnects=1, sleep=sleep, random=lambda: 0.5)
    )
    assert [e.type for e in events] == ["trade", "reset", "trade"]
    assert waits == [0.375]
    assert seen[1].headers["Last-Event-ID"] == "1-0"


async def test_exponential_backoff_with_ceiling() -> None:
    err = httpx.ConnectError("connect ECONNREFUSED https://x.example/secret")
    waits, sleep = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(*[err] * 7),
            max_reconnects=6,
            min_backoff=0.1,
            max_backoff=0.5,
            random=lambda: 1,
            sleep=sleep,
        )
    )
    assert waits == pytest.approx([0.1, 0.2, 0.4, 0.5, 0.5, 0.5])
    lows, sleep2 = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(*[err] * 3),
            max_reconnects=2,
            min_backoff=0.1,
            max_backoff=0.5,
            random=lambda: 0,
            sleep=sleep2,
        )
    )
    assert lows == pytest.approx([0.05, 0.1])


async def test_huge_attempt_exponent_is_capped() -> None:
    err = httpx.ConnectError("x")
    waits, sleep = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(err)),
            max_reconnects=60,
            min_backoff=0.1,
            max_backoff=7,
            random=lambda: 1,
            sleep=sleep,
        )
    )
    assert max(waits) == 7.0 and len(waits) == 60


async def test_hostile_hints_are_clamped() -> None:
    waits, sleep = sleeps()
    t = scripted(
        one("retry: 999999999\ndata: 1\n\n"), sse(429, headers={"Retry-After": "99999999"})
    )
    await collect(open_stream(REQ, transport=t, max_reconnects=1, sleep=sleep, random=lambda: 0))
    assert waits == [30.0, 300.0]
    for ra in (
        "nan",
        "inf",
        "-5",
        "abc",
        "",
        "5.5",
        "1e3",
        "0x10",
        "+5",
        "Wed, 21 Oct 2026 07:28:00 GMT",
    ):
        w, s = sleeps()
        await collect(
            open_stream(
                REQ,
                transport=scripted(sse(429, headers={"Retry-After": ra})),
                max_reconnects=0,
                sleep=s,
                random=lambda: 0,
            )
        )
        assert w == [0.25], ra


async def test_dedupe_window_is_bounded() -> None:
    many = "".join(f"id: {i}-0\nevent: t\ndata: {i}\n\n" for i in range(2100))
    t = scripted(
        one(many), one("id: 0-0\nevent: t\ndata: 0\n\nid: 2099-0\nevent: t\ndata: 2099\n\n")
    )
    events = await collect(open_stream(REQ, transport=t, max_reconnects=1, sleep=no_sleep))
    assert len([e for e in events if e.id == "0-0"]) == 2
    assert len([e for e in events if e.id == "2099-0"]) == 1


async def test_backoff_not_reset_by_delivery_or_reset_events() -> None:
    waits, sleep = sleeps()
    t = scripted(*[one("id: 1-0\nevent: t\ndata: 1\n\n")] * 5)
    await collect(
        open_stream(
            REQ,
            transport=t,
            max_reconnects=4,
            sleep=sleep,
            random=lambda: 1,
            min_backoff=0.1,
            max_backoff=10,
        )
    )
    assert waits == pytest.approx([0.1, 0.2, 0.4, 0.8])
    w2, s2 = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(*[one("event: reset\ndata: {}\n\n")] * 4),
            max_reconnects=3,
            sleep=s2,
            random=lambda: 1,
            min_backoff=0.1,
        )
    )
    assert w2 == pytest.approx([0.1, 0.2, 0.4])


async def test_backoff_resets_after_healthy_connection() -> None:
    waits, sleep = sleeps()
    clock = [0.0]
    n = 0

    def handle(request: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        if n == 3:
            clock[0] += 12.0
        return sse(200, [])

    await collect(
        open_stream(
            REQ,
            transport=httpx.MockTransport(handle),
            max_reconnects=4,
            sleep=sleep,
            random=lambda: 1,
            min_backoff=0.1,
            now=lambda: clock[0],
        )
    )
    assert waits == pytest.approx([0.1, 0.2, 0.1, 0.2])


async def test_hints_jitter_upward_and_never_undercut_backoff() -> None:
    waits, sleep = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(one("retry: 0\ndata: 1\n\n"), sse(200, [])),
            max_reconnects=1,
            sleep=sleep,
            random=lambda: 0,
            min_backoff=0.1,
            max_backoff=1,
        )
    )
    assert waits == pytest.approx([0.1])  # retry: 0 clamps to the minimum
    w2, s2 = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(one("retry: 2000\ndata: 1\n\n"), sse(200, [])),
            max_reconnects=1,
            sleep=s2,
            random=lambda: 0.5,
            min_backoff=0.1,
            max_backoff=1,
        )
    )
    assert w2 == pytest.approx([1.25])  # clamped to 1 s, then x1.25
    w3, s3 = sleeps()
    t = scripted(one("data: 1\n\n"), one("retry: 0\ndata: 1\n\n"), sse(200, []))
    await collect(
        open_stream(
            REQ,
            transport=t,
            max_reconnects=2,
            sleep=s3,
            random=lambda: 1,
            min_backoff=0.1,
            max_backoff=10,
        )
    )
    assert w3 == pytest.approx(
        [0.1, 0.2]
    )  # the second hint (0.15) does not undercut the grown backoff


async def test_retry_after_jittered_and_5xx_advances_attempt() -> None:
    a, sa = sleeps()
    b, sb = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(sse(429, headers={"Retry-After": "10"})),
            max_reconnects=0,
            sleep=sa,
            random=lambda: 0,
        )
    )
    await collect(
        open_stream(
            REQ,
            transport=scripted(sse(429, headers={"Retry-After": "10"})),
            max_reconnects=0,
            sleep=sb,
            random=lambda: 0.99,
        )
    )
    assert a == [10.0] and 14.0 < b[0] <= 15.0
    c, sc = sleeps()
    await collect(
        open_stream(
            REQ,
            transport=scripted(sse(503), sse(500), sse(502)),
            max_reconnects=2,
            sleep=sc,
            random=lambda: 1,
            min_backoff=0.1,
            max_backoff=10,
        )
    )
    assert c == pytest.approx([0.1, 0.2, 0.4])


async def test_on_reconnect_labels_and_observer_failures() -> None:
    infos: list[tuple[int, int, str]] = []
    req = ("https://x.example/secret-path/v1/stream?k=SECRETQ", {"X-Api-Key": "mfk_live_SECRET"})
    t = scripted(
        httpx.ConnectError("ECONNREFUSED https://x.example/secret-path with mfk_live_SECRET"),
        sse(503),
        sse(200, []),
        sse(200, []),
    )

    def observer(attempt: int, delay_ms: int, reason: str) -> None:
        infos.append((attempt, delay_ms, reason))
        raise RuntimeError("observer bug")

    await collect(
        open_stream(
            req,
            transport=t,
            max_reconnects=3,
            sleep=no_sleep,
            random=lambda: 1,
            min_backoff=0.1,
            on_reconnect=observer,
        )
    )
    assert infos == [(1, 100, "network error"), (2, 200, "HTTP 503"), (3, 400, "stream ended")]
    assert (
        "SECRET" not in repr(infos)
        and "secret-path" not in repr(infos)
        and "x.example" not in repr(infos)
    )


async def test_async_observer_exception_is_swallowed() -> None:
    loop = asyncio.get_running_loop()
    problems: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _l, ctx: problems.append(ctx))
    seen: list[int] = []

    async def observer(attempt: int, delay_ms: int, reason: str) -> None:
        seen.append(attempt)
        raise RuntimeError("async observer bug")

    t = scripted(httpx.ConnectError("down"), one("id: 1-0\nevent: t\ndata: 1\n\n"))
    events = await collect(
        open_stream(REQ, transport=t, max_reconnects=1, sleep=no_sleep, on_reconnect=observer)
    )
    await asyncio.sleep(0.01)
    gc.collect()
    loop.set_exception_handler(None)
    assert seen == [1] and [e.id for e in events] == ["1-0"] and problems == []


async def test_idle_watchdog_reconnects_a_silent_connection() -> None:
    closed: list[bool] = []
    t = scripted(sse(200, [], hang=True, closed=closed), one("id: 9-0\nevent: t\ndata: 9\n\n"))
    reasons: list[str] = []
    events = await collect(
        open_stream(
            REQ,
            transport=t,
            idle_timeout=0.02,
            max_reconnects=1,
            sleep=no_sleep,
            on_reconnect=lambda a, d, r: reasons.append(r),
        )
    )
    assert [e.id for e in events] == ["9-0"] and reasons == ["idle timeout"] and closed == [True]


async def test_idle_watchdog_does_not_run_while_consumer_is_busy() -> None:
    t = scripted(one("id: 1-0\nevent: t\ndata: 1\n\nid: 2-0\nevent: t\ndata: 2\n\n"))
    out: list[str | None] = []
    async for ev in open_stream(
        REQ, transport=t, idle_timeout=0.02, max_reconnects=0, sleep=no_sleep
    ):
        out.append(ev.id)
        await asyncio.sleep(0.06)
    assert out == ["1-0", "2-0"]


async def test_early_break_closes_connection_and_leaks_nothing() -> None:
    closed: list[bool] = []
    before = len(asyncio.all_tasks())
    gen = open_stream(
        REQ,
        transport=scripted(sse(200, ["id: 1-0\nevent: t\ndata: 1\n\n"], hang=True, closed=closed)),
        sleep=no_sleep,
    )
    first = await gen.__anext__()
    assert first.id == "1-0"
    await gen.aclose()  # type: ignore[attr-defined]
    assert closed == [True]
    assert len(asyncio.all_tasks()) == before


async def test_task_cancel_while_waiting_and_while_backing_off() -> None:
    closed: list[bool] = []
    task = asyncio.ensure_future(
        collect(
            open_stream(
                REQ, transport=scripted(sse(200, [], hang=True, closed=closed)), idle_timeout=0
            )
        )
    )
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed == [True]
    task2 = asyncio.ensure_future(
        collect(
            open_stream(
                REQ, transport=scripted(httpx.ConnectError("down")), min_backoff=60, max_backoff=60
            )
        )
    )
    await asyncio.sleep(0.02)
    task2.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task2


async def test_rejects_malformed_last_event_id() -> None:
    for bad in ("a b\nc", "", "x" * 65):
        with pytest.raises(InvalidInputError):
            await collect(open_stream(REQ, last_event_id=bad, transport=scripted()))
    seen: list[httpx.Request] = []
    await collect(
        open_stream(
            REQ,
            last_event_id="7-1",
            transport=scripted(one(), seen=seen),
            max_reconnects=0,
            sleep=no_sleep,
        )
    )
    assert seen[0].headers["Last-Event-ID"] == "7-1"


async def test_key_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    req = ("https://x.example/v1/stream", {"X-Api-Key": "mfk_live_SECRETKEY"})
    await collect(
        open_stream(
            req,
            transport=scripted(
                httpx.ConnectError("boom"), sse(200, ["id: 1-0\nevent: t\ndata: 1\n\n"])
            ),
            max_reconnects=1,
            sleep=no_sleep,
        )
    )
    assert "SECRETKEY" not in caplog.text


async def test_client_stream() -> None:
    calls: list[list[str]] = []

    class FakeApi:
        def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
            calls.append(topics)
            return REQ

    mf = await create_client(
        "testnet", rpc_transport=pinned_testnet_rpc().transport(), api=FakeApi()
    )
    stream = mf.stream(
        ["Trades", "agent-account:0x" + "B" * 40],
        transport=scripted(one("id: 1-0\nevent: trade\ndata: 1\n\n")),
        max_reconnects=0,
        sleep=no_sleep,
    )
    assert len(await collect(stream)) == 1
    assert calls == [["trades", "agent-account:0x" + "b" * 40]]
    with pytest.raises(InvalidInputError, match="reserved"):
        mf.stream(["account:0x" + "b" * 40])
    keyless = await create_client(
        "testnet", rpc_transport=pinned_testnet_rpc().transport(), api=None
    )
    with pytest.raises(InvalidInputError):
        keyless.stream(["trades"])


def test_open_stream_validates_eagerly_and_ignores_the_environment() -> None:
    with pytest.raises(InvalidInputError):
        open_stream(REQ, last_event_id="bad id!")  # raised at the call, not on first iteration
    assert open_stream(REQ).__class__.__name__ == "async_generator"
