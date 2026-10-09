"""Errors the SDK raises on purpose. `code` is stable across versions and identical to the TypeScript SDK."""
from __future__ import annotations


class MercurifiError(Exception):
    code = "MERCURIFI_ERROR"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code

    @property
    def message(self) -> str:
        return str(self)


class InvalidInputError(MercurifiError):
    """A caller-supplied value is malformed or out of range. Never echoes key material."""

    code = "INVALID_INPUT"

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


class NetworkMismatchError(MercurifiError):
    """The RPC, address book, API key or account belongs to another network, or a pinned code hash differs."""

    code = "NETWORK_MISMATCH"


class NotDeployedError(MercurifiError):
    """Agent Accounts have no recorded deployment on this network in this SDK build."""

    code = "NOT_DEPLOYED"

    def __init__(self, network: str) -> None:
        super().__init__(f"Mercurifi Agent Accounts are not deployed on {network} in this SDK version.")
        self.network = network


class NotOwnerError(MercurifiError):
    """The signer is not the account's owner."""

    code = "NOT_OWNER"


class GasPriceTooHighError(MercurifiError):
    """The current fee would exceed the caller's `max_fee_per_gas_cap`."""

    code = "GAS_PRICE_TOO_HIGH"

    def __init__(self, required_wei: int, cap_wei: int) -> None:
        super().__init__(f"The network needs at least {required_wei} wei per gas, above your cap of {cap_wei}.")
        self.required_wei = required_wei
        self.cap_wei = cap_wei


class TxDroppedError(MercurifiError):
    """No receipt within the wait budget. Arc drops some transactions without a receipt."""

    code = "TX_DROPPED"

    def __init__(self, tx_hash: str, seconds: float) -> None:
        super().__init__(
            f"No receipt for {tx_hash} after {seconds} s. Arc drops transactions priced under 20 gwei or sent from a "
            "blocklisted address without a receipt. The nonce is re-read before the next send."
        )
        self.tx_hash = tx_hash


class ApiError(MercurifiError):
    """The Mercurifi API answered with an error status. API keys never authorise funds."""

    code = "API_ERROR"

    def __init__(self, status: int, api_code: str, message: str, retry_after_seconds: float | None) -> None:
        super().__init__(message)
        self.status = status
        self.api_code = api_code
        self.retry_after_seconds = retry_after_seconds


class BuildMismatchError(MercurifiError):
    """Calldata built by the API does not match what was asked for; nothing was signed."""

    code = "BUILD_MISMATCH"

    def __init__(self, reason: str) -> None:
        super().__init__(f"Refusing API-built transaction: {reason}. Nothing was signed.")
        self.reason = reason


class StreamError(MercurifiError):
    """The event stream failed in a way a reconnect cannot fix (for example an unknown topic)."""

    code = "STREAM_ERROR"

    def __init__(self, message: str, status: int | None) -> None:
        super().__init__(message)
        self.status = status
