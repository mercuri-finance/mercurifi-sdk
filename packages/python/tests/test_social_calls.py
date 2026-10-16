import asyncio
import json
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any
from unittest.mock import Mock

import httpx
import pytest

from mercurifi.api import HttpApi
from mercurifi.client import AsyncClient
from mercurifi.errors import InvalidInputError
from mercurifi.networks import LOCAL_CHAIN_ID
from mercurifi.signers import local_key
from mercurifi.signin import SignInExpect, build_sign_in_message

from .helpers import ACCOUNT, AGENT_KEY, OWNER_KEY, TOKEN, A, local_client, local_rpc, mock_account
from .social_api import FakeNotesApi, page

SIGNER = local_key(AGENT_KEY)


async def client_with(api: Any) -> AsyncClient:
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=SIGNER.address)
    return await local_client(rpc, api=api)


async def fake_client() -> tuple[AsyncClient, FakeNotesApi]:
    api = FakeNotesApi(chain_id=LOCAL_CHAIN_ID)
    return await client_with(api), api


async def no_sleep(_: float) -> None:
    return None


async def settle(n: int = 20) -> None:
    for _ in range(n):
        await asyncio.sleep(0)


async def until(check: Any, limit: int = 2_000) -> None:
    for _ in range(limit):
        if check():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never held")


def others() -> set[asyncio.Task[Any]]:
    """Tasks still running besides the test's own: none may outlive on_notes."""
    return {t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()}


class LiveSse:
    """One SSE response the test writes to chunk by chunk; `end()` closes it."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        queue = self._queue

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                while (chunk := await queue.get()) is not None:
                    yield chunk

        self.transport = httpx.MockTransport(lambda r: httpx.Response(200, stream=Body()))

    def push(self, text: str) -> None:
        self._queue.put_nowait(text.encode())

    def end(self) -> None:
        self._queue.put_nowait(None)


def one_shot(text: str) -> httpx.MockTransport:
    return httpx.MockTransport(lambda r: httpx.Response(200, content=text.encode()))


class DeferredList:
    """list_notes calls that wait for the test; each answers with the page id `version` held when it was called."""

    def __init__(self, api: FakeNotesApi) -> None:
        self.version = 0
        self.calls = 0
        self._waiting: list[asyncio.Future[None]] = []

        async def answer(token: str, **kw: Any) -> dict[str, Any]:
            self.calls += 1
            v = self.version
            f: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiting.append(f)
            await f
            return page(v)

        api.list_notes.side_effect = answer

    def resolve(self) -> None:
        self._waiting.pop(0).set_result(None)


def stream_options(transport: httpx.MockTransport, **more: Any) -> dict[str, Any]:
    return {"transport": transport, "max_reconnects": 0, "sleep": no_sleep, **more}


# Agent calls


async def test_signal_and_post_share_one_sign_in_as_the_account() -> None:
    mf, api = await fake_client()
    agent = await mf.agent(ACCOUNT, SIGNER)
    await agent.signal(TOKEN, "bullish")
    note = await agent.notes.post(TOKEN, "volume picking up")
    api.put_reaction.assert_awaited_once_with(TOKEN, "bullish", "bearer-1")
    api.post_note.assert_awaited_once_with(TOKEN, "volume picking up", "bearer-1")
    assert api.sign_in.await_count == 1
    api.sign_in_challenge.assert_awaited_once_with("agent", ACCOUNT, SIGNER.address)
    assert note["agent"] is True


async def test_signal_none_clears_only_the_signal_side_by_side() -> None:
    mf, api = await fake_client()
    agent = await mf.agent(ACCOUNT, SIGNER)
    await agent.signal(TOKEN, None)
    assert [c.args for c in api.put_reaction.await_args_list] == [
        (TOKEN, "bullish", "bearer-1", False),
        (TOKEN, "bearish", "bearer-1", False),
    ]
    await agent.react(TOKEN, "rocket")
    await agent.react(TOKEN, "rocket", False)
    assert [c.args for c in api.put_reaction.await_args_list[2:]] == [
        (TOKEN, "rocket", "bearer-1", True),
        (TOKEN, "rocket", "bearer-1", False),
    ]
    for bad in ("rocket", "", 1):
        with pytest.raises(InvalidInputError) as e:
            await agent.signal(TOKEN, bad)  # type: ignore[arg-type]
        assert e.value.field == "side"
    with pytest.raises(InvalidInputError):
        await agent.react(TOKEN, None)  # type: ignore[arg-type]
    assert api.put_reaction.await_count == 4


async def test_a_body_over_280_characters_is_refused_before_any_request() -> None:
    mf, api = await fake_client()
    agent = await mf.agent(ACCOUNT, SIGNER)
    with pytest.raises(InvalidInputError, match="280"):
        await agent.notes.post(TOKEN, "x" * 281)
    with pytest.raises(InvalidInputError):
        await agent.notes.reply(7, "   ")
    api.sign_in_challenge.assert_not_awaited()


async def test_replies_agrees_reports_deletes_and_signs_out_with_one_bearer() -> None:
    mf, api = await fake_client()
    agent = await mf.agent(ACCOUNT, SIGNER)
    assert (await agent.notes.reply(7, "  not so sure "))["body"] == "not so sure"
    await agent.notes.agree(7)
    await agent.notes.agree(7, False)
    await agent.notes.report(7)
    await agent.notes.delete(8)
    api.post_reply.assert_awaited_once_with(7, "not so sure", "bearer-1")
    assert [c.args for c in api.agree.await_args_list] == [
        (7, True, "bearer-1"),
        (7, False, "bearer-1"),
    ]
    api.report.assert_awaited_once_with(7, "bearer-1")
    api.delete_note.assert_awaited_once_with(8, "bearer-1")
    assert api.sign_in.await_count == 1
    await agent.sign_out()
    api.sign_out.assert_awaited_once_with("bearer-1")


async def test_a_chain_only_client_refuses_at_the_await_with_the_api_message() -> None:
    mf = await client_with(None)
    agent = await mf.agent(ACCOUNT, SIGNER)
    calls = [
        agent.notes.post(TOKEN, "hello"),
        agent.signal(TOKEN, "bullish"),
        mf.notes.list(TOKEN),
        mf.reactions(TOKEN),
        mf.owner(local_key(OWNER_KEY)).agent_posting(ACCOUNT),
        mf.on_notes(TOKEN, lambda p: None),
    ]
    for call in calls:  # each is a coroutine: nothing was raised when it was made
        with pytest.raises(InvalidInputError) as e:
            await call
        assert e.value.field == "api"
        assert "This call needs the Mercurifi API (streams, signals and notes)" in str(e.value)


async def test_writes_send_the_bearer_and_never_the_api_key() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path == "/v1/agent-auth/nonce":
            b = json.loads(request.content)
            nonce, t = "ab" * 16, int(time.time())
            e = SignInExpect(b["kind"], b["account"], b["signer"], LOCAL_CHAIN_ID, "launch")
            message = build_sign_in_message(
                e,
                nonce,
                datetime.fromtimestamp(t, timezone.utc),
                datetime.fromtimestamp(t + 300, timezone.utc),
            )
            return httpx.Response(
                200, json={"nonce": nonce, "message": message, "issuedAt": t, "expiresAt": t + 300}
            )
        if path == "/v1/agent-auth/session":
            return httpx.Response(
                200,
                json={
                    "token": "session-token-1",
                    "kind": "agent",
                    "account": ACCOUNT,
                    "expiresAt": int(time.time()) + 3600,
                },
            )
        return httpx.Response(204)

    api = HttpApi(
        "http://127.0.0.1:9",
        LOCAL_CHAIN_ID,
        api_key="mfk_test_secretkey",
        transport=httpx.MockTransport(handle),
    )
    mf = await client_with(api)
    agent = await mf.agent(ACCOUNT, SIGNER)
    await agent.signal(TOKEN, "bearish")
    write = next(r for r in seen if r.method == "PUT")
    assert write.url.path == f"/v1/tokens/{TOKEN}/reactions"
    assert write.headers["Authorization"] == "Bearer session-token-1"
    assert all("X-Api-Key" not in r.headers for r in seen)
    await api.aclose()


# Reader calls


async def test_reads_need_no_session() -> None:
    mf, api = await fake_client()
    await mf.notes.list(TOKEN)
    await mf.notes.replies(7, limit=5)
    await mf.notes.get(7)
    await mf.notes.marks(TOKEN, start=10, end=20)
    assert (await mf.reactions(TOKEN))["mine"] is None
    api.list_notes.assert_awaited_once_with(TOKEN, cursor=None, limit=None)
    api.list_replies.assert_awaited_once_with(7, cursor=None, limit=5)
    api.get_note.assert_awaited_once_with(7)
    api.note_marks.assert_awaited_once_with(TOKEN, 10, 20)
    api.get_reactions.assert_awaited_once_with(TOKEN)
    api.sign_in_challenge.assert_not_awaited()


async def test_on_notes_fetches_at_once_and_on_open_and_coalesces_a_burst() -> None:
    mf, api = await fake_client()
    listed = DeferredList(api)
    s = LiveSse()
    on_open = Mock()
    pages: list[int] = []
    done = asyncio.ensure_future(
        mf.on_notes(
            TOKEN,
            lambda p: pages.append(p["notes"][0]["id"]),
            **stream_options(s.transport, on_open=on_open),
        )
    )
    await until(lambda: on_open.call_count == 1)
    assert listed.calls == 1  # the open is queued behind the first fetch
    s.push("id: 1\nevent: notes\ndata: {}\n\nid: 2\nevent: trade\ndata: {}\n\n")
    s.push("id: 3\nevent: notes\ndata: {}\n\nid: 4\nevent: reset\ndata: {}\n\n")
    await settle()
    listed.version = 1
    listed.resolve()
    await until(lambda: listed.calls == 2)  # the whole burst became one refetch
    listed.resolve()
    await settle()
    assert listed.calls == 2
    s.end()
    await done
    assert pages == [0, 1]
    assert api.topics == [[f"token:{TOKEN.lower()}"]]
    assert others() == set()


@pytest.mark.parametrize("k", range(16))
async def test_on_notes_never_drops_an_event_around_the_end_of_a_refetch(k: int) -> None:
    mf, api = await fake_client()
    listed = DeferredList(api)
    s = LiveSse()
    on_open = Mock()
    pages: list[int] = []
    done = asyncio.ensure_future(
        mf.on_notes(
            TOKEN,
            lambda p: pages.append(p["notes"][0]["id"]),
            **stream_options(s.transport, on_open=on_open),
        )
    )
    await until(lambda: on_open.call_count == 1)
    listed.resolve()  # the first fetch; the fetch queued by the open starts
    await until(lambda: listed.calls == 2)
    # That fetch read version 0. A new note arrives while it finishes: its event must cause one more fetch.
    listed.version = 1
    s.push("id: 1\nevent: notes\ndata: {}\n\n")
    await settle(k)
    listed.resolve()
    await until(lambda: listed.calls == 3)
    listed.resolve()
    s.end()
    await done
    assert pages == [0, 0, 1]


async def test_on_notes_never_calls_the_handler_after_a_cancel_and_leaves_no_task() -> None:
    mf, api = await fake_client()
    listed = DeferredList(api)
    s = LiveSse()
    on_open = Mock()
    handler = Mock()
    done = asyncio.ensure_future(
        mf.on_notes(TOKEN, handler, **stream_options(s.transport, on_open=on_open))
    )
    await until(lambda: on_open.call_count == 1)
    s.push("id: 1\nevent: notes\ndata: {}\n\n")
    await settle()
    done.cancel()
    with pytest.raises(asyncio.CancelledError):
        await done
    await settle()
    handler.assert_not_called()
    assert listed.calls == 1
    assert others() == set()


async def test_on_notes_skips_a_failed_fetch_and_fetches_again_on_the_next_event() -> None:
    mf, api = await fake_client()
    n = 0

    async def flaky(token: str, **kw: Any) -> dict[str, Any]:
        nonlocal n
        n += 1
        if n <= 2:
            raise RuntimeError("temporarily down")
        return page(n)

    api.list_notes.side_effect = flaky
    s = LiveSse()
    on_open = Mock()
    pages: list[int] = []
    done = asyncio.ensure_future(
        mf.on_notes(
            TOKEN,
            lambda p: pages.append(p["notes"][0]["id"]),
            **stream_options(s.transport, on_open=on_open),
        )
    )
    await until(lambda: on_open.call_count == 1 and n == 2)
    await settle()
    assert pages == []
    s.push("id: 1\nevent: notes\ndata: {}\n\n")
    await until(lambda: pages != [])
    s.end()
    await done
    assert pages == [3]


async def test_on_notes_ends_with_the_error_of_a_raising_handler_or_an_invalid_request() -> None:
    mf, api = await fake_client()

    def fail(p: dict[str, Any]) -> None:
        raise RuntimeError("handler failed")

    events = "id: 1\nevent: notes\ndata: {}\n\n"
    with pytest.raises(RuntimeError, match="handler failed"):
        await mf.on_notes(TOKEN, fail, **stream_options(one_shot(events)))
    api.list_notes.side_effect = InvalidInputError("limit", "limit is out of range")
    with pytest.raises(InvalidInputError):
        await mf.on_notes(TOKEN, lambda p: None, **stream_options(one_shot(events)))
    assert others() == set()


async def test_on_notes_refuses_a_bad_token_before_any_fetch() -> None:
    mf, api = await fake_client()
    with pytest.raises(InvalidInputError):
        await mf.on_notes("nope", lambda p: None)
    api.list_notes.assert_not_awaited()
    assert others() == set()


# Owner calls


async def test_owner_sessions_sign_in_as_the_owner() -> None:
    mf, api = await fake_client()
    owner_key = local_key(OWNER_KEY)
    owner = mf.owner(owner_key)
    assert await owner.set_agent_posting(ACCOUNT, False) == {"enabled": False, "updatedAt": 1}
    api.sign_in_challenge.assert_awaited_once_with("owner", ACCOUNT, owner_key.address)
    api.set_posting.assert_awaited_once_with(ACCOUNT, False, "bearer-1")
    await owner.delete_agent_note(ACCOUNT, 7)
    assert await owner.delete_agent_notes(ACCOUNT) == {"deleted": 3}
    api.delete_note.assert_awaited_once_with(7, "bearer-1")
    api.delete_agent_notes.assert_awaited_once_with(ACCOUNT, "bearer-1")
    assert api.sign_in.await_count == 1
    assert await owner.agent_posting(ACCOUNT) == {"enabled": True, "updatedAt": None}
    api.get_posting.assert_awaited_once_with(ACCOUNT)
    await owner.sign_out()
    api.sign_out.assert_awaited_once_with("bearer-1")


async def test_one_owner_session_per_account_whatever_its_case() -> None:
    mf, api = await fake_client()
    owner = mf.owner(local_key(OWNER_KEY))
    await owner.set_agent_posting(ACCOUNT, True)
    await owner.set_agent_posting(ACCOUNT.lower(), True)
    await owner.set_agent_posting(A(0xAB), True)
    assert [c.args[1] for c in api.sign_in_challenge.await_args_list] == [ACCOUNT, A(0xAB)]
    assert [c.args[2] for c in api.set_posting.await_args_list] == [
        "bearer-1",
        "bearer-1",
        "bearer-2",
    ]
    with pytest.raises(InvalidInputError) as e:
        await owner.set_agent_posting("nope", True)
    assert e.value.field == "account"
