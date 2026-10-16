"""The agent and owner sign-in text (docs: Signals and notes). The SDK rebuilds it from its own inputs and refuses
to sign anything else; fixtures/vectors/agentsignin.json pins it across Go, TypeScript and Python."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from eth_utils.address import to_checksum_address

from .errors import SignInRefusedError

_SKEW = 120.0
_MIN_WINDOW = 1.0
_MAX_WINDOW = 300.0
_NONCE = re.compile(r"[0-9a-f]{32}", re.ASCII)
_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", re.ASCII)
_STAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
_SIGN_IN_WARNING = "Sign this only in the Mercurifi SDK, never on a website."


@dataclass(frozen=True)
class SignInExpect:
    """What the SDK expects to sign: everything but the server's nonce and times."""

    kind: Literal["agent", "owner"]
    account: str
    signer: str
    chain_id: int
    service: Literal["launch", "trade"]


def _stamp(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime(_STAMP_FORMAT)


def build_sign_in_message(e: SignInExpect, nonce: str, issued: datetime, expires: datetime) -> str:
    """The exact text the API issues; pinned by fixtures/vectors/agentsignin.json."""
    head = "Owner sign-in for account " if e.kind == "owner" else "Agent sign-in for account "
    who = "Owner: " if e.kind == "owner" else "Agent key: "
    return "\n".join(
        [
            f"{head}{to_checksum_address(e.account)} on Arc (chain {e.chain_id}, {e.service})",
            f"{who}{to_checksum_address(e.signer)}",
            f"Nonce: {nonce}",
            f"Issued: {_stamp(issued)}",
            f"Expires: {_stamp(expires)}",
            _SIGN_IN_WARNING,
        ]
    )


def _parse(raw: str) -> datetime:
    try:
        return datetime.strptime(raw, _STAMP_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        raise SignInRefusedError("text", "the message has no valid times") from None


def check_sign_in_message(e: SignInExpect, nonce: str, message: str, now: float) -> None:
    """Raise unless `message` is exactly the text this SDK would build for `e`, with the server's nonce and a
    window of at most five minutes that matches the local clock (`now`, epoch seconds) within two minutes."""
    if _NONCE.fullmatch(nonce) is None:
        raise SignInRefusedError("text", "the nonce is not 32 hex digits")
    issued_m = re.search(r"\nIssued: ([^\n]*)\n", message)
    expires_m = re.search(r"\nExpires: ([^\n]*)\n", message)
    if (
        issued_m is None
        or expires_m is None
        or _STAMP.fullmatch(issued_m.group(1)) is None
        or _STAMP.fullmatch(expires_m.group(1)) is None
    ):
        raise SignInRefusedError("text", "the message has no valid times")
    issued, expires = _parse(issued_m.group(1)), _parse(expires_m.group(1))
    if build_sign_in_message(e, nonce, issued, expires) != message:
        raise SignInRefusedError("text", "the message is not the sign-in text this SDK expects")
    window = (expires - issued).total_seconds()
    if window > _MAX_WINDOW:
        raise SignInRefusedError(
            "window",
            "the sign-in window is longer than five minutes (Expires is too far after Issued)",
        )
    if window < _MIN_WINDOW:
        raise SignInRefusedError(
            "window",
            "the sign-in window is too short or not positive (Expires must be at least one second after Issued)",
        )
    if abs(issued.timestamp() - now) > _SKEW:
        raise SignInRefusedError(
            "clock",
            "Issued is more than two minutes from the clock on this machine; sync it (NTP) and retry",
        )
    if expires.timestamp() < now - _SKEW:
        raise SignInRefusedError(
            "clock",
            "the sign-in has already expired by the clock on this machine; sync it (NTP) and retry",
        )
