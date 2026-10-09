"""The final result of one agent action, read from the account's own AgentAction log (spec 4.10)."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .abi import AGENT_ACCOUNT, LAUNCH_FACTORY
from .errors import MercurifiError
from .permissions import ACTIONS
from .units import format_tokens, format_usdc6


def _int(v: Any) -> int:
    if isinstance(v, int):
        return v
    s = str(v)
    return int(s, 16) if s.startswith("0x") else int(s)


@dataclass(frozen=True)
class Launched:
    token: str
    curve: str


@dataclass(frozen=True)
class Fill:
    action: str
    account: str
    agent: str
    token: str
    usdc_spent6: int
    usdc_received6: int
    basis_value6: int
    token_delta: int
    tokens_out: int
    tokens_in: int
    usdc_spent: str
    usdc_received: str
    tokens: str
    period_id: int
    tx_hash: str
    block: int
    gas_used: int
    gas_cost_wei: int
    launched: Launched | None


def _decode(contract: Any, entry: Mapping[str, Any], name: str) -> dict[str, Any] | None:
    """The decoded args of a log if it is event `name`; a malformed or foreign log is skipped, never fatal."""
    try:
        decoded = contract.decode_log(list(entry["topics"]), entry["data"])
    except MercurifiError:
        return None
    if decoded is None or decoded[0] != name:
        return None
    args: dict[str, Any] = decoded[1]
    return args


def fill_from_receipt(receipt: Mapping[str, Any], account: str, launch_factory: str) -> Fill:
    """AgentAction is emitted by the account itself (not the registry); another account's is ignored and a sweep's
    AccountWithdrawn is not an action. Exactly one AgentAction from this account must be present."""
    tx_hash = str(receipt.get("transactionHash"))
    logs = list(receipt.get("logs", []))
    actions = [a for entry in logs if str(entry["address"]).lower() == account.lower()
               if (a := _decode(AGENT_ACCOUNT, entry, "AgentAction")) is not None]
    if len(actions) != 1:
        raise MercurifiError(f"Expected one AgentAction from {account} in {tx_hash}, found {len(actions)}.", code="FILL_NOT_FOUND")
    a = actions[0]
    code = int(a["action"])
    action = ACTIONS.get(code)
    if action is None:
        raise MercurifiError(
            f"{account} reported an unknown action code {code} in {tx_hash}; this SDK version does not know it.", code="UNKNOWN_ACTION")
    created = [c for entry in logs if str(entry["address"]).lower() == launch_factory.lower()
               if (c := _decode(LAUNCH_FACTORY, entry, "TokenCreated")) is not None]
    # A launch must show the factory creating the very token the account reports, with the account as its creator.
    made = next((c for c in created if str(c["token"]).lower() == str(a["token"]).lower() and str(c["creator"]).lower() == account.lower()), None)
    if action == "launch" and made is None:
        raise MercurifiError(f"The launch in {tx_hash} has no TokenCreated event for {a['token']} created by {account}.", code="FILL_NOT_FOUND")
    delta = int(a["tokenDelta"])
    gas_used = _int(receipt.get("gasUsed", 0))
    return Fill(
        action, account, a["agent"], a["token"], int(a["usdcSpent"]), int(a["usdcReceived"]), int(a["basisValue"]), delta,
        max(delta, 0), max(-delta, 0), format_usdc6(int(a["usdcSpent"])), format_usdc6(int(a["usdcReceived"])), format_tokens(abs(delta)),
        int(a["periodId"]), tx_hash, _int(receipt.get("blockNumber", 0)), gas_used, gas_used * _int(receipt.get("effectiveGasPrice", 0)),
        Launched(made["token"], made["curve"]) if action == "launch" and made is not None else None,
    )
