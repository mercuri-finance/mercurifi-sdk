"""Blocking facade: runs the async client on one private event-loop thread, for scripts and notebooks.

Why a thread and not `asyncio.run` per call: the HTTP clients and the per-key nonce locks belong to one event loop.
A single long-lived loop thread keeps them valid across calls, and any number of caller threads may use one `Client`
at once; their calls are scheduled on that loop and serialised there exactly as concurrent tasks would be.

Do not call a blocking method from inside a running event loop (it would block that loop; use `AsyncClient`), and do
not call one from a callback that runs on the SDK's loop thread (`on_warning`, `on_reconnect`): that raises instead of
deadlocking.
"""
from __future__ import annotations

import asyncio
import inspect
import threading
import weakref
from collections.abc import Coroutine, Iterator
from types import TracebackType
from typing import Any, TypeVar

from .agent import AgentClient
from .client import AsyncClient, create_client
from .owner import AccountManager, OwnerClient

T = TypeVar("T")


class _Runner:
    """One event loop on one daemon thread."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name="mercurifi-sdk", daemon=True)
        self.closed = False
        self.iterators: weakref.WeakSet[_BlockingIterator] = weakref.WeakSet()
        self._lock = threading.Lock()
        self.thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        if threading.current_thread() is self.thread:
            coro.close()
            raise RuntimeError("A blocking mercurifi call was made from the SDK's own event-loop thread (a callback?); this would deadlock. Use AsyncClient there.")
        with self._lock:
            if self.closed:
                coro.close()
                raise RuntimeError("This mercurifi Client is closed")
            future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return future.result()
        except BaseException:
            future.cancel()  # Ctrl-C or a failure while waiting: do not leave the work running
            raise

    def shutdown(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
        for it in list(self.iterators):
            it.close()
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        if not self.thread.is_alive():
            self.loop.close()


class _BlockingIterator:
    """An async iterator (a stream) as a plain iterator. `close()` (or leaving a `with` block) releases the connection."""

    def __init__(self, agen: Any, runner: _Runner) -> None:
        self._agen = agen
        self._runner = runner
        self._done = False
        runner.iterators.add(self)

    def __iter__(self) -> Iterator[Any]:
        return self

    def __next__(self) -> Any:
        if self._done:
            raise StopIteration
        try:
            return self._runner.run(self._agen.__anext__())
        except StopAsyncIteration:
            self._done = True
            raise StopIteration from None
        except BaseException:
            self._done = True
            raise

    def close(self) -> None:
        if self._done:
            return
        self._done = True
        aclose = getattr(self._agen, "aclose", None)
        if aclose is not None:
            try:
                self._runner.run(aclose())
            except RuntimeError:
                pass  # the client is already closed

    def __enter__(self) -> _BlockingIterator:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _wrap(value: Any, runner: _Runner) -> Any:
    if isinstance(value, (OwnerClient, AccountManager, AgentClient)):
        return _Sync(value, runner)
    if hasattr(value, "__anext__"):
        return _BlockingIterator(value, runner)
    return value


async def _await(awaitable: Any) -> Any:
    return await awaitable


class _Sync:
    """Same public methods and attributes as the wrapped object; coroutines block, streams become iterators."""

    def __init__(self, target: Any, runner: _Runner) -> None:
        self._target = target
        self._runner = runner

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)  # the facade is the public API only
        attr = getattr(self._target, name)
        if name == "api" and attr is not None:
            return _Sync(attr, self._runner)  # client.api.get_account(account, live=True) blocks too
        if inspect.iscoroutinefunction(attr):
            return lambda *a, **k: _wrap(self._runner.run(attr(*a, **k)), self._runner)
        if callable(attr):
            def call(*a: Any, **k: Any) -> Any:
                result = attr(*a, **k)
                if inspect.isawaitable(result):
                    result = self._runner.run(_await(result))
                return _wrap(result, self._runner)

            return call
        return attr

    def __repr__(self) -> str:
        return f"Sync{self._target!r}"


class Client(_Sync):
    """`Client("testnet")` mirrors `await create_client("testnet")`, with every call blocking. Thread-safe."""

    def __init__(self, network: Any, **options: Any) -> None:
        runner = _Runner()
        try:
            client: AsyncClient = runner.run(create_client(network, **options))
        except BaseException:
            runner.shutdown()
            raise
        super().__init__(client, runner)

    def close(self) -> None:
        """Closes open streams, the HTTP clients and the loop thread. Safe to call twice."""
        if self._runner.closed:
            return
        try:
            for it in list(self._runner.iterators):
                it.close()
            self._runner.run(self._target.aclose())
        except RuntimeError:
            pass
        finally:
            self._runner.shutdown()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        self.close()


__all__ = ["Client"]
