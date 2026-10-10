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
import concurrent.futures
import inspect
import threading
import weakref
from collections.abc import Coroutine, Iterator
from types import TracebackType
from typing import Any, TypeVar

from .agent import AgentClient
from .api import _Secret
from .client import AsyncClient, create_client
from .errors import ClientClosedError
from .owner import AccountManager, OwnerClient

T = TypeVar("T")


_LOOP_THREAD_MESSAGE = "A blocking mercurifi call was made from the SDK's own event-loop thread (a callback?); this would deadlock. Use AsyncClient there."


async def _await(awaitable: Any) -> Any:
    return await awaitable


async def _cancel_all() -> None:
    """Runs on the loop: cancels every other task and waits for each to unwind (their `finally` blocks run)."""
    me = asyncio.current_task()
    tasks = [t for t in asyncio.all_tasks() if t is not me]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


class _Runner:
    """One event loop on one daemon thread (daemon, so a stuck call can never keep the interpreter alive)."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name="mercurifi-sdk", daemon=True)
        self.closed = False
        self.iterators: weakref.WeakSet[_BlockingIterator] = weakref.WeakSet()
        self.futures: set[concurrent.futures.Future[Any]] = set()
        self._lock = threading.Lock()
        self.thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def guard(self) -> None:
        if threading.current_thread() is self.thread:
            raise RuntimeError(_LOOP_THREAD_MESSAGE)

    def submit(self, coro: Coroutine[Any, Any, T]) -> concurrent.futures.Future[T]:
        if threading.current_thread() is self.thread:
            coro.close()
            raise RuntimeError(_LOOP_THREAD_MESSAGE)
        with self._lock:
            if self.closed:
                coro.close()
                raise ClientClosedError("This mercurifi Client is closed")
            future = asyncio.run_coroutine_threadsafe(coro, self.loop)
            self.futures.add(future)
        future.add_done_callback(self.futures.discard)
        return future

    def wait(self, future: concurrent.futures.Future[T]) -> T:
        try:
            return future.result()
        except (concurrent.futures.CancelledError, asyncio.CancelledError):
            if self.closed:
                raise ClientClosedError(
                    "This mercurifi Client was closed while the call was running"
                ) from None
            raise
        except BaseException:
            future.cancel()  # Ctrl-C or a failure while waiting: do not leave the work running
            raise

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        return self.wait(self.submit(coro))

    def shutdown(self) -> None:
        """Refuses new calls, cancels the running ones (their callers get ClientClosedError), then stops the loop."""
        with self._lock:
            if self.closed:
                return
            self.closed = True
        try:
            asyncio.run_coroutine_threadsafe(_cancel_all(), self.loop).result(timeout=5)
        except BaseException:
            pass  # the backstop below still releases every waiting caller
        for f in list(self.futures):
            f.cancel()
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        if not self.thread.is_alive():
            self.loop.close()


class _BlockingIterator:
    """An async iterator (a stream) as a plain iterator. `close()` (from any thread) or leaving a `with` block cancels a
    `next()` that is waiting, releases the connection, and makes that `next()` end the iteration."""

    def __init__(self, agen: Any, runner: _Runner) -> None:
        self._agen = agen
        self._runner = runner
        self._lock = threading.Lock()
        self._closing = False
        self._inflight: concurrent.futures.Future[Any] | None = None
        self._task: list[asyncio.Task[Any]] = []
        runner.iterators.add(self)

    def __iter__(self) -> Iterator[Any]:
        return self

    async def _next(self) -> Any:
        task = asyncio.current_task()
        if task is not None:
            self._task.append(task)
        try:
            return await self._agen.__anext__()
        finally:
            self._task.clear()

    def __next__(self) -> Any:
        with self._lock:
            if self._closing:
                raise StopIteration
            future = self._runner.submit(self._next())
            self._inflight = future
        try:
            return self._runner.wait(future)
        except StopAsyncIteration:
            self._closing = True
            raise StopIteration from None
        except (concurrent.futures.CancelledError, asyncio.CancelledError, ClientClosedError):
            if self._closing:
                raise StopIteration from None
            raise
        finally:
            with self._lock:
                if self._inflight is future:
                    self._inflight = None

    async def _finish(self) -> None:
        for task in list(
            self._task
        ):  # unwind a pending __anext__ first: its `finally` blocks release the connection
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        aclose = getattr(self._agen, "aclose", None)
        if aclose is not None:
            await aclose()

    def close(self) -> None:
        with self._lock:
            if self._closing:
                return
            self._closing = True
            pending = self._inflight
        if pending is not None:
            pending.cancel()
        try:
            self._runner.run(self._finish())
        except ClientClosedError:
            pass  # the client is already closed; its shutdown unwound the stream

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


class _Sync:
    """Same public methods as the wrapped object. Coroutine methods run on the SDK's loop thread and block the caller.
    Plain (non-async) methods run on the CALLER's thread, exactly as in the async client (for example `mf.owner(signer)`
    and `owner.manage` construction, or `stream(...)` argument checks); if one returns an awaitable it is awaited on the
    loop. Results that are an owner, manager or agent object are wrapped again, and async iterators become plain
    iterators. Only `api` is wrapped among attributes; every other attribute is returned as it is (`network`, `rpc`,
    `settings`), so `mf.rpc` stays async. Names starting with an underscore are not reachable."""

    def __init__(self, target: Any, runner: _Runner) -> None:
        self._target = target
        self._runner = runner

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)  # the facade is the public API only
        attr = getattr(self._target, name)
        if name == "api" and attr is not None:
            return _Sync(
                attr, self._runner
            )  # client.api.get_account(account, live=True) blocks too
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
        # The API key leaves `options` at once and sits in a _Secret (no repr, vars() or pickle) until create_client needs it.
        raw_key = options.pop("api_key", None)
        secret = _Secret(raw_key) if isinstance(raw_key, str) else None
        passthrough = (
            None if isinstance(raw_key, str) else raw_key
        )  # None, or a bad value create_client will reject
        raw_key = None
        runner = _Runner()
        try:
            key: Any = passthrough if secret is None else secret.reveal()
            client: AsyncClient = runner.run(create_client(network, api_key=key, **options))
            key = None
        except BaseException:
            runner.shutdown()
            raise
        super().__init__(client, runner)

    def close(self) -> None:
        """Cancels running calls (their threads get ClientClosedError), closes streams, the HTTP clients and the loop
        thread. Safe to call twice; raises RuntimeError, changing nothing, when called from the loop thread."""
        self._runner.guard()
        if self._runner.closed:
            return
        try:
            for it in list(self._runner.iterators):
                it.close()
            self._runner.run(self._target.aclose())
        except ClientClosedError:
            pass
        finally:
            self._runner.shutdown()

    def __enter__(self) -> Client:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


__all__ = ["Client"]
