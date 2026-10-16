"""One agent's (or owner's) API session for signals and notes. repr, str and pickle never show the bearer. The first
write signs in; concurrent writes share one sign-in; it renews five minutes before expiry and once after a 401."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, NoReturn, TypeVar

from .errors import (
    ApiError,
    InvalidInputError,
    MercurifiError,
    SignerCapabilityError,
    SignInRefusedError,
    social_error,
)
from .signin import SignInExpect, check_sign_in_message

T = TypeVar("T")
_RENEW = 300.0
_CHAIN_DEPTH = 16


def _cut(text: str, bearers: tuple[str, ...]) -> str:
    """`text` with every bearer replaced, so no surfaced error can carry one."""
    for b in bearers:
        if b:
            text = text.replace(b, "[redacted]")
    return text


def _text(value: object) -> str:
    """A value as text; one that cannot be printed cannot carry a bearer into output either."""
    try:
        return f"{value!s} {value!r}"
    except Exception:
        return ""


def _carries(value: object, bearers: tuple[str, ...]) -> bool:
    text = value if isinstance(value, str) else _text(value)
    return any(b and b in text for b in bearers)


def _chain_carries(e: BaseException | None, bearers: tuple[str, ...]) -> bool:
    seen: set[int] = set()
    todo = [e]
    while todo and len(seen) < _CHAIN_DEPTH:
        x = todo.pop()
        if x is None or id(x) in seen:
            continue
        seen.add(id(x))
        if _carries(x, bearers):
            return True
        todo += [x.__cause__, x.__context__]
    return False


def _surface(e: BaseException, bearers: tuple[str, ...]) -> BaseException:
    """A write's error, typed, with any bearer the server echoed cut from its message, args and chained errors."""
    out = e
    if isinstance(out, ApiError):
        if _carries(out.api_code, bearers) or _carries(out.args, bearers):
            out = ApiError(
                out.status,
                _cut(out.api_code, bearers),
                _cut(out.message, bearers),
                out.retry_after_seconds,
            ).with_traceback(e.__traceback__)
        typed = social_error(out)
        if typed is not out:
            out = typed.with_traceback(e.__traceback__)
    try:
        if _carries(out.args, bearers):
            out.args = tuple(
                _cut(a if isinstance(a, str) else _text(a), bearers) if _carries(a, bearers) else a
                for a in out.args
            )
        for link in ("__cause__", "__context__"):
            c = getattr(out, link)
            if _chain_carries(c, bearers):
                setattr(out, link, Exception(_cut(f"{type(c).__name__}: {c}", bearers)))
        clean = not _carries(out, bearers) and not _carries(getattr(out, "__dict__", ""), bearers)
    except Exception:
        clean = False
    return (
        out
        if clean
        else MercurifiError("a social write failed; its error carried the session bearer")
    )


class SocialSession:
    """One agent's (or owner's) session with the API for signals and notes. repr, str and pickle never show the
    bearer. The first write signs in; concurrent writes share one sign-in; the session renews five minutes before it
    expires, and once after a 401."""

    __slots__ = ("_api", "_expect", "_signer", "_now", "_state", "_pending")

    def __init__(
        self,
        api: Any,
        expect: SignInExpect,
        signer: Any,
        now: Callable[[], float] = time.time,
    ) -> None:
        if str(getattr(signer, "address", "")).lower() != expect.signer.lower():
            raise InvalidInputError("signer", "the signer is not the key the sign-in expects")
        self._api, self._expect, self._signer, self._now = api, expect, signer, now
        held: dict[str, Any] = {"bearer": None, "expires": 0.0}
        self._state: Callable[[], dict[str, Any]] = lambda: held
        self._pending: asyncio.Task[str] | None = None

    def __repr__(self) -> str:
        return f"SocialSession({self._expect.kind} {self._expect.account})"

    def __reduce__(self) -> NoReturn:
        raise TypeError("SocialSession cannot be pickled, copied or persisted")

    def __reduce_ex__(self, protocol: Any) -> NoReturn:
        raise TypeError("SocialSession cannot be pickled, copied or persisted")

    def _fresh(self) -> str | None:
        held = self._state()
        b: str | None = held["bearer"]
        return b if b is not None and self._now() < held["expires"] - _RENEW else None

    async def bearer(self) -> str:
        """The current bearer, signing in (once, however many callers wait) when there is none or it is near expiry."""
        b = self._fresh()
        if b is not None:
            return b
        task = self._pending
        if task is None:
            task = asyncio.ensure_future(self._sign_in())
            # A failure nobody awaits any more is still retrieved, so asyncio does not log it.
            task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
            self._pending = task
        return await asyncio.shield(task)

    async def _sign_in(self) -> str:
        try:
            sign = getattr(self._signer, "sign_sign_in", None)
            if sign is None:
                raise SignerCapabilityError("sign_sign_in")
            e = self._expect
            try:
                c = await self._api.sign_in_challenge(e.kind, e.account, self._signer.address)
                check_sign_in_message(e, c["nonce"], c["message"], self._now())
                sig: bytes = await sign(c["message"])
                s = await self._api.sign_in(c["nonce"], "0x" + sig.hex())
            except ApiError as exc:
                typed = social_error(exc)
                if typed is exc:
                    raise
                raise typed.with_traceback(exc.__traceback__) from None
            if s["kind"] != e.kind or str(s["account"]).lower() != e.account.lower():
                await self._refuse(s["token"], "the API opened a session for another account")
            if float(s["expiresAt"]) - _RENEW <= self._now():
                await self._refuse(
                    s["token"],
                    "the API opened a session that expires within five minutes (check the clock on this machine)",
                )
            held = self._state()
            held["bearer"], held["expires"] = s["token"], float(s["expiresAt"])
            return str(s["token"])
        finally:
            self._pending = None

    async def _refuse(self, token: str, message: str) -> NoReturn:
        """Ends a session the SDK will not use (best effort) and refuses it; the bearer is never kept."""
        try:
            await self._api.sign_out(token)
        except Exception:
            pass
        raise SignInRefusedError("text", message)

    async def run(self, write: Callable[[str], Awaitable[T]]) -> T:
        """Runs one write with the bearer; after a 401 from the write signs in again and runs it once more. A 401 from
        sign-in itself, and every other refusal, is not retried."""
        first = await self.bearer()
        failure: Exception | None = None
        try:
            return await write(first)
        except ApiError as exc:
            if exc.status != 401:
                failure = exc
        except Exception as exc:
            failure = exc
        # Raised outside the handler so the surfaced error gets no implicit __context__ holding the original.
        if failure is not None:
            raise _surface(failure, (first,))
        # A concurrent call may already have renewed it; only drop the bearer that failed.
        held = self._state()
        if held["bearer"] == first:
            held["bearer"] = None
        second = await self.bearer()
        try:
            return await write(second)
        except Exception as exc:
            failure = exc
        raise _surface(failure, (first, second))

    async def sign_out(self) -> None:
        """Ends the session on the server (best effort) and forgets the bearer."""
        p = self._pending
        if p is not None:
            try:
                await asyncio.shield(p)
            except Exception:
                pass
        held = self._state()
        b, held["bearer"], held["expires"] = held["bearer"], None, 0.0
        if b is not None:
            try:
                await self._api.sign_out(b)
            except Exception:
                pass
