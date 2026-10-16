import asyncio
import pickle
from typing import Any
from unittest.mock import AsyncMock

import pytest

from mercurifi import errors as E
from mercurifi.errors import ApiError, social_error
from mercurifi.signers import LocalKeySigner, local_key
from mercurifi.signin import SignInExpect
from mercurifi.social import SocialSession

from .social_api import T0, FakeSocialApi

KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
ACCOUNT = "0x000000000000000000000000000000000000001E"


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t


class Setup:
    def __init__(self, expires_in: float = 3600) -> None:
        self.clock = Clock()
        self.api = FakeSocialApi(expires_in=expires_in, now=self.clock)
        self.signer = local_key(KEY)
        # Lowercase on purpose: the challenge echoes checksummed addresses and the check still passes.
        self.e = SignInExpect(
            "agent", ACCOUNT.lower(), self.signer.address, self.api.chain_id, "launch"
        )
        self.s = SocialSession(self.api, self.e, self.signer, self.clock)


def unauth(msg: str = "sign in required") -> ApiError:
    return ApiError(401, "unauthenticated", msg, None)


async def echo(b: str) -> str:
    return b


def once(first: Any, then: Any) -> Any:
    """A side effect that does `first` (raises it, or awaits it) on the first call and `then` afterwards."""
    calls = 0

    async def effect(*args: Any) -> Any:
        nonlocal calls
        calls += 1
        step = first if calls == 1 else then
        if isinstance(step, BaseException):
            raise step
        return await step(*args)

    return effect


class SpySigner:
    """A local key whose sign_sign_in calls are counted."""

    def __init__(self, inner: LocalKeySigner) -> None:
        self.address = inner.address
        self.sign_sign_in = AsyncMock(side_effect=inner.sign_sign_in)


async def test_one_sign_in_for_concurrent_writes_and_the_bearer_is_reused() -> None:
    x = Setup()
    seen = await asyncio.gather(x.s.run(echo), x.s.run(echo))
    assert list(seen) == ["bearer-1", "bearer-1"]
    assert x.api.sign_in_challenge.await_count == 1
    assert x.api.sign_in.await_count == 1
    assert await x.s.run(echo) == "bearer-1"
    assert x.api.sign_in.await_count == 1


async def test_signs_the_checked_challenge_with_the_agent_key() -> None:
    x = Setup()
    await x.s.bearer()
    assert x.api.sign_in.await_args is not None
    nonce, signature = x.api.sign_in.await_args.args
    assert signature == "0x" + (await x.signer.sign_sign_in(x.api.messages[0])).hex()
    assert nonce == format(1, "032x")


async def test_renews_five_minutes_before_expiry_not_earlier() -> None:
    x = Setup(expires_in=3600)
    await x.s.run(echo)
    expires = T0 + 3600
    x.clock.t = expires - 301
    assert await x.s.run(echo) == "bearer-1"
    assert x.api.sign_in.await_count == 1
    x.clock.t = expires - 299
    assert await x.s.run(echo) == "bearer-2"
    assert x.api.sign_in.await_count == 2


async def test_signs_in_again_once_after_a_write_401_and_retries() -> None:
    x = Setup()
    calls: list[str] = []

    async def write(b: str) -> str:
        calls.append(b)
        if b == "bearer-1":
            raise unauth()
        return b

    assert await x.s.run(write) == "bearer-2"
    assert calls == ["bearer-1", "bearer-2"]
    assert x.api.sign_in.await_count == 2


async def test_signs_in_again_once_after_a_401_then_gives_up() -> None:
    x = Setup()
    write = AsyncMock(side_effect=unauth())
    with pytest.raises(ApiError) as err:
        await x.s.run(write)
    assert err.value.status == 401
    assert write.await_count == 2
    assert x.api.sign_in.await_count == 2


async def test_a_401_from_sign_in_itself_is_not_retried() -> None:
    x = Setup()
    x.api.sign_in.side_effect = once(unauth("bad signature"), x.api.session)
    write = AsyncMock(side_effect=echo)
    with pytest.raises(ApiError) as err:
        await x.s.run(write)
    assert (err.value.status, err.value.api_code) == (401, "unauthenticated")
    assert x.api.sign_in.await_count == 1
    write.assert_not_awaited()


async def test_a_failed_sign_in_is_shared_and_not_cached() -> None:
    x = Setup()
    x.api.sign_in.side_effect = once(
        ApiError(403, "not_agent", "not an agent", None), x.api.session
    )
    out = await asyncio.gather(x.s.run(echo), x.s.run(echo), return_exceptions=True)
    assert all(isinstance(o, E.NotAgentError) for o in out)
    assert x.api.sign_in.await_count == 1
    assert await x.s.run(echo) == "bearer-1"


async def test_keeps_a_bearer_a_concurrent_call_renewed_after_a_401() -> None:
    x = Setup()
    await x.s.bearer()
    late = asyncio.Event()

    # The first write's 401 renews to bearer-2; the second write's 401 for bearer-1 arrives after that and must
    # reuse bearer-2 rather than throw it away.
    async def first(b: str) -> str:
        if b == "bearer-1":
            raise unauth()
        return b

    async def second(b: str) -> str:
        if b == "bearer-1":
            await late.wait()
            raise unauth()
        return b

    t2 = asyncio.ensure_future(x.s.run(second))
    await asyncio.sleep(0)  # the second write now holds bearer-1 and waits
    assert await x.s.run(first) == "bearer-2"
    late.set()
    assert await t2 == "bearer-2"
    assert x.api.sign_in.await_count == 2


@pytest.mark.parametrize(
    ("err", "cls"),
    [
        (ApiError(403, "posting_off", "off", None), E.PostingOffError),
        (ApiError(403, "forbidden", "owner only", None), ApiError),
        (ApiError(500, "internal", "boom", None), ApiError),
    ],
)
async def test_never_retries_other_refusals_and_types_them(
    err: ApiError, cls: type[ApiError]
) -> None:
    x = Setup()
    write = AsyncMock(side_effect=err)
    with pytest.raises(cls) as got:
        await x.s.run(write)
    assert type(got.value) is cls and got.value.api_code == err.api_code
    assert write.await_count == 1
    assert x.api.sign_in.await_count == 1


async def test_never_retries_a_429_and_keeps_retry_after() -> None:
    x = Setup()
    write = AsyncMock(side_effect=ApiError(429, "rate_limited", "slow down", 30))
    with pytest.raises(E.RateLimitedError) as err:
        await x.s.run(write)
    v = err.value
    assert (v.status, v.api_code, v.retry_after_seconds, v.code) == (
        429,
        "rate_limited",
        30,
        "API_ERROR",
    )
    assert write.await_count == 1


async def test_refuses_a_signer_without_sign_sign_in_before_any_request() -> None:
    x = Setup()

    class Bare:
        address = x.signer.address

        async def sign_transaction(self, tx: Any) -> bytes:
            return b""

    s = SocialSession(x.api, x.e, Bare(), x.clock)
    with pytest.raises(E.SignerCapabilityError):
        await s.run(echo)
    x.api.sign_in_challenge.assert_not_awaited()


def test_refuses_a_signer_that_is_not_the_expected_key() -> None:
    x = Setup()
    with pytest.raises(E.InvalidInputError):
        SocialSession(x.api, x.e, local_key("0x" + "11" * 32), x.clock)


async def test_refuses_a_challenge_for_another_account_without_signing() -> None:
    x = Setup()
    spy = SpySigner(x.signer)
    s = SocialSession(x.api, x.e, spy, x.clock)

    async def other(kind: str, account: str, signer: str) -> dict[str, Any]:
        return await x.api.challenge(kind, "0x000000000000000000000000000000000000dEaD", signer)

    x.api.sign_in_challenge.side_effect = other
    with pytest.raises(E.SignInRefusedError):
        await s.run(echo)
    spy.sign_sign_in.assert_not_awaited()
    x.api.sign_in.assert_not_awaited()


@pytest.mark.parametrize(
    ("patch", "why"),
    [
        ({"kind": "owner"}, "another account"),
        ({"account": "0x000000000000000000000000000000000000dEaD"}, "another account"),
        ({"expiresAt": int(T0) + 300}, "expires within"),
    ],
    ids=["another kind", "another account", "an expiry inside the renewal window"],
)
async def test_refuses_and_signs_out_a_mismatched_session(patch: dict[str, Any], why: str) -> None:
    x = Setup()

    async def patched(nonce: str, sig: str) -> dict[str, Any]:
        return {**(await x.api.session(nonce, sig)), **patch}

    x.api.sign_in.side_effect = once(patched, x.api.session)
    write = AsyncMock(side_effect=echo)
    with pytest.raises(E.SignInRefusedError) as err:
        await x.s.run(write)
    assert err.value.reason == "text" and why in str(err.value)
    x.api.sign_out.assert_awaited_once_with("bearer-1")
    write.assert_not_awaited()
    assert "bearer-1" not in str(err.value)
    assert await x.s.run(write) == "bearer-2"


async def test_never_shows_the_bearer() -> None:
    x = Setup()
    await x.s.run(echo)
    assert "bearer-1" not in repr(x.s) and "bearer-1" not in str(x.s)
    with pytest.raises(TypeError, match="cannot be pickled"):
        pickle.dumps(x.s)


def _all_text(e: BaseException) -> str:
    parts = [str(e), repr(e), repr(e.args), repr(getattr(e, "__dict__", {}))]
    for c in (e.__cause__, e.__context__):
        if c is not None:
            parts += [str(c), repr(c)]
    return " ".join(parts)


async def test_cuts_a_bearer_the_server_echoes_from_the_surfaced_error() -> None:
    x = Setup()

    async def write(b: str) -> str:
        raise unauth(f"token {b} is not valid")

    with pytest.raises(ApiError) as err:
        await x.s.run(write)
    text = _all_text(err.value)
    assert "bearer-1" not in text and "bearer-2" not in text
    assert "[redacted]" in str(err.value)
    back = pickle.loads(pickle.dumps(err.value))
    assert "bearer-" not in _all_text(back)


async def test_cuts_the_bearer_from_a_typed_refusal_and_its_code() -> None:
    x = Setup()

    async def write(b: str) -> str:
        raise ApiError(403, "paused", f"paused for {b}", None)

    with pytest.raises(E.PausedError) as err:
        await x.s.run(write)
    assert "bearer-1" not in _all_text(err.value)

    async def odd(b: str) -> str:
        raise ApiError(400, f"bad_{b}", "x", None)

    with pytest.raises(ApiError) as err2:
        await x.s.run(odd)
    assert "bearer-1" not in _all_text(err2.value)


async def test_cuts_the_bearer_from_a_cause_and_context() -> None:
    x = Setup()

    async def caused(b: str) -> str:
        raise RuntimeError("write failed") from ValueError(f"upstream saw {b}")

    with pytest.raises(RuntimeError) as err:
        await x.s.run(caused)
    assert "bearer-1" not in _all_text(err.value)
    assert "[redacted]" in str(err.value.__cause__)

    async def context(b: str) -> str:
        try:
            raise KeyError(b)
        except KeyError:
            raise RuntimeError("write failed") from None

    with pytest.raises(RuntimeError) as err2:
        await x.s.run(context)
    assert "bearer-1" not in _all_text(err2.value)


async def test_an_error_it_cannot_clean_is_replaced() -> None:
    x = Setup()

    class Stubborn(Exception):
        def __init__(self, secret: str) -> None:
            super().__init__("x")
            self.secret = secret

    async def write(b: str) -> str:
        raise Stubborn(b)

    with pytest.raises(E.MercurifiError, match="carried the session bearer") as err:
        await x.s.run(write)
    assert "bearer-1" not in _all_text(err.value)


async def test_signs_out_after_an_in_flight_sign_in_completes() -> None:
    x = Setup()
    release = asyncio.Event()

    async def held(nonce: str, sig: str) -> dict[str, Any]:
        await release.wait()
        return await x.api.session(nonce, sig)

    x.api.sign_in.side_effect = once(held, x.api.session)
    signing_in = asyncio.ensure_future(x.s.bearer())
    while x.api.sign_in.await_count == 0:
        await asyncio.sleep(0)
    out = asyncio.ensure_future(x.s.sign_out())
    await asyncio.sleep(0)
    release.set()
    await out
    assert await signing_in == "bearer-1"
    x.api.sign_out.assert_awaited_once_with("bearer-1")
    assert await x.s.bearer() == "bearer-2"


async def test_signs_out_once_and_forgets_the_bearer() -> None:
    x = Setup()
    await x.s.bearer()
    await x.s.sign_out()
    x.api.sign_out.assert_awaited_once_with("bearer-1")
    await x.s.sign_out()
    assert x.api.sign_out.await_count == 1
    assert await x.s.bearer() == "bearer-2"


SOCIAL = [
    ("signal_required", E.SignalRequiredError, 403),
    ("body_rejected", E.BodyRejectedError, 400),
    ("rate_limited", E.RateLimitedError, 429),
    ("posting_off", E.PostingOffError, 403),
    ("not_agent", E.NotAgentError, 403),
    ("agent_expired", E.AgentExpiredError, 403),
    ("not_owner", E.NotOwnerSocialError, 403),
    ("paused", E.PausedError, 403),
    ("chain_unavailable", E.ChainUnavailableError, 503),
    ("own_note", E.OwnNoteError, 403),
]


@pytest.mark.parametrize(("code", "cls", "status"), SOCIAL, ids=[c for c, _, _ in SOCIAL])
def test_social_error_maps_each_code_and_pickles(code: str, cls: type, status: int) -> None:
    out = social_error(ApiError(status, code, "m", 7))
    assert type(out) is cls and isinstance(out, ApiError)
    assert (out.status, out.api_code, out.message, out.retry_after_seconds, out.code) == (
        status,
        code,
        "m",
        7,
        "API_ERROR",
    )
    back = pickle.loads(pickle.dumps(out))
    assert type(back) is cls and back.__dict__ == out.__dict__ and str(back) == "m"


def test_social_error_leaves_forbidden_and_unknown_codes_unchanged() -> None:
    for code in ("forbidden", "__class__", "unauthenticated"):
        e = ApiError(403, code, "x", None)
        assert social_error(e) is e
