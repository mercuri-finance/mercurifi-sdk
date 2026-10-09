"""Signers. The SDK never transmits, logs or persists a private key: it is not in repr, str, vars(), pickle or an error."""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, NoReturn, Protocol

from eth_account import Account
from eth_account.signers.local import LocalAccount
from eth_account.typed_transactions.typed_transaction import TypedTransaction

from .errors import InvalidInputError, MercurifiError
from .redact import first_line, redact_urls_in

_KEY = re.compile(r"0x[0-9a-fA-F]{64}")
# secp256k1 group order, and half of it: a larger s is the malleable twin, which nodes reject.
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_HALF_N = _N // 2


class Signer(Protocol):
    """Signs Arc transactions (EIP-1559 dicts). The SDK never sees more of a signer than this."""

    address: str

    async def sign_transaction(self, tx: dict[str, Any]) -> bytes: ...


class _Sealed:
    """Base for objects that hide a secret: slots only (no __dict__ to dump), read-only, never pickled or copied."""

    __slots__ = ()

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"{type(self).__name__} is read-only")

    def __delattr__(self, name: str) -> None:
        raise AttributeError(f"{type(self).__name__} is read-only")

    def __reduce__(self) -> NoReturn:
        raise TypeError(f"{type(self).__name__} cannot be pickled, copied or persisted")

    def __reduce_ex__(self, protocol: Any) -> NoReturn:
        raise TypeError(f"{type(self).__name__} cannot be pickled, copied or persisted")


def _set(obj: object, **values: object) -> None:
    for name, value in values.items():
        object.__setattr__(obj, name, value)


def _account_from(private_key: object) -> LocalAccount | None:
    """Validates and loads a key. Never raises, and clears every local that held the key before returning, so a
    traceback taken later (Sentry local variables, loguru diagnose, rich) cannot contain it."""
    account: LocalAccount | None = None
    key: str | None = None
    try:
        if isinstance(private_key, str):
            key = private_key if private_key.startswith("0x") else f"0x{private_key}"
            if _KEY.fullmatch(key) is not None:
                account = Account.from_key(key)
    except Exception:  # deliberately dropped: nothing derived from the key may reach a message
        account = None
    finally:
        key = None
        private_key = None
    return account


class LocalKeySigner(_Sealed):
    """Signs with a key held in this process. The key lives only in a closure: not an attribute, not in any message.
    Build one with `local_key`."""

    __slots__ = ("address", "_sign")
    address: str
    _sign: Callable[[dict[str, Any]], bytes]

    def __init__(self, account: LocalAccount) -> None:
        def sign(tx: dict[str, Any]) -> bytes:
            return bytes(account.sign_transaction(tx).raw_transaction)

        _set(self, address=account.address, _sign=sign)

    async def sign_transaction(self, tx: dict[str, Any]) -> bytes:
        failure: MercurifiError | None = None
        try:
            return self._sign(tx)
        except Exception as exc:  # eth_account frames hold the key: raise a fresh error outside, with no traceback into them
            failure = MercurifiError(f"The signer failed: {redact_urls_in(first_line(str(exc) or type(exc).__name__))}", code="SIGNER_ERROR")
        raise failure

    def __repr__(self) -> str:
        return f"LocalKeySigner({getattr(self, 'address', '?')})"


def local_key(private_key: str) -> LocalKeySigner:
    """A signer over a private key. Raises InvalidInputError for non-string input or anything but a valid 32-byte hex key.

    Every frame that held the key is cleared before the error is raised.
    """
    account = _account_from(private_key)
    private_key = None  # type: ignore[assignment]
    if account is None:
        raise InvalidInputError("private_key", "expected a 32-byte hex private key as a string (0x plus 64 hex digits, non-zero, below the curve order)")
    return LocalKeySigner(account)


class AgentKey(_Sealed):
    """A freshly generated agent key. The secret is not in repr, str, vars() or pickle, and there is no attribute for it;
    read it on purpose with `export_private_key()` and store it on your server only."""

    __slots__ = ("address", "_export")
    address: str
    _export: Callable[[], str]

    def __init__(self, address: str, private_key: str) -> None:
        def export() -> str:
            return private_key

        _set(self, address=address, _export=export)

    def export_private_key(self) -> str:
        return self._export()

    def __repr__(self) -> str:
        return f"AgentKey(address={getattr(self, 'address', '?')})"


def generate_agent_key() -> AgentKey:
    """A new key from the OS CSPRNG. The SDK keeps no copy."""
    acct = Account.create()
    return AgentKey(acct.address, "0x" + bytes(acct.key).hex())


class KmsAdapter(Protocol):
    """A remote signer (AWS KMS, GCP KMS, HSM) reduced to "sign this 32-byte digest": (r, s, y_parity).

    y_parity may be None (most KMS APIs return only DER r and s); the SDK then tries both parities. A high s is normalised.
    """

    address: str

    async def sign_digest(self, digest: bytes) -> tuple[int, int, int | None]: ...


def _mismatch(message: str) -> MercurifiError:
    return MercurifiError(message, code="KMS_SIGNATURE_MISMATCH")


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


class KmsSigner(_Sealed):
    """Wraps a KmsAdapter; every signature is recovered and checked against the adapter's address."""

    __slots__ = ("address", "_adapter")
    address: str
    _adapter: KmsAdapter

    def __init__(self, adapter: KmsAdapter) -> None:
        _set(self, address=adapter.address, _adapter=adapter)

    async def sign_transaction(self, tx: dict[str, Any]) -> bytes:
        digest = bytes(TypedTransaction.from_dict(dict(tx)).hash())
        signature = await self._adapter.sign_digest(digest)
        if not isinstance(signature, tuple) or len(signature) != 3:
            raise _mismatch("The KMS signature is malformed: expected (r, s, y_parity).")
        r, s, given = signature
        if not (_is_int(r) and _is_int(s)):
            raise _mismatch("The KMS signature has a malformed r or s.")
        if not 0 < r < _N or not 0 < s < _N:
            raise _mismatch("The KMS signature has an r or s outside 1..n-1.")
        if given is not None and (not _is_int(given) or given not in (0, 1)):
            raise _mismatch("The KMS signature has an invalid y_parity.")
        if s > _HALF_N:
            s = _N - s
            if given is not None:
                given = 1 - given
        for parity in (0, 1) if given is None else (given,):
            raw = bytes(TypedTransaction.from_dict({**tx, "v": parity, "r": r, "s": s}).encode())
            recovered = self._recover(raw)
            if recovered is not None and recovered.lower() == self.address.lower():
                return raw
        raise _mismatch("The KMS signature does not recover to the configured address (wrong key or wrong digest).")

    @staticmethod
    def _recover(raw: bytes) -> str | None:
        try:
            return str(Account.recover_transaction(raw))
        except Exception:
            return None

    def __repr__(self) -> str:
        return f"KmsSigner({getattr(self, 'address', '?')})"


def kms_signer(adapter: KmsAdapter) -> KmsSigner:
    return KmsSigner(adapter)
