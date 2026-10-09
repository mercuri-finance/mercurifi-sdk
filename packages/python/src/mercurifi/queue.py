"""Queue listing and payload decoding. Every field is read from the registry; logs and the API only supply candidate ids."""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from itertools import islice
from typing import Any

from eth_abi.abi import decode
from eth_utils.address import to_checksum_address

from .abi import AGENT_POLICY_REGISTRY
from .codec import from_hex
from .errors import MercurifiError
from .networks import AgentBook
from .permissions import decode_permissions
from .policy import POLICY_FIELDS, QUEUE_TTL_SECONDS, ChainPolicy
from .reads import read_registry
from .rpc import Rpc

LOG_CHUNK = 10_000
QUEUE_WINDOW_BLOCKS = 2_419_200  # 14 days at ~0.5 s blocks: at most increaseDelay (<= 7 d) + 7 d after queueing
#: `Q_*` kinds of AgentTypes.sol; payload layouts per the registry's `queued` NatSpec (no snapshots).
QUEUE_KINDS = {1: "addAgent", 2: "setAgent", 3: "policy", 4: "allowToken", 5: "delay", 6: "owner"}
#: Registry events that create a queue item; each carries `id` (and `account` as topic 1).
QUEUE_EVENTS = ("AgentQueued", "PolicyQueued", "TokenAllowQueued", "IncreaseDelayQueued", "OwnershipQueued")
POLICY_TYPE = "(uint64,uint64,uint64,uint64,uint32,uint16,uint16,uint16,uint32,uint32,bool)"
#: Hard bound on the ids taken from an API answer; each is verified on chain anyway.
MAX_API_IDS = 200
_ID = re.compile(r"[0-9]{1,18}")


def account_topic(account: str) -> str:
    """An address as a 32-byte log topic (indexed `address` arguments are left-padded)."""
    return "0x" + "0" * 24 + account[2:].lower()


async def scan_logs(rpc: Rpc, address: str, from_block: int, to_block: int | None = None, *,
                    topics: list[str | None] | None = None, chunk: int = LOG_CHUNK) -> list[dict[str, Any]]:
    """eth_getLogs over [from_block, to_block] in chunks (public Arc RPCs bound the range per call), with a positional topics filter."""
    head = to_block if to_block is not None else await rpc.block_number()
    out: list[dict[str, Any]] = []
    start = from_block
    while start <= head:
        end = min(start + chunk - 1, head)
        out.extend(await rpc.get_logs(address, start, end, topics))
        start += chunk
    return out


def decode_queued_payload(kind: int, payload: str) -> tuple[str, dict[str, Any]]:
    raw = from_hex(payload)
    try:
        if kind in (1, 2):
            agent, expires_at, perms = decode(["address", "uint40", "uint16"], raw)
            return QUEUE_KINDS[kind], {"agent": to_checksum_address(agent), "expires_at": int(expires_at), "permissions": decode_permissions(int(perms))}
        if kind == 3:
            (target,) = decode([POLICY_TYPE], raw)
            return "policy", {"policy": ChainPolicy(*target), "superseded": []}
        if kind == 4:
            return "allowToken", {"token": to_checksum_address(decode(["address"], raw)[0])}
        if kind == 5:
            return "delay", {"delay": int(decode(["uint32"], raw)[0])}
        if kind == 6:
            return "owner", {"new_owner": to_checksum_address(decode(["address"], raw)[0])}
    except Exception:  # an unexpected layout is shown raw, never guessed
        pass
    return "unknown", {"raw": payload}


def effective_eta(queued_at: int, delay_at_queue: int, current_delay: int) -> int:
    """The registry's effective ETA: `queuedAt + max(delayAtQueue, current delay)`. Raising the widening delay also
    postpones items already queued; lowering it never brings them forward."""
    return queued_at + max(delay_at_queue, current_delay)


@dataclass(frozen=True)
class QueuedChange:
    id: int
    kind: str
    #: Effective ETA (a later delay raise moves it), Unix seconds.
    eta: int
    #: ETA + 7 days; after this the item can no longer run.
    expires_at: int
    #: Registry `writeSeq` when queued.
    seq: int
    #: Same order as `executeQueued`: `cancelled` (older epoch: voided by a pause or ownership change), `expired` (past
    #: ETA + 7 d), `stale` (its agent, token entry or delay was written after it, or every policy field was),
    #: `unexecutable` (an agent item that would already be expired when it can first run), then `pending` / `ready`.
    status: str
    detail: dict[str, Any]
    #: What executing it now would do wrong, naming the revert; None when nothing is wrong.
    warning: str | None = None


_WARNINGS = {
    "stale": "Executing this reverts StaleQueued (its subject changed after it was queued); cancel it and queue it again if still wanted.",
    "expired": "Executing this reverts QueuedExpired (the 7-day window after its ETA has passed); cancel it and queue it again if still wanted.",
    "cancelled": "Voided by a pause or an ownership change after it was queued; executing it only clears it.",
    "unexecutable": "Executing this reverts AgentExpiryOutOfRange: the agent would already be expired at the earliest time it can run. Cancel it and queue a longer expiry.",
}
_OWNER_WARNINGS = {
    "pending": "An ownership transfer is completed only by the new owner calling acceptOwnership once the ETA has passed; executeQueued reverts AcceptRequired. The current owner can cancelQueued it.",
    "ready": "An ownership transfer is completed only by the new owner calling acceptOwnership (within 7 days of the ETA); executeQueued reverts AcceptRequired. The current owner can cancelQueued it.",
    "cancelled": "Voided by a pause or an ownership change: acceptOwnership now reverts StaleQueued and executeQueued reverts AcceptRequired. Only cancelQueued clears it.",
    "expired": "The 7-day window has passed: acceptOwnership reverts QueuedExpired. Only cancelQueued clears it.",
}
_ALL_STALE = "Every policy field was changed after this was queued, so executing it changes nothing."


async def _ids_from_api(api: Any, account: str) -> set[int] | None:
    """Candidate ids from the API's pending list (untrusted: each is re-read from the registry). None when unusable."""
    try:
        acc = await api.get_account(account)
        pending = acc["pending"] if isinstance(acc, dict) else acc.pending
        ids: set[int] = set()
        for item in islice(pending, MAX_API_IDS):
            raw = item.get("id") if isinstance(item, dict) else getattr(item, "id", None)
            if isinstance(raw, str) and _ID.fullmatch(raw):
                ids.add(int(raw))
        return ids
    except Exception:
        return None


async def list_queued(rpc: Rpc, agents: AgentBook, account: str, from_block: int | None = None, *, api: Any = None) -> list[QueuedChange]:
    """Queued changes of `account` with live status, every field read from the registry. Candidate ids come from the API
    first when `api` is given, and otherwise (or if it fails or answers empty) from the registry's logs in the queue window."""
    async def reg(fn: str, *args: object) -> Any:
        return await read_registry(rpc, agents.registry, fn, account, *args)

    ids = await _ids_from_api(api, account) if api is not None else None
    # An empty API list is not proof of an empty queue (the API may lag or be wrong): still scan the recent window.
    if not ids:
        ids = set() if ids is None else ids
        head = await rpc.block_number()
        start = from_block if from_block is not None else max(head - QUEUE_WINDOW_BLOCKS, agents.deploy_block, 0)
        for entry in await scan_logs(rpc, agents.registry, start, head, topics=[None, account_topic(account)]):
            try:
                decoded = AGENT_POLICY_REGISTRY.decode_log(entry["topics"], entry["data"])
            except MercurifiError:
                continue  # a malformed log from the registry address is skipped, not fatal
            if decoded is None or decoded[0] not in QUEUE_EVENTS:
                continue
            args = decoded[1]
            if str(args.get("account", "")).lower() != account.lower():
                continue
            if isinstance(args.get("id"), int):
                ids.add(args["id"])
    epoch, now = await asyncio.gather(reg("epoch"), rpc.latest_timestamp())
    out: list[QueuedChange] = []
    for queued_id in sorted(ids):
        kind, eta, item_epoch, seq, payload = await reg("queued", queued_id)
        if int(kind) == 0:
            continue  # executed or cancelled
        eta, seq = int(eta), int(seq)
        expires_at = eta + QUEUE_TTL_SECONDS
        name, detail = decode_queued_payload(int(kind), payload)
        stale = False
        if "agent" in detail:
            stale = int(await reg("agentWrite", detail["agent"])) > seq
        elif "token" in detail:
            stale = int(await reg("tokenWrite", detail["token"])) > seq
        elif "delay" in detail:
            stale = int(await reg("delayWrite")) > seq
        elif "policy" in detail:
            writes = await asyncio.gather(*(reg("policyWrite", i) for i in range(len(POLICY_FIELDS))))
            detail["superseded"] = [f for f, w in zip(POLICY_FIELDS, writes) if int(w) > seq]
            stale = len(detail["superseded"]) == len(POLICY_FIELDS)
        # executeQueued checks the epoch, then the window, then freshness, then the agent terms; the status follows that order.
        # An agent item whose expiry is not after max(now, eta) fails the terms check at every possible execution time.
        unexecutable = "agent" in detail and detail["expires_at"] <= max(now, eta)
        status = ("cancelled" if int(item_epoch) != int(epoch) else "expired" if now > expires_at else "stale" if stale
                  else "unexecutable" if unexecutable else "pending" if now < eta else "ready")
        warning = (_OWNER_WARNINGS.get(status) if name == "owner"
                   else _ALL_STALE if status == "stale" and "policy" in detail else _WARNINGS.get(status))
        out.append(QueuedChange(queued_id, name, eta, expires_at, seq, status, detail, warning))
    return out
