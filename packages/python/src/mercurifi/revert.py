"""Revert decoding with readable messages, identical in text to the TypeScript SDK (revert.ts).

Contract-supplied text (Error(string)) is untrusted: it is normalised, neutralised by the shared sanitiser, bounded and
quoted, and the raw string stays in `args` only. Decoding never raises.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .abi import (
    AGENT_ACCOUNT,
    AGENT_ACCOUNT_FACTORY,
    AGENT_POLICY_REGISTRY,
    BONDING_CURVE,
    FEE_MANAGER,
    GRADUATION_MANAGER,
    LAUNCH_FACTORY,
    LAUNCH_HOOK,
    LAUNCH_TOKEN,
    UNIVERSAL_ROUTER,
    V4_QUOTER,
)
from .codec import Contract, from_hex
from .errors import MercurifiError
from .policy import ABI_NAMES, POLICY_FIELDS
from .redact import js_strip, neutralize_untrusted, pre_bound, truncate_chars
from .rpc import RpcError
from .units import format_usdc6

# The three agent ABIs first (merged: a trade can revert from the account or the registry), then Launch and Uniswap.
# The first contract that declares a selector names it.
_SOURCES: tuple[Contract, ...] = (
    AGENT_ACCOUNT,
    AGENT_POLICY_REGISTRY,
    AGENT_ACCOUNT_FACTORY,
    BONDING_CURVE,
    LAUNCH_FACTORY,
    FEE_MANAGER,
    GRADUATION_MANAGER,
    LAUNCH_HOOK,
    LAUNCH_TOKEN,
    UNIVERSAL_ROUTER,
    V4_QUOTER,
)

_HEX = re.compile(r"0x(?:[0-9a-fA-F]{2})*")
_ERROR_SELECTOR = "0x08c379a0"
_PANIC_SELECTOR = "0x4e487b71"
_MAX_REASON = 200
_MAX_TIMESTAMP_MS = 8_640_000_000_000_000  # JavaScript's Date range


@dataclass(frozen=True)
class DecodedRevert:
    name: str
    args: list[Any]
    #: First ABI, in the order above, that declares the error; identical selectors share one message.
    source: str
    selector: str
    #: The full revert data as returned by the node ("0x" when none).
    data: str
    message: str


def _usdc(v: Any) -> str:
    return f"{format_usdc6(int(v))} USDC"


def _field(v: Any) -> str:
    if isinstance(v, int) and not isinstance(v, bool):
        return ABI_NAMES[POLICY_FIELDS[v]] if 0 <= v < len(POLICY_FIELDS) else f"#{v} (unknown)"
    if isinstance(v, str) and v.startswith("0x"):
        return from_hex(v).rstrip(b"\x00").decode("utf-8", "replace")
    return str(v)


def _time(v: Any) -> str:
    """ISO 8601 UTC with milliseconds, as JavaScript's Date.toISOString prints it (including years above 9999)."""
    seconds = int(v)
    if abs(seconds * 1000) > _MAX_TIMESTAMP_MS:
        raise ValueError("timestamp out of range")
    days, rest = divmod(seconds, 86_400)
    z = days + 719_468  # days from 0000-03-01
    era = z // 146_097
    doe = z - era * 146_097
    yoe = (doe - doe // 1_460 + doe // 36_524 - doe // 146_096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + 3 if mp < 10 else mp - 9
    year = yoe + era * 400 + (1 if month <= 2 else 0)
    shown = f"{year:04d}" if 0 <= year <= 9999 else f"{'-' if year < 0 else '+'}{abs(year):06d}"
    return f"{shown}-{month:02d}-{day:02d}T{rest // 3600:02d}:{rest % 3600 // 60:02d}:{rest % 60:02d}.000Z"


# Same keys and texts as the TypeScript ERROR_MESSAGES; policy fields are named in their ABI (camelCase) form.
# Every AgentAccount, AgentPolicyRegistry and factory error must be present.
ERROR_MESSAGES: dict[str, Callable[[list[Any]], str]] = {
    # Registry — agent preamble (authorize)
    "NotAgent": lambda a: "This key is not an active agent of the account: never added, revoked, or its addition is still queued.",
    "AgentExpired": lambda a: "This agent key has expired. The owner can extend it (a queued change) or add a new key.",
    "MissingPermission": lambda a: "This agent key does not have the permission this action needs.",
    "Paused": lambda a: "Agent actions are paused, by the account owner or by the platform guardian pause (at most 72 h).",
    "DeadlineOutOfRange": lambda a: "The deadline is outside [now, now + maxDeadlineSeconds]. The SDK builds deadlines from chain time; a custom deadline must respect the account limit.",
    "ActionLimit": lambda a: "The account has used all its actions for this period (maxActionsPerPeriod).",
    # Registry — period caps (record)
    "PeriodSpendExceeded": lambda a: f"Above the period spend cap. Remaining this period: {_usdc(a[0])}.",
    "PeriodSellExceeded": lambda a: f"Above the period sell cap. Sells are valued at the higher of the average and the high-water cost basis. Remaining this period: {_usdc(a[0])}.",
    "TokenCapExceeded": lambda a: f"Above the per-token period cap. Remaining for this token: {_usdc(a[0])}.",
    "LaunchLimit": lambda a: "The account has used all its launches for this period (launchesPerPeriod).",
    # Registry — owner side, agents and queue
    "NotOwner": lambda a: "Only the account owner can do this.",
    "NotAccount": lambda a: "The caller is not a registered agent account of this factory.",
    "NotFactory": lambda a: "Only the agent account factory can do this.",
    "AlreadyInitialized": lambda a: "This account is already initialised.",
    "ZeroAddress": lambda a: "An address argument is the zero address.",
    "PeriodOutOfRange": lambda a: "The usage period must be between one hour and seven days.",
    "DelayOutOfRange": lambda a: "The widening delay must be at most seven days.",
    "InvalidAgent": lambda a: "The agent key cannot be zero, the owner or the account itself.",
    "AgentExpiryOutOfRange": lambda a: "The agent expiry must be after now and at most 180 days away.",
    "InvalidPermissions": lambda a: "The permissions are empty or contain an unknown bit.",
    "BetaCeiling": lambda a: f"The policy field {_field(a[0])} is above the beta ceiling of this factory.",
    "InvalidPolicy": lambda a: f"The policy field {_field(a[0])} is out of range (a bps field above 10,000, or a deadline outside 1–600 s).",
    "AgentNotActive": lambda a: "That address is not an active agent; use addAgent.",
    "AgentAlreadyActive": lambda a: "That agent is already active; use setAgent to change its terms.",
    "AgentRetired": lambda a: "That address was revoked before and can never be an agent of this account again.",
    "TooManyAgents": lambda a: "The account already has eight active agents. Revoke one first.",
    "UnknownQueued": lambda a: f"No queued change has id {a[0]} (never queued, already executed or cancelled).",
    "TooEarly": lambda a: f"This queued change can run from {_time(a[0])}.",
    "QueuedExpired": lambda a: "This queued change expired 7 days after its ETA. Cancel it and queue it again.",
    "StaleQueued": lambda a: "The subject of this queued change (the agent, the token's allowlist entry or the delay) was changed after it was queued, so it no longer applies. Queue it again.",
    "AcceptRequired": lambda a: "An ownership transfer completes only when the new owner calls acceptOwnership.",
    "NotPendingOwner": lambda a: "Only the proposed new owner of this queued transfer can accept it.",
    "InvalidOwner": lambda a: "The new owner cannot be zero, the account itself or the current owner.",
    # Account — trade checks
    "TokenNotRegistered": lambda a: "The token is not a Mercurifi Launch token on this network.",
    "TokenNotAllowed": lambda a: "The account is in allowlist mode and this token is not on the owner allowlist. Sells stay open.",
    "TokenTooNew": lambda a: "The token is younger than the account minimum token age (minTokenAgeBlocks).",
    "SnipeTaxTooHigh": lambda a: f"The launch snipe tax is {a[0]} bps, above this account limit (maxSnipeBps). Wait for it to decay.",
    "PriceImpactTooHigh": lambda a: f"This trade would move the price by {a[0]} bps, above maxPriceImpactBps. Trade a smaller size.",
    "ZeroMinOut": lambda a: "The minimum output must be above zero.",
    "ZeroOutput": lambda a: "The trade would return nothing at the current price.",
    "ZeroAmount": lambda a: "The amount is zero or rounds to zero.",
    "AmountTooLarge": lambda a: "The amount is too large to encode (above uint128 for pool swaps, or overflowing the native scale).",
    "TradeTooLarge": lambda a: f"Above the per-trade limit of {_usdc(a[0])} (maxTradeUsdc). Sells count at cost basis, launches include the launch fee.",
    "NotTrading": lambda a: "The curve is not trading: it sold out, is graduating, or has graduated. Use swapExactIn once it has graduated.",
    "NotGraduated": lambda a: "The token has not graduated; trade it on its curve with buy or sell.",
    "UnexpectedPool": lambda a: "The graduated pool is not the LaunchHook USDC pool for this token; the account refuses to trade it.",
    "UnexpectedSwapDelta": lambda a: "Safety check: the pool swap moved more or returned less than asked, so the whole swap was reverted. Report this.",
    "AllowanceNotCleared": lambda a: "Safety check: an allowance survived the trade, so the whole trade was reverted. Report this.",
    "NativeTransferFailed": lambda a: "The native USDC transfer to the owner failed (for example a blocklisted owner, or an owner contract that refuses USDC).",
    "SelfReferrer": lambda a: "The referrer cannot be the account itself.",
    "ReentrancyGuardReentrantCall": lambda a: "Reentrant call refused.",
    "SafeCastOverflowedUintDowncast": lambda a: f"A value overflowed {a[0]} bits.",
    "SafeCastOverflowedUintToInt": lambda a: "A value overflowed int256.",
    "SafeERC20FailedOperation": lambda a: f"A token transfer or approval of {a[0]} failed.",
    # Factory
    "AccountExists": lambda a: f"An account already exists at {a[0]} for this owner and salt; use another salt.",
    "FailedDeployment": lambda a: "The account clone could not be deployed.",
    # The factory's error carries two amounts; the Universal Router declares one of the same name with none.
    "InsufficientBalance": lambda a: f"Insufficient balance: {a[0]} available, {a[1]} needed."
    if len(a) >= 2
    else "Insufficient balance.",
    "ImplementationMismatch": lambda a: "The implementation is not bound to this factory and its registry.",
    "InvalidCeiling": lambda a: f"The beta ceiling for {_field(a[0])} is out of range.",
    "NoActivePause": lambda a: "There is no active pause to extend.",
    "PauseTooLong": lambda a: f"The pause may last at most until {_time(a[0])}.",
    "NotAdmin": lambda a: "Only the factory admin (the Launch timelock) can do this.",
    "NotGuardian": lambda a: "Only the guardian can do this.",
    "GuardianDisabled": lambda a: "This factory has no guardian; no pause can be started.",
    "PauseCooldown": lambda a: f"The guardian pause is cooling down until {_time(a[0])}.",
    # Launch, bubbled through the account
    "Slippage": lambda a: "The price moved past your minimum output. Re-quote and retry, or allow more slippage.",
    "Expired": lambda a: "The deadline passed before the transaction was included.",
    "ConfigChanged": lambda a: "The Launch config changed between the quote and inclusion. Re-read the config and retry.",
    "InitialBuyTooLarge": lambda a: "The initial buy is above the launch cap (maxInitialBuyTokens).",
    "InsufficientGasForGraduation": lambda a: "This buy completes the curve and needs more gas for graduation. The SDK sends at least 1,800,000 gas for such buys.",
    "InvalidParams": lambda a: "The name must be 1–32 bytes, the symbol 1–10 bytes and the metadata URI at most 256 bytes.",
    "InsufficientLaunchFee": lambda a: "The value sent does not cover the launch fee.",
    "EnforcedPause": lambda a: "Launch is paused by governance.",
    "NothingToClaim": lambda a: "There are no fees to claim.",
    "PartialFill": lambda a: "The pool cannot fill this whole amount within its price bounds. Trade a smaller size.",
    "V4TooLittleReceived": lambda a: "The pool output was below the minimum (slippage). Re-quote and retry.",
    "ERC20InsufficientBalance": lambda a: "The account does not hold enough of this token.",
    # Standard
    "EmptyRevert": lambda a: "The call reverted without a reason (often out of gas, or a call to an address without code).",
}


def untrusted_reason(raw: object) -> str:
    """Contract-supplied text, made inert: NFKC, no control or format characters (bidi overrides, zero-width), no double
    quotes, no URLs, bounded length without splitting a surrogate pair. The raw string stays in `args`."""
    text = unicodedata.normalize(
        "NFKC", pre_bound(raw if isinstance(raw, str) else str(raw), _MAX_REASON)
    )
    clean = truncate_chars(
        js_strip(neutralize_untrusted(text.replace('"', "'"))), _MAX_REASON, "..."
    )
    return f'Reverted with a contract-supplied reason (untrusted text): "{clean}"'


def _decoded(name: str, args: list[Any], source: str, selector: str, data: str) -> DecodedRevert:
    explain = ERROR_MESSAGES.get(name)
    return DecodedRevert(
        name,
        args,
        source,
        selector,
        data,
        explain(args) if explain else f"Reverted with {name} ({source}).",
    )


def _malformed(
    message: str, source: str = "unknown", selector: str = "0x", data: str = "0x"
) -> DecodedRevert:
    return DecodedRevert("MalformedRevert", [], source, selector, data, message)


def _error_string(body: bytes) -> str | None:
    """The reason of an Error(string) body, or None when it does not hold a string. Like viem, trailing bytes, dirty
    padding and an unpadded last word are tolerated; invalid UTF-8 becomes U+FFFD."""
    if len(body) < 32:
        return None
    offset = int.from_bytes(body[:32], "big")
    if offset + 32 > len(body):
        return None
    length = int.from_bytes(body[offset : offset + 32], "big")
    if offset + 32 + length > len(body):
        return None
    return body[offset + 32 : offset + 32 + length].decode("utf-8", "replace")


def _lenient_uint_error(
    contract: Contract, selector: str, body: bytes
) -> tuple[str, list[Any]] | None:
    """viem reads an integer argument without range checks (BetaCeiling(300) for a uint8); eth-abi rejects the dirty
    padding. For an error whose arguments are all unsigned integers, read the words the same way."""
    item = contract._errors.get(selector)
    if item is None:
        return None
    inputs = item.get("inputs", [])
    if not all(str(i.get("type", "")).startswith("uint") for i in inputs) or len(body) < 32 * len(
        inputs
    ):
        return None
    return item["name"], [
        int.from_bytes(body[32 * n : 32 * n + 32], "big") for n in range(len(inputs))
    ]


def _decode(data: str | None) -> DecodedRevert:
    if data is None or data == "0x":
        return _decoded("EmptyRevert", [], "EVM", "0x", "0x")
    if not isinstance(data, str) or _HEX.fullmatch(data) is None:
        return _malformed("The revert data is not valid hex, so it could not be decoded.")
    data = (
        data.lower()
    )  # hex digits are case-insensitive; selectors and the returned data are lower-case
    raw = from_hex(data)
    if len(raw) < 4:
        return _malformed(
            "The revert data is shorter than a 4-byte selector, so it could not be decoded.",
            data=data,
        )
    selector = data[:10].lower()
    if selector == _ERROR_SELECTOR:
        reason = _error_string(raw[4:])
        if reason is None:
            return _malformed(
                "The revert carried a malformed Error(string).", "Solidity", selector, data
            )
        return DecodedRevert(
            "Error", [reason], "Solidity", selector, data, untrusted_reason(reason)
        )
    if selector == _PANIC_SELECTOR and len(raw) >= 36:
        code = int.from_bytes(raw[4:36], "big")
        return DecodedRevert(
            "Panic",
            [code],
            "Solidity",
            selector,
            data,
            f"Panic 0x{code:x} (arithmetic or assertion failure).",
        )
    for contract in _SOURCES:
        try:
            hit = contract.decode_error(data, strict=False)
        except (
            Exception
        ):  # selector known but the arguments are malformed: try the next ABI, as viem does
            hit = _lenient_uint_error(contract, selector, raw[4:])
            if hit is None:
                continue
        if hit is None:
            continue
        name, args = hit
        try:
            return _decoded(name, args, contract.name, selector, data)
        except Exception:
            return DecodedRevert(
                name,
                args,
                contract.name,
                selector,
                data,
                f"Reverted with {name} ({contract.name}).",
            )
    return DecodedRevert(
        "UnknownError", [], "unknown", selector, data, f"Reverted with an unknown error {selector}."
    )


def decode_revert(data: str | None) -> DecodedRevert:
    """Decodes revert data against every ABI the SDK touches, plus Error(string) and Panic(uint256). Never raises."""
    try:
        return _decode(data)
    except Exception:  # defence in depth: whatever the input, the caller gets a value
        return _malformed("The revert data could not be decoded.")


def _valid_hex(value: object) -> str | None:
    return value if isinstance(value, str) and _HEX.fullmatch(value) is not None else None


def extract_revert_data(error: BaseException) -> str | None:
    """Walks an error's cause chain for JSON-RPC revert data (valid hex only)."""
    current: BaseException | None = error
    for _ in range(16):
        if current is None:
            return None
        if isinstance(current, RpcError):
            found = _valid_hex(current.data)
            if found is not None:
                return found
        current = current.__cause__ or current.__context__
    return None


class ContractRevertError(MercurifiError):
    """A contract would reject, or did reject in a simulation. Nothing was broadcast."""

    code = "CONTRACT_REVERT"

    def __init__(self, revert: DecodedRevert, phase: Literal["local", "preflight"]) -> None:
        super().__init__(revert.message)
        self.revert = revert
        self.phase = phase


class TxRevertedError(MercurifiError):
    """The transaction was included and reverted. `revert` is the replayed reason when it reproduces."""

    code = "TX_REVERTED"

    def __init__(self, tx_hash: str, revert: DecodedRevert | None) -> None:
        super().__init__(
            f"Transaction {tx_hash} reverted: {revert.message}"
            if revert is not None
            else f"Transaction {tx_hash} reverted; replaying it did not reproduce the reason."
        )
        self.tx_hash = tx_hash
        self.revert = revert


def local_revert(name: str, args: list[Any] | None = None) -> ContractRevertError:
    """The error an on-chain check would raise, produced locally before anything is signed."""
    return ContractRevertError(_decoded(name, args or [], "local check", "0x", "0x"), "local")
