from __future__ import annotations

import asyncio
import weakref
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class NonceManager:
    """One in-flight transaction per key, nonces counted locally after the first read.

    Sends from one address are serialised by an asyncio.Lock per address. Any failure inside `fn` (a drop, a send
    error, a timeout, a cancellation) forgets the local value, so the next send re-reads the pending count from the
    chain. Use one agent key per process: two processes sharing a key race for nonces; the account allows up to 8
    agent keys for parallelism, so give each process its own.

    Locks are kept per running event loop (an asyncio.Lock binds to the loop that first waits on it), so a wrapper
    that calls `asyncio.run` per call cannot hit a cross-loop RuntimeError here. The nonce cache is shared across
    loops, which is safe because sends are never concurrent across loops in one thread. The RPC client itself (httpx)
    is still bound to one loop: use one client per loop.
    """

    def __init__(self, fetch_pending: Callable[[str], Awaitable[int]]) -> None:
        self._fetch = fetch_pending
        self._next: dict[str, int] = {}
        # id(loop) -> (weak reference to the loop, locks by address). A contended lock holds its loop strongly, so a
        # weak-keyed map would never release it; entries of closed (or collected) loops are pruned on each access.
        self._locks: dict[
            int, tuple[weakref.ReferenceType[asyncio.AbstractEventLoop], dict[str, asyncio.Lock]]
        ] = {}

    def _locks_for_running_loop(self) -> dict[str, asyncio.Lock]:
        loop = asyncio.get_running_loop()
        for ident, (ref, _) in list(self._locks.items()):
            other = ref()
            if other is None or other.is_closed() or (ident == id(loop) and other is not loop):
                del self._locks[ident]
        entry = self._locks.get(id(loop))
        if entry is None:
            entry = (weakref.ref(loop), {})
            self._locks[id(loop)] = entry
        return entry[1]

    async def with_nonce(self, address: str, fn: Callable[[int], Awaitable[T]]) -> T:
        key = address.lower()
        lock = self._locks_for_running_loop().setdefault(key, asyncio.Lock())
        async with lock:
            nonce = self._next.get(key)
            if nonce is None:
                nonce = await self._fetch(address)
            try:
                result = await fn(nonce)
            except BaseException:
                self._next.pop(key, None)
                raise
            self._next[key] = nonce + 1
            return result

    def reset(self, address: str) -> None:
        self._next.pop(address.lower(), None)
