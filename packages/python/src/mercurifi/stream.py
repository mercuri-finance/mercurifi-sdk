from __future__ import annotations

import asyncio
import codecs
import inspect
import json
import random as _random
import re
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import InvalidInputError, StreamError
from .redact import redact_url


@dataclass(frozen=True)
class StreamEvent:
    """One server event.

    `data` is untrusted external content (token names, symbols and other user-supplied text arrive here): validate it
    before use and never feed it to an LLM unfiltered. A `reset` event means "refetch over HTTP, you may have missed
    events"; it also arrives about every 30 minutes by design, when the server recycles the connection.
    """

    id: str | None
    type: str
    data: Any


# The server's topic rules plus agent-account:0x…; account: is reserved
# (docs/architecture/api.md) and private topics need a browser session. Event type strings are passed through.
_TOPIC = re.compile(r"(head|trades|launches|governance|pools|pool-trades|(token|trader|agent-account):0x[0-9a-f]{40}|pool:0x[0-9a-f]{64})")

# Limits on untrusted input. The server's own events are far smaller.
MAX_LINE_CHARS = 64 * 1024  # one line, and so the unterminated tail kept between chunks
MAX_EVENT_CHARS = 256 * 1024  # the data of one event
MAX_ID_CHARS = 64
DEDUPE_WINDOW = 2048
MAX_RETRY_AFTER = 300.0
_EVENT_ID = re.compile(r"[0-9A-Za-z._:-]+")
_EVENT_TYPE = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,63}")
_RETRY = re.compile(r"[0-9]{1,9}")
_LINE_END = re.compile(r"\r\n|\n|\r")
_LOWER = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}


def _valid_id(value: str) -> bool:
    return 0 < len(value) <= MAX_ID_CHARS and _EVENT_ID.fullmatch(value) is not None


def validate_topics(topics: list[str]) -> list[str]:
    """Checks topics like the server does, plus `agent-account:0x…`; returns them trimmed and lowercased."""
    if not isinstance(topics, (list, tuple)) or not 1 <= len(topics) <= 20:
        raise InvalidInputError("topics", "subscribe to 1 to at most 20 topics")
    out: list[str] = []
    for raw in topics:
        if not isinstance(raw, str):
            raise InvalidInputError("topics", "a topic must be a string")
        t = str.translate(str.strip(raw, " \t\r\n"), _LOWER)  # ASCII-only lowercase: no Unicode case folding surprises
        if t in ("orders", "follows"):
            raise InvalidInputError("topics", f"{t} is private and needs a browser session")
        if t.startswith("account:"):
            raise InvalidInputError("topics", "account: is reserved; use agent-account:0x… for an agent account")
        if _TOPIC.fullmatch(t) is None:
            raise InvalidInputError("topics", f"unknown topic {raw[:80]}")
        out.append(t)
    return out


def _too_large(what: str) -> StreamError:
    return StreamError(f"The stream sent {what} over the size limit; the connection was dropped.", None)


@dataclass
class _Raw:
    id: str | None = None
    event: str | None = None
    data: str = ""
    has_data: bool = False
    retry: int | None = None


class _Parser:
    """Incremental SSE parser. Oversized lines or events raise StreamError instead of growing without bound."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="replace")  # drops a leading BOM
        self._buffer = ""
        self._ev = _Raw()

    def feed(self, chunk: bytes, final: bool = False) -> list[_Raw]:
        self._buffer += self._decoder.decode(chunk, final)
        if final and self._buffer.endswith("\r"):
            self._buffer += "\n"  # a final CR held back as a possible CRLF half is a line end after all
        out: list[_Raw] = []
        buf = self._buffer
        pos = 0
        while True:
            m = _LINE_END.search(buf, pos)
            if m is None:
                break
            # A lone CR at the very end may be the first half of CRLF: wait for the next chunk.
            if m.group() == "\r" and m.end() == len(buf):
                break
            line = buf[pos : m.start()]
            pos = m.end()
            if len(line) > MAX_LINE_CHARS:
                raise _too_large("a line")
            ev = self._ev
            if line == "":
                if ev.has_data or ev.event is not None or ev.retry is not None:
                    out.append(ev)
                self._ev = _Raw()
                continue
            if line.startswith(":"):
                continue
            field, sep, value = line.partition(":")
            if sep and value.startswith(" "):
                value = value[1:]
            if field == "id":
                ev.id = value
            elif field == "event":
                ev.event = value
            elif field == "data":
                if len(ev.data) + len(value) + 1 > MAX_EVENT_CHARS:
                    raise _too_large("an event")
                ev.data = f"{ev.data}\n{value}" if ev.has_data else value
                ev.has_data = True
            elif field == "retry" and _RETRY.fullmatch(value) is not None:
                ev.retry = int(value)
        self._buffer = buf[pos:]
        if len(self._buffer) > MAX_LINE_CHARS:
            raise _too_large("a line")
        return out


def _parse_data(raw: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:  # RecursionError on absurd nesting is a RuntimeError; the 256K cap keeps it far away
        return raw
    except RecursionError:
        return raw


def _retry_after(headers: httpx.Headers) -> float:
    raw = headers.get("Retry-After", "").strip(" \t")
    # Delta-seconds only (RFC 9110): digits, nothing else. HTTP dates, signs, decimals and "nan"/"inf" are ignored.
    return float(raw) if _RETRY.fullmatch(raw) is not None and int(raw) > 0 else 0.0


def open_stream(
    request: tuple[str, dict[str, str]],
    *,
    last_event_id: str | None = None,
    min_backoff: float = 0.5,
    max_backoff: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    random: Callable[[], float] = _random.random,
    max_reconnects: int | None = None,
    idle_timeout: float = 45.0,
    healthy_after: float = 10.0,
    on_reconnect: Callable[[int, int, str], Any] | None = None,
    now: Callable[[], float] = time.monotonic,
) -> AsyncIterator[StreamEvent]:
    """Server-sent events with automatic reconnect.

    Resumes with Last-Event-ID, drops ids already delivered (the server can replay an event twice around a resume) and
    yields `reset` (gap: refetch over HTTP) as an ordinary event.

    Everything on the wire is untrusted: lines, events and ids are size-capped, malformed events are skipped, the
    server's `retry:` hint and `Retry-After` are clamped. Reconnects use jittered exponential backoff up to
    `max_backoff`. The backoff starts over only after a connection has lived `healthy_after` seconds (10 s); delivering
    events, or a `reset`, does not count, so a server or proxy that sends one event and closes cannot make every
    client reconnect in a tight loop. Server hints (`retry:`, `Retry-After`) are jittered upwards and never undercut
    the backoff after a short connection. No bytes (not even the server's 15 s heartbeat) for `idle_timeout` seconds
    (default 45; 0 disables) while waiting on the network reconnects; a slow consumer never trips it.

    The stream is silent about reconnects unless you pass `on_reconnect(attempt, delay_ms, reason)`; a dead server or a
    retryable auth failure otherwise retries forever (stop by closing the iterator or cancelling the task). `reason`
    is a fixed label and never contains the URL or the key. An awaitable result is not awaited; its exceptions are
    swallowed. The request carries the API key: nothing here logs it, error messages name the host only and
    redirects are refused so the key is never forwarded.

    Arguments are validated when this is called, not on the first iteration, so a bad `last_event_id` fails where the
    call is made. `on_reconnect` may be a coroutine function: an observer that is still running when the stream ends
    is cancelled at exit, so keep it short. The HTTP client ignores environment proxies, `.netrc` and `SSL_CERT_*`
    variables (`trust_env=False`): the request carries an API key and must go where the address book says.
    """
    if last_event_id is not None and not (isinstance(last_event_id, str) and _valid_id(last_event_id)):
        raise InvalidInputError("last_event_id", "not a valid stream event id")
    return _run(
        request, last_event_id, min_backoff, max_backoff, transport, sleep, random, max_reconnects, idle_timeout, healthy_after,
        on_reconnect, now,
    )


async def _run(
    request: tuple[str, dict[str, str]],
    last_event_id: str | None,
    min_backoff: float,
    max_backoff: float,
    transport: httpx.AsyncBaseTransport | None,
    sleep: Callable[[float], Awaitable[None]],
    random: Callable[[], float],
    max_reconnects: int | None,
    idle_timeout: float,
    healthy_after: float,
    on_reconnect: Callable[[int, int, str], Any] | None,
    now: Callable[[], float],
) -> AsyncIterator[StreamEvent]:
    url, headers = request
    lo = max(0.001, float(min_backoff))
    hi = max(lo, float(max_backoff))
    host = redact_url(url)
    seen: OrderedDict[str, None] = OrderedDict()  # insertion-ordered: the oldest id leaves first
    last_id = last_event_id
    attempt = 0  # consecutive short-lived or failed connections
    reconnects = 0
    observers: set[asyncio.Task[Any]] = set()

    def backoff(n: int) -> float:
        return float(min(hi, lo * 2 ** min(n, 30)) * (0.5 + random() / 2))

    def jitter_up(seconds: float) -> float:
        return seconds * (1 + random() / 2)  # server hints are minimums: only ever lengthen them

    def spent() -> bool:
        nonlocal reconnects
        over = max_reconnects is not None and reconnects >= max_reconnects
        reconnects += 1
        return over

    async def swallow(awaitable: Awaitable[Any]) -> None:
        try:
            await awaitable
        except Exception:  # an async observer's bug must not surface anywhere
            pass

    def notify(reason: str, delay: float) -> None:
        if on_reconnect is None:
            return
        try:
            result = on_reconnect(attempt, round(delay * 1000), reason)
            if inspect.isawaitable(result):
                task = asyncio.ensure_future(swallow(result))
                observers.add(task)
                task.add_done_callback(observers.discard)
        except Exception:  # a throwing observer must not break the stream
            pass

    async def with_idle(awaitable: Awaitable[Any]) -> Any:
        return await (asyncio.wait_for(awaitable, idle_timeout) if idle_timeout > 0 else awaitable)

    timeout = httpx.Timeout(10.0, read=None)
    try:
        async with httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=False, trust_env=False) as http:
            while True:
                req_headers = {**headers, "Accept": "text/event-stream", "Accept-Encoding": "identity", **({"Last-Event-ID": last_id} if last_id else {})}
                started = now()
                idle_fired = False
                response: httpx.Response | None = None
                try:
                    try:
                        response = await with_idle(http.send(http.build_request("GET", url, headers=req_headers), stream=True))
                    except Exception as exc:  # the cause can carry the URL or key: only a fixed label leaves here
                        idle_fired = isinstance(exc, asyncio.TimeoutError)
                        response = None
                    if response is None:
                        if spent():
                            return
                        delay = backoff(attempt)
                        attempt += 1
                        notify("connection timed out" if idle_fired else "network error", delay)
                        await sleep(delay)
                        continue
                    status = response.status_code
                    if status == 429 or status >= 500:
                        retry_after = _retry_after(response.headers)
                        await response.aclose()
                        hinted = min(jitter_up(retry_after), MAX_RETRY_AFTER) if retry_after > 0 else 0.0
                        delay = max(backoff(attempt), hinted)
                        attempt += 1
                        notify(f"HTTP {status}", delay)
                        await sleep(delay)
                        if spent():
                            return
                        continue
                    if not 200 <= status < 300:
                        await response.aclose()
                        raise StreamError(f"The stream at {host} was refused with HTTP {status}.", status)

                    retry_s: float | None = None
                    ended = "stream ended"
                    parser = _Parser()
                    chunks = response.aiter_bytes()
                    done = False
                    while not done:
                        raws: list[_Raw] = []
                        try:
                            chunk = await with_idle(chunks.__anext__())
                        except StopAsyncIteration:
                            done = True
                            chunk = b""
                        except Exception as exc:
                            ended = "idle timeout" if isinstance(exc, asyncio.TimeoutError) else "stream error"
                            break
                        raws = parser.feed(chunk, done)  # StreamError (oversize) propagates
                        for ev in raws:
                            if ev.retry is not None:
                                retry_s = min(hi, max(lo, ev.retry / 1000))
                            if ev.data == "" and ev.event is None:
                                continue
                            etype = ev.event if ev.event is not None else "message"
                            if _EVENT_TYPE.fullmatch(etype) is None or (ev.id is not None and not _valid_id(ev.id)):
                                continue  # malformed: skipped, never trusted
                            if ev.id is not None:
                                if ev.id in seen:
                                    continue
                                seen[ev.id] = None
                                if len(seen) > DEDUPE_WINDOW:
                                    seen.popitem(last=False)
                                last_id = ev.id
                            yield StreamEvent(ev.id, etype, _parse_data(ev.data))
                    if now() - started >= healthy_after:
                        attempt = 0
                    own = backoff(attempt)
                    delay = own if retry_s is None else max(own, jitter_up(retry_s))
                    attempt += 1
                    if spent():
                        return
                    notify(ended, delay)
                    await sleep(delay)
                finally:
                    if response is not None:
                        await response.aclose()  # releases the connection on early exit, cancellation and every error
    finally:
        if observers:
            await asyncio.sleep(0)  # let observers that never got to start begin, so no coroutine is dropped unawaited
            for task in list(observers):
                task.cancel()
            await asyncio.gather(*observers, return_exceptions=True)
