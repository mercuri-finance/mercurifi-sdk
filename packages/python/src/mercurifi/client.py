from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, NoReturn

import httpx

from .errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError
from .networks import LOCAL_CHAIN_ID, NETWORKS, AgentBook, NetworkBook, is_loopback_url, url_host
from .policy import MAX_DEADLINE_SECONDS
from .redact import first_line, redact_url, redact_urls_in
from .rpc import Rpc, RpcError
from .verify import verify_network


@dataclass(frozen=True, repr=False)
class ClientSettings:
    receipt_timeout: float
    poll_interval: float
    max_fee_per_gas_cap: int | None
    deadline_seconds: int
    api_key: str | None

    def __repr__(self) -> str:
        key = "None" if self.api_key is None else "'[redacted]'"
        return (
            f"ClientSettings(receipt_timeout={self.receipt_timeout!r}, poll_interval={self.poll_interval!r}, "
            f"max_fee_per_gas_cap={self.max_fee_per_gas_cap!r}, deadline_seconds={self.deadline_seconds!r}, api_key={key})"
        )

    def __reduce__(self) -> NoReturn:
        raise TypeError("ClientSettings holds an API key and cannot be pickled")


class AsyncClient:
    def __init__(
        self, network: NetworkBook, rpc: Rpc, api: Any, settings: ClientSettings, on_warning: Callable[[str], None],
        api_base_url: str | None = None,
    ) -> None:
        self.network = network
        self.rpc = rpc
        self.api = api
        self.settings = settings
        self.api_base_url = api_base_url
        self._on_warning = on_warning

    def __repr__(self) -> str:
        return f"AsyncClient(network={self.network.name!r}, rpc={self.rpc!r}, settings={self.settings!r})"

    def require_agents(self) -> AgentBook:
        """The agent deployment book (factory, implementation, policy registry), or NotDeployedError."""
        if self.network.agents is None:
            raise NotDeployedError(self.network.name)
        return self.network.agents

    def warn(self, message: str) -> None:
        self._on_warning(message)

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
            raise InvalidInputError("network", "network must be 'mainnet', 'testnet' or a local address book")
        return book
    if not isinstance(network, NetworkBook):
        raise InvalidInputError("network", "network must be 'mainnet', 'testnet' or a local address book")
    if network.name != "local" or network.chain_id != LOCAL_CHAIN_ID:
        raise NetworkMismatchError(f"custom address books are accepted only for the local chain {LOCAL_CHAIN_ID}; use 'mainnet' or 'testnet' for Arc")
    if network.api_base_url is not None:
        _check_api_url("api_base_url", network.api_base_url)
    if network.api_key_prefix not in (None, "mfk_live_", "mfk_test_"):
        raise InvalidInputError("network", "the local address book has an unknown api_key_prefix")
    return network


def _check_http_url(field: str, url: object) -> str:
    """http(s) with a host and a valid port, or InvalidInputError. Never echoes the value (it may carry a key)."""
    if url_host(url) is None:
        raise InvalidInputError(field, f"{field} is not a valid URL; expected http(s)://host[:port][/path]")
    assert isinstance(url, str)
    return url


def _check_api_url(field: str, url: str) -> None:
    _check_http_url(field, url)
    if not url.startswith("https://") and not is_loopback_url(url):
        raise InvalidInputError(field, f"{field} must be https (or a loopback http URL)")


def _positive(field: str, value: object, what: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < float("inf"):
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
        raise NetworkMismatchError("a local address book needs a loopback RPC (127.0.0.1, localhost or ::1)")
    if api_key is not None:
        if not isinstance(api_key, str) or api_key.strip(" \t\r\n") == "":
            raise InvalidInputError("api_key", "api_key is empty; omit it for keyless use, or pass a key that starts with mfk_live_ or mfk_test_")
        if book.api_key_prefix is not None and not api_key.startswith(book.api_key_prefix):
            raise NetworkMismatchError(f"This API key belongs to the other network; {book.name} keys start with {book.api_key_prefix}")
    if isinstance(deadline_seconds, bool) or not isinstance(deadline_seconds, int) or not (1 <= deadline_seconds <= MAX_DEADLINE_SECONDS):
        raise InvalidInputError("deadline_seconds", f"deadline_seconds must be an integer in 1..{MAX_DEADLINE_SECONDS}")
    _positive("receipt_timeout", receipt_timeout, "seconds")
    _positive("poll_interval", poll_interval, "seconds")
    if max_fee_per_gas_cap is not None and (isinstance(max_fee_per_gas_cap, bool) or not isinstance(max_fee_per_gas_cap, int) or max_fee_per_gas_cap < 1):
        raise InvalidInputError("max_fee_per_gas_cap", "max_fee_per_gas_cap must be a positive integer (wei per gas)")
    resolved_api_url = api_base_url if api_base_url is not None else book.api_base_url
    if api_base_url is not None:
        _check_api_url("api_base_url", api_base_url)

    def _warn(message: str) -> None:
        print(f"[mercurifi] {message}", file=sys.stderr)

    warn = on_warning or _warn
    # Skipping start-up verification is for the loopback book only; on Arc the chain check is unconditional.
    if verify is False and book.name != "local":
        warn(f"verify=False is ignored on {book.name}; start-up verification always runs outside the local book.")
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
            raise failure
    settings = ClientSettings(receipt_timeout, poll_interval, max_fee_per_gas_cap, deadline_seconds, api_key)
    # The default HTTP API arrives in Task P9; until then "default" resolves to None.
    resolved_api: Any = None if isinstance(api, str) and api == "default" else api
    return AsyncClient(book, rpc, resolved_api, settings, warn, resolved_api_url)
