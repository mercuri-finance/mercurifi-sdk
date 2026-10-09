import threading
from typing import Any

import pytest

from mercurifi import Client
from mercurifi.errors import InvalidInputError
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
    with pytest.raises(RuntimeError, match="closed"):
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
