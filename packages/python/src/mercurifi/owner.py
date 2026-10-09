"""Owner-side actions, signed by the main wallet (spec 4.7). Mirrors the TypeScript owner.ts.

Configuration lives in the policy registry (account passed first); funds stay in the account. A queue id and its ETA
come from the mined `*Queued` event, never from the preflight, and executeQueued / acceptOwnership are judged by
`QueuedExecuted` vs `QueuedCancelled` for that id.
"""
from __future__ import annotations

import asyncio
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, fields, replace
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from .abi import AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY, LAUNCH_FACTORY, LAUNCH_TOKEN
from .codec import Contract
from .errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotOwnerError
from .networks import AgentBook
from .permissions import DEFAULT_AGENT_PERMISSIONS, SELL_RISK_WARNING, encode_permissions
from .policy import (
    DEFAULT_AGENT_DAYS,
    DEFAULT_INCREASE_DELAY,
    DEFAULT_PERIOD_SECONDS,
    DEFAULT_POLICY,
    MAX_AGENT_DAYS,
    MAX_AGENTS,
    MAX_INCREASE_DELAY,
    MAX_PERIOD_SECONDS,
    MIN_PERIOD_SECONDS,
    QUEUE_TTL_SECONDS,
    ChainPolicy,
    PolicyPreview,
    merge_policy,
    preview_policy_change,
    validate_policy,
)
from .queue import QUEUE_EVENTS, QueuedChange, effective_eta, list_queued, scan_logs
from .reads import AccountState, is_agent_account, read_account_state, read_agent, read_ceilings, read_registry
from .signers import Signer
from .tx import WriteRequest
from .units import resolve_token_amount, resolve_usdc6, usdc6_to_wei

if TYPE_CHECKING:
    from .client import AsyncClient

ZERO = "0x" + "00" * 20
DAY = 86_400
WITHDRAW_CHUNK = 100
#: Pages of API actions read before falling back to the chain.
MAX_ACTION_PAGES = 50
#: Slack on top of the delay: an agent whose expiry is not clearly after the ETA could never execute.
EXPIRY_MARGIN = 60
#: topic0 of the account's AgentAction (the zero-valued encoding is only used for its first topic).
AGENT_ACTION_TOPIC = AGENT_ACCOUNT.encode_log("AgentAction", {})[0][0]
Outcome = Literal["none", "immediate", "queued", "mixed", "cancelled"]
_WITHDRAW_KEYS = ("token", "usdc", "usdc6", "all", "amount", "amount_wei")


@dataclass(frozen=True)
class FirstAgent:
    address: str
    expires_in_days: int = DEFAULT_AGENT_DAYS
    permissions: tuple[str, ...] | None = None


@dataclass(frozen=True)
class CreatedAccount:
    account: str
    salt: str
    tx_hash: str
    block: int


@dataclass(frozen=True)
class PolicyPlan(PolicyPreview):
    """A PolicyPreview plus the factory ceilings and the timing of its queued part (None when nothing is queued)."""

    ceilings: ChainPolicy | None = None
    eta_if_queued: int | None = None
    expires_if_queued: int | None = None
    #: One line per changed field: applies immediately, or queued with its executable window.
    summary: tuple[str, ...] = ()


@dataclass(frozen=True)
class ChangeResult:
    """`cancelled`: executeQueued found the item voided by a pause or ownership change and only cleared it. `eta` and
    `queued_id` come from the mined `*Queued` event. `summary` is one plain sentence; `warnings` list what the caller
    should know (they are also sent to `on_warning`)."""

    outcome: Outcome
    queued_id: int | None
    eta: int | None
    tx_hash: str | None
    block: int | None
    preview: PolicyPreview | None = None
    summary: str = ""
    warnings: list[str] = field(default_factory=list)


def _none(summary: str) -> ChangeResult:
    return ChangeResult("none", None, None, None, None, summary=summary)


def _at(t: int) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expiry(now: int, days: int | None) -> int:
    d = DEFAULT_AGENT_DAYS if days is None else days
    if isinstance(d, bool) or not isinstance(d, int) or not (1 <= d <= MAX_AGENT_DAYS):
        raise InvalidInputError("expires_in_days", f"expires_in_days must be an integer in 1..{MAX_AGENT_DAYS}")
    return now + d * DAY


def _int_in(name: str, v: int, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        raise InvalidInputError(name, f"{name} must be an integer in {lo}..{hi}")
    return v


def _not_owner_key(agent: str, signer: Signer) -> None:
    if agent.lower() == signer.address.lower():
        raise InvalidInputError("agent", "Use a separate agent key, not the owner wallet: the owner key must never sit on a trading server.")


def _registry_events(registry: str, account: str, receipt: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Registry events of the mined receipt that belong to `account`."""
    out: list[tuple[str, dict[str, Any]]] = []
    for entry in receipt.get("logs", []):
        if str(entry.get("address", "")).lower() != registry.lower():
            continue
        try:
            decoded = AGENT_POLICY_REGISTRY.decode_log(entry["topics"], entry["data"])
        except MercurifiError:
            continue
        if decoded is not None and str(decoded[1].get("account", "")).lower() == account.lower():
            out.append(decoded)
    return out


async def _send_change(
    mf: AsyncClient, signer: Signer, registry: str, account: str, to: str, contract: Contract, fn: str, args: Sequence[Any],
    expected: Outcome, describe: Callable[[ChangeResult], str], warnings: Sequence[str] = (), must_queue: bool = False,
) -> ChangeResult:
    """Sends one call and builds the result from the mined receipt: the queue id and ETA come from the registry's `*Queued`
    event, and executeQueued / acceptOwnership are judged by `QueuedExecuted` vs `QueuedCancelled` for that id."""
    sent = await mf.sender.send(signer, WriteRequest(to, contract.encode(fn, *args), fn))
    events = _registry_events(registry, account, sent.receipt)
    queued_ev = next((a for n, a in events if n in QUEUE_EVENTS), None)
    target_id = args[1] if fn in ("executeQueued", "acceptOwnership") else None
    notes = list(warnings)

    def done(outcome: Outcome) -> ChangeResult:
        r = ChangeResult(outcome, None, None, sent.tx_hash, int(sent.receipt["blockNumber"], 16), warnings=notes)
        if queued_ev is not None and outcome != "cancelled":
            r = replace(r, queued_id=int(queued_ev["id"]), eta=int(queued_ev["eta"]))
        r = replace(r, summary=describe(r))
        for w in notes:
            mf.warn(w)
        return r

    if target_id is not None:
        cancelled = any(n == "QueuedCancelled" and a.get("id") == target_id for n, a in events)
        executed = any(n == "QueuedExecuted" and a.get("id") == target_id for n, a in events)
        if cancelled and fn == "executeQueued":
            return done("cancelled")
        if not executed:
            raise MercurifiError(
                f"The receipt of {sent.tx_hash} has no QueuedExecuted event for item {target_id}; check the queue before retrying.",
                code="MISSING_EVENT",
            )
        return done("immediate")
    if must_queue and queued_ev is None:
        raise MercurifiError(
            f"The receipt of {sent.tx_hash} has no *Queued event, so the queue id is unknown; list the queue to find it.", code="MISSING_EVENT"
        )
    return done("immediate" if queued_ev is None and expected in ("queued", "mixed") else expected)


class OwnerClient:
    """Owner-side actions, signed by the main wallet (spec 4.7)."""

    def __init__(self, mf: AsyncClient, signer: Signer) -> None:
        self._mf = mf
        self.signer = signer

    async def create_account(self, *, referrer: str | None = None, policy: Mapping[str, object] | None = None, period_seconds: int | None = None,
                             increase_delay: int | None = None, first_agent: FirstAgent | None = None, salt: str | None = None) -> CreatedAccount:
        agents = self._mf.require_agents()
        rpc = self._mf.rpc
        target = merge_policy(DEFAULT_POLICY, policy or {})
        validate_policy(target, await read_ceilings(rpc, agents))
        period = _int_in("period_seconds", DEFAULT_PERIOD_SECONDS if period_seconds is None else period_seconds, MIN_PERIOD_SECONDS, MAX_PERIOD_SECONDS)
        delay = _int_in("increase_delay", DEFAULT_INCREASE_DELAY if increase_delay is None else increase_delay, 0, MAX_INCREASE_DELAY)
        salt = salt or "0x" + secrets.token_hex(32)
        # The salt is bound to the owner: predictAccount(owner, salt) is what the factory will create.
        predicted = str(await rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "predictAccount", self.signer.address, salt))
        ref = referrer or ZERO
        if ref.lower() == predicted.lower():
            raise InvalidInputError("referrer", "The referrer cannot be the account itself.")
        if (await rpc.get_code(predicted)) not in ("0x", ""):
            raise InvalidInputError("salt", "An account already exists for this owner and salt; use another salt.")
        fa, fa_exp, fa_perm = ZERO, 0, 0
        if first_agent is not None:
            _not_owner_key(first_agent.address, self.signer)
            if first_agent.address.lower() == predicted.lower():
                raise InvalidInputError("agent", "The agent key cannot be the account itself.")
            perms = DEFAULT_AGENT_PERMISSIONS if first_agent.permissions is None else first_agent.permissions
            fa_perm = encode_permissions(perms)
            if "sell" in perms:
                self._mf.warn(SELL_RISK_WARNING)
            fa, fa_exp = first_agent.address, _expiry(await rpc.latest_timestamp(), first_agent.expires_in_days)
        init = {"referrer": ref, "policy": target.to_abi(), "periodSeconds": period, "increaseDelay": delay,
                "firstAgent": fa, "firstAgentExpiresAt": fa_exp, "firstAgentPermissions": fa_perm}
        sent = await self._mf.sender.send(
            self.signer, WriteRequest(agents.factory, AGENT_ACCOUNT_FACTORY.encode("createAccount", salt, init), "createAccount"))
        created: list[str] = []
        for entry in sent.receipt.get("logs", []):
            if str(entry.get("address", "")).lower() != agents.factory.lower():
                continue
            try:
                decoded = AGENT_ACCOUNT_FACTORY.decode_log(entry["topics"], entry["data"])
            except MercurifiError:
                continue
            if decoded is not None and decoded[0] == "AccountCreated":
                created.append(str(decoded[1]["account"]))
        if not created:
            raise MercurifiError(
                f"The receipt of {sent.tx_hash} has no AccountCreated event from the factory; do not assume the account exists.",
                code="MISSING_EVENT",
            )
        if created[0].lower() != predicted.lower():
            raise NetworkMismatchError(f"The factory created {created[0]}, not the predicted {predicted}.")
        return CreatedAccount(predicted, salt, sent.tx_hash, int(sent.receipt["blockNumber"], 16))

    async def manage(self, account: str) -> AccountManager:
        agents = self._mf.require_agents()
        if not await is_agent_account(self._mf.rpc, agents, account):
            raise InvalidInputError("account", f"{account} is not a Mercurifi agent account on {self._mf.network.name}")
        owner = await read_registry(self._mf.rpc, agents.registry, "owner", account)
        if str(owner).lower() != self.signer.address.lower():
            raise NotOwnerError(f"{self.signer.address} is not the owner of {account}")
        return AccountManager(self._mf, self.signer, account, agents)

    async def deposit(self, account: str, *, usdc: str | None = None, usdc6: int | None = None) -> str:
        """Sends native USDC to the account (its receive() has no logic)."""
        agents = self._mf.require_agents()
        if not await is_agent_account(self._mf.rpc, agents, account):
            raise InvalidInputError("account", f"{account} is not a Mercurifi agent account on {self._mf.network.name}")
        sent = await self._mf.sender.send(self.signer, WriteRequest(account, "0x", "deposit", value=usdc6_to_wei(resolve_usdc6(usdc, usdc6))))
        return sent.tx_hash

    async def fund_gas(self, agent: str, *, usdc: str | None = None, usdc6: int | None = None) -> str:
        """Sends native USDC to an agent key for gas; the agent pays its own gas (spec 0)."""
        sent = await self._mf.sender.send(self.signer, WriteRequest(agent, "0x", "fundGas", value=usdc6_to_wei(resolve_usdc6(usdc, usdc6))))
        return sent.tx_hash

    async def accept_ownership(self, account: str, queued_id: int) -> ChangeResult:
        """Called by the NEW owner from the queued transfer's ETA to 7 days after it: registry.acceptOwnership(account, id).
        If the signer is an active agent of the account, accepting revokes (and permanently retires) that agent entry."""
        agents = self._mf.require_agents()
        warnings: list[str] = []
        me = await read_registry(self._mf.rpc, agents.registry, "agent", account, self.signer.address)
        if me["active"]:
            warnings.append("This address is an active agent of the account: accepting ownership revokes and permanently retires it as an agent.")
        return await _send_change(
            self._mf, self.signer, agents.registry, account, agents.registry, AGENT_POLICY_REGISTRY, "acceptOwnership", [account, queued_id],
            "immediate", lambda _r: f"Ownership of {account} moved to {self.signer.address} (queue item {queued_id}).", warnings)

    async def pending_ownership(self, account: str) -> list[QueuedChange]:
        """Ownership transfers queued TO the signer for `account`, with live status. Works for the incoming owner, who is
        not yet the owner and so cannot `manage` the account. Complete one with `accept_ownership(account, item.id)`."""
        agents = self._mf.require_agents()
        if not await is_agent_account(self._mf.rpc, agents, account):
            raise InvalidInputError("account", f"{account} is not a Mercurifi agent account on {self._mf.network.name}")
        api = self._mf.api if self._mf.settings.api_key is not None else None
        everything = await list_queued(self._mf.rpc, agents, account, api=api)
        return [q for q in everything if str(q.detail.get("new_owner", "")).lower() == self.signer.address.lower()]


class AccountManager:
    """One account managed by its owner. Narrowing is immediate, widening is queued (spec 4.4). Configuration lives in the
    policy registry (account passed first); funds stay in the account. Withdrawals always go to the owner."""

    def __init__(self, mf: AsyncClient, signer: Signer, account: str, agents: AgentBook) -> None:
        self._mf = mf
        self._signer = signer
        self.account = account
        self._agents = agents

    async def state(self) -> AccountState:
        return await read_account_state(self._mf.rpc, self._agents, self.account)

    async def preview_policy(self, changes: Mapping[str, object]) -> PolicyPlan:
        """What `set_policy` would do, without sending anything: which fields apply immediately (narrowing), which are
        queued (widening) and when the queued part becomes executable (queuedAt + max(delayAtQueue, current delay), for 7 days)."""
        state, ceilings, now = await asyncio.gather(self.state(), read_ceilings(self._mf.rpc, self._agents), self._mf.rpc.latest_timestamp())
        target = merge_policy(state.policy, changes)
        validate_policy(target, ceilings)
        base = preview_policy_change(state.policy, target)
        eta = effective_eta(now, state.increase_delay, state.increase_delay)
        expires = eta + QUEUE_TTL_SECONDS
        lines = tuple(
            f"{c.field}: {c.current} -> {c.next} applies immediately" if c.direction == "narrow"
            else f"{c.field}: {c.current} -> {c.next} is queued; executable from {_at(eta)} until {_at(expires)}"
            for c in base.changes)
        queued = len(base.queued) > 0
        return PolicyPlan(**{f.name: getattr(base, f.name) for f in fields(base)}, ceilings=ceilings,
                          eta_if_queued=eta if queued else None, expires_if_queued=expires if queued else None, summary=lines)

    async def set_policy(self, changes: Mapping[str, object]) -> ChangeResult:
        plan = await self.preview_policy(changes)
        if plan.outcome == "none":
            return replace(_none("The policy already matches; nothing to change."), preview=plan)
        warnings = []
        if plan.queued:
            warnings.append(f"Widened fields ({', '.join(plan.queued)}) are queued, not applied: they can be executed from "
                            f"{_at(plan.eta_if_queued or 0)} and for 7 days after.")

        def describe(x: ChangeResult) -> str:
            if x.outcome == "immediate":
                return f"Policy tightened now ({', '.join(plan.immediate)})."
            head = f"Tightened now: {', '.join(plan.immediate)}. " if plan.immediate else ""
            return f"{head}Queued as item {x.queued_id}: {', '.join(plan.queued)}, executable from {_at(x.eta or 0)}."

        return replace(await self._registry_write("setPolicy", [plan.target.to_abi()], plan.outcome, describe, warnings), preview=plan)

    async def _agent_context(self) -> tuple[int, int, int]:
        """(now, delay, active agent count): what a queued agent change is judged against."""
        now, delay, count = await asyncio.gather(
            self._mf.rpc.latest_timestamp(),
            read_registry(self._mf.rpc, self._agents.registry, "increaseDelay", self.account),
            read_registry(self._mf.rpc, self._agents.registry, "activeAgentCount", self.account))
        return int(now), int(delay), int(count)

    @staticmethod
    def _check_expiry_reachable(expires_at: int, now: int, delay: int) -> None:
        """A queued agent item with `expires_at` not after its ETA reverts AgentExpiryOutOfRange for its whole window."""
        if expires_at <= now + delay + EXPIRY_MARGIN:
            raise InvalidInputError(
                "expires_in_days",
                f"This change is queued for {delay} s (until {_at(now + delay)}) but the agent would expire at {_at(expires_at)}, "
                "so it could never be executed. Choose a longer expiry.")

    @staticmethod
    def _agent_warnings(perms: Sequence[str], active_count: int, had_sell: bool = False) -> list[str]:
        w: list[str] = []
        if "sell" in perms and not had_sell:
            w.append(SELL_RISK_WARNING)
        if active_count >= MAX_AGENTS:
            w.append(f"The account already has {active_count} active agents (the limit is {MAX_AGENTS}); executing this add reverts "
                     "TooManyAgents unless one is revoked first.")
        return w

    async def add_agent(self, agent: str, *, expires_in_days: int | None = None, permissions: Sequence[str] | None = None) -> ChangeResult:
        _not_owner_key(agent, self._signer)
        perms = tuple(DEFAULT_AGENT_PERMISSIONS if permissions is None else permissions)
        bits = encode_permissions(perms)
        now, delay, count = await self._agent_context()
        expires_at = _expiry(now, expires_in_days)
        self._check_expiry_reachable(expires_at, now, delay)
        return await self._registry_write(
            "addAgent", [agent, expires_at, bits], "queued",
            lambda r: f"Agent {agent} is queued as item {r.queued_id}; it can be activated from {_at(r.eta or 0)} (executeQueued), "
                      f"then runs until {_at(expires_at)}.",
            self._agent_warnings(perms, count), True)

    async def set_agent(self, agent: str, *, expires_in_days: int | None = None, permissions: Sequence[str] | None = None) -> ChangeResult:
        now, delay, _count = await self._agent_context()
        current = await read_agent(self._mf.rpc, self._agents, self.account, agent, now)
        if not current.active:
            raise InvalidInputError("agent", f"{agent} is not an active agent; use add_agent")
        perms = tuple(permissions) if permissions is not None else tuple(current.permissions)
        bits = encode_permissions(perms)
        expires_at = current.expires_at if expires_in_days is None else _expiry(now, expires_in_days)
        widening = expires_at > current.expires_at or (bits & ~current.permission_bits) != 0
        if widening:
            self._check_expiry_reachable(expires_at, now, delay)
        warnings = [*self._agent_warnings(perms, 0, "sell" in current.permissions),
                    f"Widening an agent (longer expiry or more permissions) is queued for {delay} s; the old terms stay in force until it is executed."
                    ] if widening else []
        return await self._registry_write(
            "setAgent", [agent, expires_at, bits], "queued" if widening else "immediate",
            lambda r: (f"Wider terms for {agent} are queued as item {r.queued_id}; executable from {_at(r.eta or 0)}."
                       if r.outcome == "queued" else f"Narrower terms for {agent} applied now."),
            warnings)

    async def rotate_agent(self, old: str, new: str, *, expires_in_days: int | None = None, permissions: Sequence[str] | None = None) -> ChangeResult:
        """Retires `old` now and queues `new` under the delay rule."""
        _not_owner_key(new, self._signer)
        perms = tuple(DEFAULT_AGENT_PERMISSIONS if permissions is None else permissions)
        bits = encode_permissions(perms)
        now, delay, count = await self._agent_context()
        expires_at = _expiry(now, expires_in_days)
        self._check_expiry_reachable(expires_at, now, delay)
        old_active = (await read_agent(self._mf.rpc, self._agents, self.account, old, now)).active
        warnings = [*self._agent_warnings(perms, count - (1 if old_active else 0)),
                    f"{old} is retired at once and can never be an agent of this account again; {new} starts only when its queued item is executed."]
        return await self._registry_write(
            "rotateAgent", [old, new, expires_at, bits], "mixed",
            lambda r: f"{old} was revoked now; {new} is queued as item {r.queued_id}, executable from {_at(r.eta or 0)}.", warnings, True)

    async def revoke_agent(self, agent: str) -> ChangeResult:
        """Retires the address forever (revoking it if active); its queued items can no longer execute."""
        return await self._registry_write("revokeAgent", [agent], "immediate", lambda _r: f"{agent} is revoked now and retired for good.")

    async def set_token_allowed(self, token: str, allowed: bool) -> ChangeResult:
        """Adding is queued (and skipped when already allowed); removing is immediate and makes pending additions stale."""
        if allowed:
            if not await self._is_launch_token(token):
                raise InvalidInputError("token", f"{token} is not a Mercurifi Launch token on {self._mf.network.name}")
            if await read_registry(self._mf.rpc, self._agents.registry, "tokenAllowed", self.account, token):
                return _none(f"{token} is already on the allowlist.")
        warnings = ["Allowing a token is queued; with allowlist_only set, agents cannot trade it until the item is executed."] if allowed else []
        return await self._registry_write(
            "setTokenAllowed", [token, allowed], "queued" if allowed else "immediate",
            lambda r: (f"Allowing {token} is queued as item {r.queued_id}, executable from {_at(r.eta or 0)}."
                       if allowed else f"{token} removed from the allowlist now."),
            warnings)

    async def set_increase_delay(self, seconds: int) -> ChangeResult:
        _int_in("increase_delay", seconds, 0, MAX_INCREASE_DELAY)
        current = (await self.state()).increase_delay
        if seconds == current:
            return _none(f"The increase delay is already {seconds} s.")
        raising = seconds > current
        warnings = (["Raising the delay also postpones every item already queued: its ETA becomes queuedAt + the new delay. That can push a "
                     "queued agent item past its own expiry, so it can never be executed; check the queue and requeue such items."]
                    if raising else
                    [f"Lowering the delay is itself queued for the current {current} s and weakens the protection against a compromised "
                     "owner key; it applies only when executed."])
        return await self._registry_write(
            "setIncreaseDelay", [seconds], "immediate" if raising else "queued",
            lambda r: (f"The increase delay is now {seconds} s." if raising
                       else f"Lowering the delay to {seconds} s is queued as item {r.queued_id}, executable from {_at(r.eta or 0)}."),
            warnings)

    async def transfer_ownership(self, new_owner: str) -> ChangeResult:
        """Queues the transfer; the new owner completes it with OwnerClient.accept_ownership after the delay."""
        warnings = [
            f"Ownership moves only when {new_owner} calls acceptOwnership (between the ETA and 7 days after it); you stay owner until then and can cancelQueued.",
            "Accepting revokes and permanently retires the new owner as an agent of this account, if it is one. Check the address: ownership controls all funds.",
        ]
        return await self._registry_write(
            "transferOwnership", [new_owner], "queued",
            lambda r: f"Transfer to {new_owner} is queued as item {r.queued_id}; {new_owner} can accept from {_at(r.eta or 0)}.", warnings, True)

    async def list_queued(self, from_block: int | None = None) -> list[QueuedChange]:
        """Queued changes, from the API when a key is configured (verified on chain), else from bounded log scans."""
        api = self._mf.api if self._mf.settings.api_key is not None else None
        return await list_queued(self._mf.rpc, self._agents, self.account, from_block, api=api)

    async def execute_queued(self, queued_id: int) -> ChangeResult:
        """Runs a queued item once its ETA has passed. The outcome is `cancelled` when the registry only cleared an item voided
        by a pause or ownership change. Ownership items are completed by the new owner (`accept_ownership`), never here."""
        kind = int((await read_registry(self._mf.rpc, self._agents.registry, "queued", self.account, queued_id))[0])
        if kind == 0:
            raise InvalidInputError("id", f"There is no queued item {queued_id} for this account (already executed, cancelled or never queued).")
        if kind == 6:
            raise InvalidInputError(
                "id", f"Item {queued_id} is an ownership transfer: executeQueued reverts AcceptRequired. The new owner completes it "
                      "with acceptOwnership; you can only cancelQueued it.")
        return await self._registry_write(
            "executeQueued", [queued_id], "immediate",
            lambda r: (f"Item {queued_id} was voided by a pause or ownership change; it was cleared and nothing was applied."
                       if r.outcome == "cancelled" else f"Queued item {queued_id} executed."))

    async def cancel_queued(self, queued_id: int) -> ChangeResult:
        return await self._registry_write("cancelQueued", [queued_id], "immediate", lambda _r: f"Queued item {queued_id} cancelled.")

    async def pause_agents(self, paused: bool) -> ChangeResult:
        """Immediate both ways; pausing also voids every queued item (spec 4.4)."""
        return await self._registry_write(
            "pauseAgents", [paused], "immediate",
            lambda _r: "Agents paused; every queued item is voided." if paused else "Agents resumed.",
            ["Pausing voids every queued item (including pending ownership transfers); executing them only clears them."] if paused else [])

    async def withdraw(self, *, token: str | None = None, usdc: str | None = None, usdc6: int | None = None, all: bool = False,
                       amount: str | None = None, amount_wei: int | None = None, **unknown: object) -> ChangeResult:
        """To the owner only, from the account (there is no recipient parameter). Native USDC: exactly one of `usdc`, `usdc6`
        or `all`. A token (Launch or any other ERC-20 that ended up in the account): `token` with exactly one of `amount_wei`,
        `all`, or (Launch tokens only, 18 decimals) `amount`. Other tokens never get a guessed decimal scale."""
        for key in unknown:
            raise InvalidInputError(
                str(key), f"Unknown withdraw field {key}. Withdrawals always go to the account owner; there is no recipient parameter.")
        native = token is None or token.lower() == ZERO
        if token is not None and not native and token.lower() == self._mf.network.launch.usdc.lower():
            raise InvalidInputError("token", "Withdraw USDC as native (omit token): the ERC-20 view at 0x3600…0000 is the same balance.")
        given = [name for name, v in (("usdc", usdc), ("usdc6", usdc6), ("amount", amount), ("amount_wei", amount_wei)) if v is not None]
        if all is True:
            given.append("all")
        if len(given) != 1:
            raise InvalidInputError("amount", "Say how much to withdraw: usdc, usdc6 or all (native), or amount_wei, amount or all (token)."
                                    if not given else f"Use exactly one amount field; got {', '.join(given)}.")
        name = given[0]
        if native and name in ("amount", "amount_wei"):
            raise InvalidInputError(name, f"{name} is for a token; for native USDC use usdc, usdc6 or all.")
        if not native and name in ("usdc", "usdc6"):
            raise InvalidInputError(name, f"{name} is for native USDC; for a token use amount_wei, amount (Launch tokens) or all.")
        target = ZERO
        value: int
        if native:
            value = await self._mf.rpc.get_balance(self.account) if name == "all" else usdc6_to_wei(resolve_usdc6(usdc, usdc6))
        else:
            assert token is not None
            target = token
            if name == "amount" and not await self._is_launch_token(token):
                raise InvalidInputError(
                    "amount", "amount assumes 18 decimals, which only Launch tokens are known to have. For other tokens pass amount_wei "
                              "in the token's base units, or all.")
            resolved = "all" if name == "all" else resolve_token_amount(amount, amount_wei)
            value = await self._balance_of(token) if resolved == "all" else resolved
        if value == 0:
            raise InvalidInputError("amount", "Nothing to withdraw.")
        return await self._account_write(
            "withdraw", [target, value],
            lambda _r: f"Withdrew {'the full balance' if name == 'all' else 'the amount'} of {'native USDC' if native else target} to the owner.")

    async def withdraw_many(self, tokens: Sequence[str] | None = None, from_block: int | None = None) -> tuple[list[str], list[str]]:
        """Full balances of the listed tokens (any ERC-20; zero balances are skipped), then native USDC, to the owner. Native
        goes in its own transaction, sent first, so a token that fails cannot block the USDC exit; tokens go in chunks of 100.
        Without `tokens`, Launch tokens are discovered from the API's action history or the account's own logs. Nothing is sent
        when there is nothing to move. Returns (transaction hashes, tokens moved)."""
        candidates = list(tokens) if tokens is not None else await self._launch_tokens_only(await self._tokens_touched(from_block))
        seen: set[str] = set()
        held: list[str] = []
        usdc = self._mf.network.launch.usdc.lower()
        for t in candidates:
            key = t.lower()
            if key in seen or key in (ZERO, usdc):
                continue
            seen.add(key)
            if await self._balance_of(t) > 0:
                held.append(t)
        hashes: list[str] = []
        if await self._mf.rpc.get_balance(self.account) > 0:
            r = await self._account_write("withdrawMany", [[ZERO]], lambda _r: "Withdrew native USDC to the owner.")
            if r.tx_hash:
                hashes.append(r.tx_hash)
        for i in range(0, len(held), WITHDRAW_CHUNK):
            r = await self._account_write("withdrawMany", [held[i : i + WITHDRAW_CHUNK]], lambda _r: "Withdrew tokens to the owner.")
            if r.tx_hash:
                hashes.append(r.tx_hash)
        return hashes, held

    async def _tokens_touched(self, from_block: int | None) -> list[str]:
        api = self._mf.api
        if api is not None:
            try:
                out: list[str] = []
                cursor: str | None = None
                for _page in range(MAX_ACTION_PAGES):
                    page = await api.list_actions(self.account, cursor)
                    out.extend(item["token"] for item in page["items"] if isinstance(item.get("token"), str))
                    cursor = page.get("nextCursor")
                    if not cursor:
                        return out
                # more pages than the cap: fall back to the chain rather than loop on a hostile or broken cursor
            except Exception:  # fall back to the chain
                pass
        logs = await scan_logs(self._mf.rpc, self.account, from_block if from_block is not None else self._agents.deploy_block,
                               topics=[AGENT_ACTION_TOPIC])
        tokens: list[str] = []
        for entry in logs:
            try:
                decoded = AGENT_ACCOUNT.decode_log(entry["topics"], entry["data"])
            except MercurifiError:
                continue
            if decoded is not None and decoded[0] == "AgentAction":
                tokens.append(decoded[1]["token"])
        return tokens

    async def _is_launch_token(self, token: str) -> bool:
        curve = await self._mf.rpc.read(LAUNCH_FACTORY, self._mf.network.launch.factory, "curveOf", token)
        return str(curve).lower() != ZERO

    async def _launch_tokens_only(self, tokens: Sequence[str]) -> list[str]:
        """Discovered tokens come from an API or logs; only Launch tokens (known to the Launch factory) are ever asked to transfer."""
        out: list[str] = []
        seen: set[str] = set()
        for t in tokens:
            if t.lower() in seen:
                continue
            seen.add(t.lower())
            if await self._is_launch_token(t):
                out.append(t)
        return out

    async def _balance_of(self, token: str) -> int:
        return int(await self._mf.rpc.read(LAUNCH_TOKEN, token, "balanceOf", self.account))

    async def _registry_write(self, fn: str, args: list[Any], expected: Outcome, describe: Callable[[ChangeResult], str],
                              warnings: Sequence[str] = (), must_queue: bool = False) -> ChangeResult:
        """A registry owner function: sent to the registry with the account as its first argument."""
        return await _send_change(self._mf, self._signer, self._agents.registry, self.account, self._agents.registry,
                                  AGENT_POLICY_REGISTRY, fn, [self.account, *args], expected, describe, warnings, must_queue)

    async def _account_write(self, fn: str, args: list[Any], describe: Callable[[ChangeResult], str]) -> ChangeResult:
        """An account function (withdrawals): sent to the account itself."""
        return await _send_change(self._mf, self._signer, self._agents.registry, self.account, self.account, AGENT_ACCOUNT,
                                  fn, args, "immediate", describe)
