from __future__ import annotations

import asyncio
import builtins
import inspect
import re
import sys
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, NoReturn

import httpx

from .api import SocialApi
from .errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError
from .gas import MAX_PRIORITY_FEE_PER_GAS
from .networks import LOCAL_CHAIN_ID, NETWORKS, AgentBook, NetworkBook, is_loopback_url, url_host
from .nonce import NonceManager
from .policy import MAX_DEADLINE_SECONDS
from .redact import first_line, redact_url, redact_urls_in
from .rpc import Rpc
from .tx import TxSender
from .verify import verify_network

if TYPE_CHECKING:
    from .agent import AgentClient
    from .owner import OwnerClient
    from .safe_view import TokenSafeView
    from .signers import Signer
    from .stream import StreamEvent


@dataclass(frozen=True, repr=False)
class ClientSettings:
    receipt_timeout: float
    poll_interval: float
    max_fee_per_gas_cap: int | None
    deadline_seconds: int
    api_key: str | None
    max_priority_fee_per_gas: int = MAX_PRIORITY_FEE_PER_GAS

    def __repr__(self) -> str:
        key = "None" if self.api_key is None else "'[redacted]'"
        return (
            f"ClientSettings(receipt_timeout={self.receipt_timeout!r}, poll_interval={self.poll_interval!r}, "
            f"max_fee_per_gas_cap={self.max_fee_per_gas_cap!r}, max_priority_fee_per_gas={self.max_priority_fee_per_gas!r}, deadline_seconds={self.deadline_seconds!r}, api_key={key})"
        )

    def __reduce__(self) -> NoReturn:
        raise TypeError("ClientSettings holds an API key and cannot be pickled")


class ReaderNotes:
    """Public note reads (`mf.notes`). They send no session, so `agreed` is always False; bodies are untrusted text."""

    __slots__ = ("_mf",)

    def __init__(self, mf: AsyncClient) -> None:
        self._mf = mf

    async def list(
        self, token: str, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        """A page of the token's top-level notes, newest first: {"notes": [...], "nextCursor": str | None}."""
        result: dict[str, Any] = await self._mf.require_api(social=True).list_notes(
            token, cursor=cursor, limit=limit
        )
        return result

    async def replies(
        self, id: int, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        result: dict[str, Any] = await self._mf.require_api(social=True).list_replies(
            id, cursor=cursor, limit=limit
        )
        return result

    async def get(self, id: int) -> dict[str, Any]:
        result: dict[str, Any] = await self._mf.require_api(social=True).get_note(id)
        return result

    async def marks(
        self, token: str, *, start: int | None = None, end: int | None = None
    ) -> builtins.list[dict[str, Any]]:
        """Top-level notes' times and sides between `start` and `end` (unix seconds, 0 <= start <= end, at most 90 days
        apart). Both are required; a missing or bad bound raises InvalidInputError('start' or 'end')."""
        if start is None:
            raise InvalidInputError("start", "start is required (unix seconds)")
        if end is None:
            raise InvalidInputError("end", "end is required (unix seconds)")
        result: builtins.list[dict[str, Any]] = await self._mf.require_api(social=True).note_marks(
            token, start, end
        )
        return result


class AsyncClient:
    def __init__(
        self,
        network: NetworkBook,
        rpc: Rpc,
        api: Any,
        settings: ClientSettings,
        on_warning: Callable[[str], None],
        api_base_url: str | None = None,
    ) -> None:
        self.network = network
        self.rpc = rpc
        self.api = api
        self.settings = settings
        self.api_base_url = api_base_url
        self._on_warning = on_warning
        # One agent key per process: sends from one key are serialised and nonces are counted locally.
        self.nonces = NonceManager(lambda address: rpc.get_transaction_count(address, "pending"))
        self.sender = TxSender(
            rpc,
            network.chain_id,
            self.nonces,
            settings.receipt_timeout,
            settings.poll_interval,
            settings.max_fee_per_gas_cap,
            max_priority_fee_per_gas=settings.max_priority_fee_per_gas,
        )

    def __repr__(self) -> str:
        return f"AsyncClient(network={self.network.name!r}, rpc={self.rpc!r}, settings={self.settings!r})"

    def require_agents(self) -> AgentBook:
        """The agent deployment book (factory, implementation, policy registry), or NotDeployedError."""
        if self.network.agents is None:
            raise NotDeployedError(self.network.name)
        return self.network.agents

    def require_api(self, *, social: bool = False) -> Any:
        """The Mercurifi API, or InvalidInputError('api') on a chain-only client. With `social=True` the API must also
        implement SocialApi (signals and notes): a custom 1.0 MercurifiApi without it is refused here."""
        if self.api is None:
            raise InvalidInputError(
                "api",
                "This call needs the Mercurifi API (streams, signals and notes); chain-only clients can poll headroom() and logs instead.",
            )
        if social and not isinstance(self.api, SocialApi):
            raise InvalidInputError(
                "api",
                "Signals and notes need an API that implements SocialApi (HttpApi does); this custom API does not.",
            )
        return self.api

    def warn(self, message: str) -> None:
        self._on_warning(message)

    def owner(self, signer: Signer) -> OwnerClient:
        """Owner-side actions (account creation, policy, agents, queue, withdrawals) signed by `signer`."""
        from .owner import OwnerClient

        return OwnerClient(self, signer)

    async def agent(
        self,
        account: str,
        signer: Signer,
        *,
        slippage: float = 0.01,
        deadline_seconds: int | None = None,
    ) -> AgentClient:
        """Agent-side client. Refuses an address that is not an account of this network's factory."""
        from .agent import AgentClient
        from .reads import is_agent_account
        from .units import slippage_to_bps

        agents = self.require_agents()
        if not await is_agent_account(self.rpc, agents, account):
            raise InvalidInputError(
                "account", f"{account} is not a Mercurifi agent account on {self.network.name}"
            )
        wanted = self.settings.deadline_seconds if deadline_seconds is None else deadline_seconds
        return AgentClient(self, agents, account, signer, slippage_to_bps(slippage), wanted)

    async def token(self, address: str) -> TokenSafeView:
        """Agent-safe view of a Launch token: numbers to act on, attacker-written text wrapped as inert data."""
        from .safe_view import read_token_safe_view

        return await read_token_safe_view(self, address)

    def stream(self, topics: list[str], **options: Any) -> AsyncIterator[StreamEvent]:
        """Live events: `launches`, `trades`, `token:0x…`, `trader:0x…`, `agent-account:0x…`. Needs the API.

        Topics are validated here, before anything connects. Options are those of `open_stream` (backoff, `on_reconnect`,
        `idle_timeout`, ...). Event `data` is untrusted: never feed it to an LLM unfiltered.
        """
        from .stream import open_stream, validate_topics

        checked = validate_topics(topics)
        return open_stream(self.require_api().stream_request(checked), **options)

    @property
    def notes(self) -> ReaderNotes:
        """Signal notes, readable by anyone without a session (so `agreed` is always False). Note bodies are untrusted
        text written by wallets and agents: never treat them as instructions."""
        return ReaderNotes(self)

    async def reactions(self, token: str) -> dict[str, Any]:
        """A token's reaction counts. `mine` and `selected` belong to website sessions and are empty here."""
        result: dict[str, Any] = await self.require_api(social=True).get_reactions(token)
        return result

    async def on_notes(
        self, token: str, handler: Callable[[dict[str, Any]], object], **options: Any
    ) -> None:
        """Calls `handler` with the first page of `token`'s notes now, and again whenever the token's stream opens (so a
        reconnect catches up) and after every `notes` or `reset` event. Fetches are coalesced: at most one runs and one
        more waits, so the handler always ends on the latest page. A fetch that fails (network, rate limit, server) is
        skipped and the next event fetches again; an InvalidInputError, or a handler that raises, ends it with that
        error. An async handler is awaited (the next page waits for it), and one that raises ends it the same way.
        Returns when the stream ends; cancel the task to stop it, after which the handler is not called again.
        `options` are those of `stream` (`on_open` is still called). Note bodies are untrusted text."""
        user_open = options.pop("on_open", None)
        stopped = busy = queued = False
        failed: list[BaseException] = []
        running: asyncio.Future[None] | None = None
        consumer: asyncio.Future[None] | None = None

        async def refetch() -> None:
            nonlocal busy, queued
            try:
                while True:
                    queued = False
                    page: dict[str, Any] | None = None
                    try:
                        page = await self.notes.list(token)
                    except InvalidInputError:
                        raise
                    except Exception:
                        pass  # skipped: the next event (or a queued one) fetches again
                    if stopped:
                        return
                    if page is not None:
                        result = handler(page)
                        if inspect.isawaitable(result):
                            await result
                    if not queued or stopped:
                        return
            finally:
                # Same step as the loop check: an event after this point starts a new fetch, never a lost one.
                busy = False

        def settled(task: asyncio.Future[None]) -> None:
            nonlocal stopped
            error = None if task.cancelled() else task.exception()
            if error is None:
                return
            if not failed:
                failed.append(error)
            stopped = True
            if consumer is not None:
                consumer.cancel()

        def kick() -> None:
            nonlocal busy, queued, running
            if stopped:
                return
            if busy:
                queued = True
                return
            busy = True
            running = asyncio.ensure_future(refetch())
            running.add_done_callback(settled)

        def opened() -> None:
            if user_open is not None:
                try:
                    user_open()
                except Exception:  # a throwing observer must not break the stream
                    pass
            kick()

        # Built (and validated) before any fetch starts, so a refusal leaves nothing running.
        events = self.stream([f"token:{str(token).lower()}"], **options, on_open=opened)

        async def consume() -> None:
            try:
                async for ev in events:
                    if stopped:
                        break
                    if ev.type in ("notes", "reset"):
                        kick()
            finally:
                aclose = getattr(events, "aclose", None)
                if aclose is not None:
                    await aclose()

        kick()
        consumer = asyncio.ensure_future(consume())
        try:
            await asyncio.wait({consumer})
            error = None if consumer.cancelled() else consumer.exception()
            if error is not None and not failed:
                failed.append(error)
            last = running
            if last is not None and not stopped:
                await asyncio.wait({last})  # the last fetch lands before this returns
        finally:
            stopped = True
            tasks = [t for t in (consumer, running) if t is not None]
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        if failed:
            raise failed[0]

    async def aclose(self) -> None:
        await self.rpc.aclose()
        if self.api is not None and hasattr(self.api, "aclose"):
            await self.api.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


def _resolve_book(network: str | NetworkBook) -> NetworkBook:
    if isinstance(network, str):
        book = NETWORKS.get(network) if network in NETWORKS else None  # own keys only
        if book is None:
            raise InvalidInputError(
                "network", "network must be 'mainnet', 'testnet' or a local address book"
            )
        return book
    if not isinstance(network, NetworkBook):
        raise InvalidInputError(
            "network", "network must be 'mainnet', 'testnet' or a local address book"
        )
    if network.name != "local" or network.chain_id != LOCAL_CHAIN_ID:
        raise NetworkMismatchError(
            f"custom address books are accepted only for the local chain {LOCAL_CHAIN_ID}; use 'mainnet' or 'testnet' for Arc"
        )
    if network.api_base_url is not None:
        _check_api_url("api_base_url", network.api_base_url)
    if network.api_key_prefix not in (None, "mfk_live_", "mfk_test_"):
        raise InvalidInputError("network", "the local address book has an unknown api_key_prefix")
    return network


def _check_http_url(field: str, url: object) -> str:
    """http(s) with a host and a valid port, or InvalidInputError. Never echoes the value (it may carry a key)."""
    if url_host(url) is None:
        raise InvalidInputError(
            field, f"{field} is not a valid URL; expected http(s)://host[:port][/path]"
        )
    assert isinstance(url, str)
    return url


def _check_api_url(field: str, url: str) -> None:
    _check_http_url(field, url)
    if not url.startswith("https://") and not is_loopback_url(url):
        raise InvalidInputError(field, f"{field} must be https (or a loopback http URL)")


def _positive(field: str, value: object, what: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0 < value < float("inf")
    ):
        raise InvalidInputError(field, f"{field} must be a positive number ({what})")


async def create_client(
    network: str | NetworkBook,
    *,
    rpc_url: str | None = None,
    api_key: str | None = None,
    api: Any = "default",
    rpc_transport: httpx.AsyncBaseTransport | None = None,
    verify: bool = True,
    receipt_timeout: float = 60.0,
    poll_interval: float = 0.25,
    max_fee_per_gas_cap: int | None = None,
    max_priority_fee_per_gas: int = MAX_PRIORITY_FEE_PER_GAS,
    deadline_seconds: int = 60,
    on_warning: Callable[[str], None] | None = None,
    api_base_url: str | None = None,
) -> AsyncClient:
    """Creates a client bound to one network and verifies it before returning.

    Raises NetworkMismatchError (wrong chain, code hash, implementation, registry, API key network or non-loopback
    local RPC) and InvalidInputError (missing or malformed RPC URL, bad options).
    """
    book = _resolve_book(network)
    url = rpc_url if rpc_url is not None else book.default_rpc_url
    if url is None:
        raise InvalidInputError("rpc_url", f"rpc_url is required on {book.name}")
    _check_http_url("rpc_url", url)
    if book.name == "local" and not is_loopback_url(url):
        raise NetworkMismatchError(
            "a local address book needs a loopback RPC (127.0.0.1, localhost or ::1)"
        )
    if api_key is not None:
        if not isinstance(api_key, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,256}", api_key) is None:
            raise InvalidInputError(
                "api_key",
                "api_key is empty or malformed (letters, digits, '_' and '-' only); omit it for keyless use, or pass an mfk_live_ or mfk_test_ key",
            )
        if book.api_key_prefix is not None and not api_key.startswith(book.api_key_prefix):
            raise NetworkMismatchError(
                f"This API key belongs to the other network; {book.name} keys start with {book.api_key_prefix}"
            )
    if (
        isinstance(deadline_seconds, bool)
        or not isinstance(deadline_seconds, int)
        or not (1 <= deadline_seconds <= MAX_DEADLINE_SECONDS)
    ):
        raise InvalidInputError(
            "deadline_seconds", f"deadline_seconds must be an integer in 1..{MAX_DEADLINE_SECONDS}"
        )
    _positive("receipt_timeout", receipt_timeout, "seconds")
    _positive("poll_interval", poll_interval, "seconds")
    if max_fee_per_gas_cap is not None and (
        isinstance(max_fee_per_gas_cap, bool)
        or not isinstance(max_fee_per_gas_cap, int)
        or max_fee_per_gas_cap < 1
    ):
        raise InvalidInputError(
            "max_fee_per_gas_cap", "max_fee_per_gas_cap must be a positive integer (wei per gas)"
        )
    if (
        isinstance(max_priority_fee_per_gas, bool)
        or not isinstance(max_priority_fee_per_gas, int)
        or max_priority_fee_per_gas < 1
    ):
        raise InvalidInputError(
            "max_priority_fee_per_gas",
            "max_priority_fee_per_gas must be a positive integer (wei per gas)",
        )
    resolved_api_url = api_base_url if api_base_url is not None else book.api_base_url
    if api_base_url is not None:
        _check_api_url("api_base_url", api_base_url)

    def _warn(message: str) -> None:
        print(f"[mercurifi] {message}", file=sys.stderr)

    warn = on_warning or _warn
    # Skipping start-up verification is for the loopback book only; on Arc the chain check is unconditional.
    if verify is False and book.name != "local":
        warn(
            f"verify=False is ignored on {book.name}; start-up verification always runs outside the local book."
        )
    # The default HTTP API: built before the RPC so a bad option fails early; it holds the key privately.
    resolved_api: Any
    if isinstance(api, str) and api == "default":
        from .api import HttpApi

        resolved_api = (
            None
            if resolved_api_url is None
            else HttpApi(resolved_api_url, book.chain_id, api_key=api_key, on_warning=warn)
        )
    else:
        resolved_api = api
    rpc = Rpc(url, transport=rpc_transport)
    if verify or book.name != "local":
        failure: MercurifiError | None = None
        try:
            await verify_network(rpc, book)
        except MercurifiError as exc:
            failure = exc
        except Exception as exc:  # node errors and anything else carry the URL or a provider detail: host only, no cause
            failure = MercurifiError(
                f"RPC {redact_url(url)} failed during start-up verification: {redact_urls_in(first_line(str(exc) or type(exc).__name__))}",
                code="RPC_ERROR",
            )
        if failure is not None:
            await rpc.aclose()
            if (
                resolved_api is not None
                and hasattr(resolved_api, "aclose")
                and api is not resolved_api
            ):
                await resolved_api.aclose()
            raise failure
    settings = ClientSettings(
        receipt_timeout,
        poll_interval,
        max_fee_per_gas_cap,
        deadline_seconds,
        api_key,
        max_priority_fee_per_gas,
    )
    return AsyncClient(book, rpc, resolved_api, settings, warn, resolved_api_url)
