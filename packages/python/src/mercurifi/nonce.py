from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class NonceManager:
    """One in-flight transaction per key, nonces counted locally after the first read.

    Sends from one address are serialised by an asyncio.Lock per address. Any failure inside `fn` (a drop, a send
    error, a timeout, a cancellation) forgets the local value, so the next send re-reads the pending count from the
    chain. Use one agent key per process: two processes sharing a key race for nonces; the account allows up to 8
    agent keys for parallelism, so give each process its own.
    """

    def __init__(self, fetch_pending: Callable[[str], Awaitable[int]]) -> None:
        self._fetch = fetch_pending
        self._next: dict[str, int] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def with_nonce(self, address: str, fn: Callable[[int], Awaitable[T]]) -> T:
        key = address.lower()
        lock = self._locks.setdefault(key, asyncio.Lock())
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
