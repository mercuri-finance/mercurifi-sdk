from __future__ import annotations

import copy
import pickle
from typing import Any

import pytest
from eth_account import Account

from mercurifi.errors import InvalidInputError, MercurifiError
from mercurifi.signers import generate_agent_key, kms_signer, local_key

from .helpers import OWNER_KEY

SECRET = OWNER_KEY[2:20]
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
TX: dict[str, Any] = {
    "type": 2, "chainId": 31337, "nonce": 1, "to": "0x0000000000000000000000000000000000000001", "value": 0, "data": "0x",
    "gas": 21_000, "maxFeePerGas": 20_000_000_000, "maxPriorityFeePerGas": 1,
}


def test_never_exposes_the_key() -> None:
    s = local_key(OWNER_KEY)
    shown = f"{s!r}{s}{vars(s)}{[getattr(s, n) for n in dir(s) if not n.startswith('_')]}"
    assert SECRET not in shown
    for op in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            op(s)
    with pytest.raises(AttributeError):
        s.address = "x"
    with pytest.raises(InvalidInputError, match="32-byte hex") as e:
        local_key(OWNER_KEY + "zz")
    assert SECRET not in str(e.value)


def test_rejects_non_string_and_out_of_range_keys() -> None:
    bad_values: list[Any] = [None, 5, b"0x" + b"11" * 32, {}, ["0x"]]
    for bad in bad_values:
        with pytest.raises(InvalidInputError):
            local_key(bad)
    with pytest.raises(InvalidInputError, match="not a valid secp256k1") as e:
        local_key("0x" + "00" * 32)
    assert e.value.__cause__ is None and e.value.__context__ is None


def test_generated_key_hides_its_secret() -> None:
    k = generate_agent_key()
    secret = k.export_private_key()[2:20]
    assert SECRET != secret
    assert secret not in f"{k!r}{k}{vars(k)}{k.__dict__}"
    for op in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError):
            op(k)
    assert Account.from_key(k.export_private_key()).address == k.address
    assert k.private_key == k.export_private_key()
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
        await kms_signer(Adapter(address="0x0000000000000000000000000000000000000002")).sign_transaction(TX)
    assert e.value.code == "KMS_SIGNATURE_MISMATCH"
    assert SECRET not in f"{kms_signer(Adapter())!r}{vars(kms_signer(Adapter()))}"


async def test_kms_normalises_a_high_s_and_flips_parity() -> None:
    raw = await kms_signer(Adapter(lambda r, s, p: (r, N - s, 1 - p))).sign_transaction(TX)
    assert Account.recover_transaction(raw) == Account.from_key(OWNER_KEY).address
    assert raw == bytes(Account.sign_transaction(TX, OWNER_KEY).raw_transaction)


async def test_kms_finds_the_recovery_id_itself() -> None:
    for flip in (False, True):
        raw = await kms_signer(Adapter(lambda r, s, p, flip=flip: (r, N - s if flip else s, None))).sign_transaction(TX)
        assert Account.recover_transaction(raw) == Account.from_key(OWNER_KEY).address


@pytest.mark.parametrize("mutate", [
    lambda r, s, p: (0, s, p), lambda r, s, p: (r, 0, p), lambda r, s, p: (r, N, p), lambda r, s, p: (N, s, p),
    lambda r, s, p: (N + 5, s, p), lambda r, s, p: (r, s, 2), lambda r, s, p: (True, s, p), lambda r, s, p: (r, s),
])
async def test_kms_rejects_malformed_signatures(mutate: Any) -> None:
    with pytest.raises(MercurifiError) as e:
        await kms_signer(Adapter(mutate)).sign_transaction(TX)
    assert e.value.code == "KMS_SIGNATURE_MISMATCH"
