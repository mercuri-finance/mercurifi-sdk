from __future__ import annotations

import copy
import inspect
import pickle
from traceback import TracebackException
from typing import Any

import pytest
from eth_account import Account

from mercurifi.errors import InvalidInputError, MercurifiError
from mercurifi.signers import (
    AgentKey,
    KmsSigner,
    LocalKeySigner,
    generate_agent_key,
    kms_signer,
    local_key,
)

from .helpers import OWNER_KEY

SECRET = OWNER_KEY[2:20]
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
TX: dict[str, Any] = {
    "type": 2,
    "chainId": 31337,
    "nonce": 1,
    "to": "0x0000000000000000000000000000000000000001",
    "value": 0,
    "data": "0x",
    "gas": 21_000,
    "maxFeePerGas": 20_000_000_000,
    "maxPriorityFeePerGas": 1,
}


def test_never_exposes_the_key() -> None:
    s = local_key(OWNER_KEY)
    members = [v for _, v in inspect.getmembers(s) if not callable(v)]
    assert SECRET not in f"{s!r}{s}{members}"
    for op in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            op(s)
    with pytest.raises(TypeError):
        vars(s)  # slots only: there is no __dict__ to dump
    with pytest.raises(AttributeError):
        s.address = "x"
    with pytest.raises(AttributeError):
        s.extra = 1


def test_repr_is_safe_on_a_half_constructed_object() -> None:
    for cls in (LocalKeySigner, AgentKey, KmsSigner):
        assert "?" in repr(cls.__new__(cls))


def _frames_text(exc: BaseException) -> str:
    """Everything a tracebacks-with-locals tool could ship: formatted locals and every frame's f_locals repr."""
    out = "".join(TracebackException.from_exception(exc, capture_locals=True).format())
    tb = exc.__traceback__
    while tb is not None:
        out += "".join(f"{k}={v!r}" for k, v in tb.tb_frame.f_locals.items())
        tb = tb.tb_next
    ctx: BaseException | None = exc.__cause__ or exc.__context__
    return out + (_frames_text(ctx) if ctx is not None else "")


def _capture(supply: Any) -> BaseException:
    """The exception local_key raises for a supplied value. The value lives only on the stack, never in a local here."""
    try:
        local_key(supply())
    except InvalidInputError as exc:
        return exc
    raise AssertionError("local_key accepted the value")


WINDOWS = [OWNER_KEY[i : i + 12] for i in range(2, 66, 12)]


@pytest.mark.parametrize(
    "make",
    [
        lambda: OWNER_KEY + "\n",
        lambda: OWNER_KEY + "zz",
        lambda: OWNER_KEY[:-1],
        lambda: "0x" + format(N + 7, "064x"),
        lambda: "0x" + "00" * 32,
        lambda: OWNER_KEY.replace("5", "g", 1),
        lambda: "  " + OWNER_KEY,
        lambda: OWNER_KEY[2:] + "\n",
    ],
)
def test_rejected_key_never_reaches_frame_locals(make: Any) -> None:
    text = _frames_text(_capture(make))
    assert "local_key" in text  # the frames were walked
    for frag in WINDOWS:
        assert frag not in text and frag.upper() not in text
    assert format(N + 7, "064x")[:20] not in text


def test_rejected_non_string_never_reaches_frame_locals() -> None:
    text = _frames_text(_capture(lambda: bytes.fromhex(OWNER_KEY[2:])))
    assert "Y\\xc6" not in text and "\\x99^" not in text


async def test_signing_failure_and_kms_failure_leave_no_secret_in_frames() -> None:
    s = local_key(OWNER_KEY)
    with pytest.raises(MercurifiError) as e:
        await s.sign_transaction({**TX, "maxFeePerGas": "bad"})
    assert e.value.code == "SIGNER_ERROR"
    assert SECRET not in _frames_text(e.value) and e.value.__cause__ is None

    class Boom:
        address = Account.from_key(OWNER_KEY).address

        async def sign_digest(self, digest: bytes) -> tuple[int, int, int | None]:
            raise RuntimeError("kms unreachable")

    with pytest.raises(RuntimeError) as e2:
        await kms_signer(Boom()).sign_transaction(TX)
    assert SECRET not in _frames_text(e2.value)


def test_rejects_non_string_and_out_of_range_keys() -> None:
    bad_values: list[Any] = [None, 5, b"0x" + b"11" * 32, {}, ["0x"]]
    for bad in bad_values:
        with pytest.raises(InvalidInputError):
            local_key(bad)
    with pytest.raises(InvalidInputError, match="curve order") as e:
        local_key("0x" + "00" * 32)
    assert e.value.__cause__ is None and e.value.__context__ is None
    with pytest.raises(InvalidInputError, match="32-byte|64 hex") as e3:
        local_key(OWNER_KEY + "zz")
    assert SECRET not in str(e3.value)


def test_generated_key_hides_its_secret() -> None:
    k = generate_agent_key()
    secret = k.export_private_key()[2:20]
    assert SECRET != secret
    members = [v for _, v in inspect.getmembers(k) if not callable(v)]
    assert secret not in f"{k!r}{k}{members}"
    assert not hasattr(k, "private_key")
    with pytest.raises(TypeError):
        vars(k)
    for op in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            op(k)
    assert Account.from_key(k.export_private_key()).address == k.address
    assert generate_agent_key().export_private_key() != k.export_private_key()


async def test_signs_and_recovers() -> None:
    s = local_key(OWNER_KEY)
    raw = await s.sign_transaction(TX)
    assert Account.recover_transaction(raw) == s.address


class Adapter:
    """A KMS stand-in over a known key; `mutate` rewrites (r, s, parity) to model what real KMS APIs return."""

    def __init__(self, mutate: Any = None, address: str | None = None) -> None:
        self.address = address or Account.from_key(OWNER_KEY).address
        self._mutate = mutate

    async def sign_digest(self, digest: bytes) -> tuple[int, int, int | None]:
        sig = Account.unsafe_sign_hash(digest, OWNER_KEY)
        out: tuple[int, int, int | None] = (sig.r, sig.s, sig.v - 27)
        return out if self._mutate is None else tuple(self._mutate(*out))


async def test_kms_adapter_matches_local_signing() -> None:
    raw = await kms_signer(Adapter()).sign_transaction(TX)
    assert raw == bytes(Account.sign_transaction(TX, OWNER_KEY).raw_transaction)
    with pytest.raises(MercurifiError, match="does not recover") as e:
        await kms_signer(
            Adapter(address="0x0000000000000000000000000000000000000002")
        ).sign_transaction(TX)
    assert e.value.code == "KMS_SIGNATURE_MISMATCH"
    assert SECRET not in repr(kms_signer(Adapter()))


async def test_kms_normalises_a_high_s_and_flips_parity() -> None:
    raw = await kms_signer(Adapter(lambda r, s, p: (r, N - s, 1 - p))).sign_transaction(TX)
    assert Account.recover_transaction(raw) == Account.from_key(OWNER_KEY).address
    assert raw == bytes(Account.sign_transaction(TX, OWNER_KEY).raw_transaction)


async def test_kms_finds_the_recovery_id_itself() -> None:
    for flip in (False, True):
        raw = await kms_signer(
            Adapter(lambda r, s, p, flip=flip: (r, N - s if flip else s, None))
        ).sign_transaction(TX)
        assert Account.recover_transaction(raw) == Account.from_key(OWNER_KEY).address


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r, s, p: (0, s, p),
        lambda r, s, p: (r, 0, p),
        lambda r, s, p: (r, N, p),
        lambda r, s, p: (N, s, p),
        lambda r, s, p: (N + 5, s, p),
        lambda r, s, p: (r, s, 2),
        lambda r, s, p: (True, s, p),
        lambda r, s, p: (r, s),
    ],
)
async def test_kms_rejects_malformed_signatures(mutate: Any) -> None:
    with pytest.raises(MercurifiError) as e:
        await kms_signer(Adapter(mutate)).sign_transaction(TX)
    assert e.value.code == "KMS_SIGNATURE_MISMATCH"
