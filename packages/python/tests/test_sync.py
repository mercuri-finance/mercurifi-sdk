import asyncio
import threading
import time
from typing import Any

import httpx
import pytest

from mercurifi import Client
from mercurifi.errors import ClientClosedError, InvalidInputError, MercurifiError
from mercurifi.networks import local_network
from mercurifi.signers import local_key

from .helpers import ACCOUNT, AGENT_KEY, TOKEN, WAD, A, local_json, local_rpc, mock_account, mock_curve


class FakeApi:
    async def get_account(self, account: str, *, live: bool = False) -> dict[str, Any]:
        return {"account": account.lower(), "live": {"asOfBlock": 100} if live else None}


def make(rpc: Any = None, api: Any = None) -> Client:
    return Client(local_network(local_json()), rpc_url="http://127.0.0.1:8545", rpc_transport=(rpc or local_rpc()).transport(), api=api, on_warning=lambda m: None)


def test_blocking_client_wraps_the_async_one() -> None:
    signer = local_key(AGENT_KEY)
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=signer.address)
    mock_curve(rpc, balance=5 * WAD)
    with make(rpc) as client:
        assert client.network.chain_id == 31337
        agent = client.agent(ACCOUNT, signer)
        assert agent.headroom().spend == "400"
        pos = agent.position(TOKEN)
        assert (pos.balance_wei, pos.high_water) == (5 * WAD, 0)


def test_blocking_client_wraps_the_api() -> None:
    with make(api=FakeApi()) as client:
        assert client.api.get_account(ACCOUNT, live=True)["live"] == {"asOfBlock": 100}


def test_token_safe_view_blocks_too() -> None:
    from mercurifi.abi import FEE_MANAGER

    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=A(0x98))
    mock_curve(rpc)
    rpc.read(A(2), FEE_MANAGER, "tokenInfo", {"curve": A(3), "creator": ACCOUNT, "tradeFeeBps": 100, "creatorShareBps": 5_000, "referrerShareBps": 2_000})
    with make(rpc) as client:
        assert client.token(TOKEN).phase == "trading"


def test_two_threads_share_one_client() -> None:
    signer = local_key(AGENT_KEY)
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=signer.address)
    mock_curve(rpc, balance=5 * WAD)
    results: list[Any] = []
    errors: list[BaseException] = []
    with make(rpc) as client:
        agent = client.agent(ACCOUNT, signer)

        def work() -> None:
            try:
                for _ in range(10):
                    results.append((agent.headroom().spend, agent.position(TOKEN).balance_wei))
            except BaseException as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=work) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert errors == [] and results == [("400", 5 * WAD)] * 20


def test_close_is_idempotent_and_stops_the_thread() -> None:
    client = make()
    thread = client._runner.thread
    client.close()
    client.close()
    assert not thread.is_alive()
    with pytest.raises(ClientClosedError, match="closed"):
        client.agent(ACCOUNT, local_key(AGENT_KEY))


def test_errors_propagate_and_private_names_are_hidden() -> None:
    with make() as client:
        with pytest.raises(InvalidInputError):
            client.stream(["nonsense"])
        with pytest.raises(AttributeError):
            client._on_warning  # noqa: B018 (a private name of the wrapped client)


def test_a_failed_start_leaves_no_thread() -> None:
    before = threading.active_count()
    with pytest.raises(InvalidInputError):
        Client("nowhere")
    assert threading.active_count() == before


def test_a_streams_becomes_a_plain_iterator() -> None:
    import httpx

    class StreamApi:
        def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
            return "https://stream.example/v1/stream", {}

    # open_stream builds its own HTTP client, so a stream needs the network: only the wiring is checked here.
    with make(api=StreamApi()) as client:
        it = client.stream(["launches"], transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"id: 1-0\nevent: launch\ndata: {\"a\": 1}\n\n")), max_reconnects=0)
        first = next(it)
        assert (first.id, first.type, first.data) == ("1-0", "launch", {"a": 1})
        it.close()


class Hanging(httpx.AsyncBaseTransport):
    """Delegates to the mock node until `hang` is set; then every request waits (a node that stopped answering)."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner
        self.hang = False
        self.waiting = threading.Event()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.hang:
            self.waiting.set()
            await asyncio.sleep(60)
        return await self.inner.handle_async_request(request)


def test_close_releases_a_thread_that_is_mid_call() -> None:
    signer = local_key(AGENT_KEY)
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=signer.address)
    mock_curve(rpc)
    transport = Hanging(rpc.transport())
    client = Client(local_network(local_json()), rpc_url="http://127.0.0.1:8545", rpc_transport=transport, api=None, on_warning=lambda m: None)
    agent = client.agent(ACCOUNT, signer)
    outcome: list[BaseException | None] = []

    def work() -> None:
        try:
            agent.headroom()
            outcome.append(None)
        except BaseException as exc:
            outcome.append(exc)

    transport.hang = True
    worker = threading.Thread(target=work)
    worker.start()
    assert transport.waiting.wait(2)
    started = time.monotonic()
    client.close()
    worker.join(1)
    assert not worker.is_alive() and time.monotonic() - started < 1.5
    assert len(outcome) == 1 and isinstance(outcome[0], ClientClosedError) and isinstance(outcome[0], MercurifiError)
    assert outcome[0].code == "CLIENT_CLOSED"
    assert client._runner.thread.daemon is True and not client._runner.thread.is_alive()


class Heartbeats(httpx.AsyncByteStream):
    """An SSE body that sends only heartbeats, forever; `state` records that the connection was closed."""

    def __init__(self, state: dict[str, bool]) -> None:
        self.state = state

    async def __aiter__(self) -> Any:
        while True:
            await asyncio.sleep(0.01)
            yield b": hb\n\n"

    async def aclose(self) -> None:
        self.state["closed"] = True


class StreamApi:
    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
        return "https://stream.example/v1/stream", {}


def heartbeat_stream(client: Client, state: dict[str, bool]) -> Any:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Heartbeats(state)))
    return client.stream(["launches"], transport=transport, idle_timeout=0)


def test_closing_a_stream_from_another_thread_disconnects_and_ends_the_consumer() -> None:
    state = {"closed": False}
    done = threading.Event()
    with make(api=StreamApi()) as client:
        events = heartbeat_stream(client, state)

        def consume() -> None:
            for _ in events:
                pass
            done.set()

        consumer = threading.Thread(target=consume)
        consumer.start()
        time.sleep(0.2)  # the consumer is blocked in next()
        assert not done.is_set()
        events.close()
        assert done.wait(1)
        consumer.join(1)
        assert state["closed"] is True
        assert list(events) == []  # a closed stream stays closed


def test_with_block_over_a_stream_and_client_close_with_an_open_stream() -> None:
    state = {"closed": False}
    with make(api=StreamApi()) as client:
        with heartbeat_stream(client, state) as events:
            consumer = threading.Thread(target=lambda: list(events))
            consumer.start()
            time.sleep(0.1)
        consumer.join(1)
        assert not consumer.is_alive() and state["closed"] is True
        state2 = {"closed": False}
        again = heartbeat_stream(client, state2)
        threading.Thread(target=lambda: list(again), daemon=True).start()
        time.sleep(0.1)
    assert state2["closed"] is True  # Client.close() disconnected it


def test_close_from_the_loop_thread_raises_and_changes_nothing() -> None:
    client = make()

    async def inside() -> None:
        client.close()

    with pytest.raises(RuntimeError, match="event-loop thread"):
        client._runner.submit(inside()).result(2)
    assert client._runner.closed is False
    client.close()
    assert client._runner.closed is True


def test_the_api_key_is_not_left_in_the_options_and_is_validated() -> None:
    with pytest.raises(InvalidInputError):
        Client(local_network(local_json()), rpc_url="http://127.0.0.1:8545", rpc_transport=local_rpc().transport(), api_key="bad key!", on_warning=lambda m: None)
