from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

import pytest
from eth_abi.abi import encode

from mercurifi.abi import AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY, LAUNCH_TOKEN
from mercurifi.abi import LAUNCH_FACTORY as LF
from mercurifi.codec import to_hex
from mercurifi.errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotOwnerError
from mercurifi.owner import AccountManager, FirstAgent, OwnerClient
from mercurifi.permissions import SELL_RISK_WARNING
from mercurifi.policy import DEFAULT_POLICY
from mercurifi.queue import POLICY_TYPE, effective_eta
from mercurifi.signers import local_key

from .helpers import (
    ACCOUNT,
    AGENT_KEY,
    FACTORY,
    LAUNCH_FACTORY,
    OWNER_KEY,
    REGISTRY,
    TOKEN,
    WAD,
    ZERO,
    A,
    MockRpc,
    agent_action_log,
    local_client,
    local_rpc,
    log,
    mock_account,
    mock_curve,
    queue_log,
    registry_log,
    sent,
)

OWNER, AGENT = local_key(OWNER_KEY), local_key(AGENT_KEY)
SALT = "0x" + "ab" * 32
USDC = "0x3600000000000000000000000000000000000000"
AGENT2, NEW_OWNER, DD = A(0x66), A(0x55), A(0xDD)
ETA = 1_700_003_600


class Ctx:
    def __init__(self, rpc: MockRpc, owner: OwnerClient, warnings: list[str], mf: Any) -> None:
        self.rpc, self.owner, self.warnings, self.mf = rpc, owner, warnings, mf


async def setup(owner: str | None = None, **over: Any) -> Ctx:
    rpc = local_rpc()
    mock_account(rpc, owner=owner or OWNER.address, agent=AGENT.address)
    mock_curve(rpc, balance=5 * WAD)
    rpc.read(FACTORY, AGENT_ACCOUNT_FACTORY, "predictAccount", ACCOUNT)
    rpc.read(FACTORY, AGENT_ACCOUNT_FACTORY, "createAccount", ACCOUNT)
    rpc.receipt_logs = [log(AGENT_ACCOUNT_FACTORY, FACTORY, "AccountCreated", owner=OWNER.address, account=ACCOUNT, salt=SALT)]
    warnings: list[str] = []
    mf = await local_client(rpc, on_warning=warnings.append, **over)
    return Ctx(rpc, mf.owner(OWNER), warnings, mf)


async def mgr(**over: Any) -> tuple[Ctx, AccountManager]:
    t = await setup(**over)
    t.rpc.receipt_logs = []
    return t, await t.owner.manage(ACCOUNT)


def add_payload(agent: str, expires_at: int, perms: int = 29) -> str:
    return to_hex(encode(["address", "uint40", "uint16"], [agent, expires_at, perms]))


def owner_payload(a: str) -> str:
    return to_hex(encode(["address"], [a]))


# --- creation -------------------------------------------------------------------------------------------------------

async def test_create_with_defaults_on_the_factory() -> None:
    t = await setup()
    res = await t.owner.create_account(salt=SALT, first_agent=FirstAgent(AGENT.address))
    assert res.account == ACCOUNT
    to, name, args = sent(t.rpc)
    assert (to, name) == (FACTORY.lower(), "createAccount")
    init = args[1]
    assert init["policy"] == DEFAULT_POLICY.to_abi()
    assert (init["periodSeconds"], init["increaseDelay"], init["referrer"], init["firstAgentPermissions"]) == (86_400, 3_600, ZERO, 1 | 4 | 8 | 16)
    assert init["firstAgentExpiresAt"] == t.rpc.block["timestamp"] + 30 * 86_400
    predict = [p for m, p in t.rpc.calls if m == "eth_call" and p[0]["data"].startswith(AGENT_ACCOUNT_FACTORY.selector("predictAccount"))]
    assert predict and OWNER.address.lower()[2:] in predict[0][0]["data"].lower()  # the salt is bound to the owner


async def test_sell_warns() -> None:
    t = await setup()
    await t.owner.create_account(salt=SALT, first_agent=FirstAgent(AGENT.address, permissions=("buy", "sell")))
    assert SELL_RISK_WARNING in t.warnings


async def test_refusals_send_nothing() -> None:
    t = await setup()
    with pytest.raises(InvalidInputError, match="referrer cannot be the account"):
        await t.owner.create_account(salt=SALT, referrer=ACCOUNT)
    with pytest.raises(InvalidInputError, match="beta ceiling"):
        await t.owner.create_account(salt=SALT, policy={"max_trade_usdc": "5000"})
    with pytest.raises(InvalidInputError):
        await t.owner.create_account(salt=SALT, first_agent=FirstAgent(OWNER.address))
    assert t.rpc.sent == []


async def test_create_requires_the_factory_event_matching_the_prediction() -> None:
    t = await setup()
    t.rpc.receipt_logs = []
    with pytest.raises(MercurifiError) as exc:
        await t.owner.create_account(salt=SALT)
    assert exc.value.code == "MISSING_EVENT"
    t.rpc.receipt_logs = [log(AGENT_ACCOUNT_FACTORY, FACTORY, "AccountCreated", owner=OWNER.address, account=A(0x31), salt=SALT)]
    with pytest.raises(NetworkMismatchError, match="not the predicted"):
        await t.owner.create_account(salt=SALT)
    # an event from some other emitter does not count
    t.rpc.receipt_logs = [log(AGENT_ACCOUNT_FACTORY, A(0x30), "AccountCreated", owner=OWNER.address, account=ACCOUNT, salt=SALT)]
    with pytest.raises(MercurifiError):
        await t.owner.create_account(salt=SALT)


async def test_create_refuses_an_existing_account_and_a_bad_period() -> None:
    t = await setup()
    t.rpc.codes[ACCOUNT.lower()] = "0x6001"
    with pytest.raises(InvalidInputError, match="already exists"):
        await t.owner.create_account(salt=SALT)
    with pytest.raises(InvalidInputError):
        await t.owner.create_account(salt=SALT, period_seconds=5)
    assert t.rpc.sent == []


async def test_manage_refuses_non_owner_read_from_the_registry() -> None:
    t = await setup(owner=A(0x99))
    with pytest.raises(NotOwnerError):
        await t.owner.manage(ACCOUNT)


# --- policy ---------------------------------------------------------------------------------------------------------

async def test_mixed_policy_change() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setPolicy", 4)
    t.rpc.receipt_logs = [registry_log("PolicyQueued", id=4, eta=ETA)]
    res = await m.set_policy({"max_trade_usdc": "50", "period_spend_cap": "900"})
    assert (res.outcome, res.queued_id, res.eta) == ("mixed", 4, ETA)
    assert res.preview is not None and (res.preview.immediate, res.preview.queued) == (("max_trade_usdc",), ("period_spend_cap",))
    assert "Queued as item 4" in res.summary and res.warnings


async def test_set_policy_goes_to_the_registry_with_the_account_first() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setPolicy", 0)
    await m.set_policy({"max_trade_usdc": "50"})
    to, name, args = sent(t.rpc)
    assert (to, name, args[0]) == (REGISTRY.lower(), "setPolicy", ACCOUNT)
    assert args[1] == {**DEFAULT_POLICY.to_abi(), "maxTradeUsdc": 50_000_000}


async def test_set_policy_same_sends_nothing() -> None:
    t, m = await mgr()
    res = await m.set_policy({"max_trade_usdc": "100"})
    assert res.outcome == "none" and t.rpc.sent == []


def _iso(t: int) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


async def test_preview_splits_immediate_and_queued_with_the_window() -> None:
    t, m = await mgr()
    p = await m.preview_policy({"max_trade_usdc": "50", "period_spend_cap": "900"})
    now = t.rpc.block["timestamp"]
    assert (p.immediate, p.queued) == (("max_trade_usdc",), ("period_spend_cap",))
    assert p.eta_if_queued == now + 3_600 and p.expires_if_queued == now + 3_600 + 604_800
    assert p.ceilings is not None
    assert "max_trade_usdc: 100 -> 50 applies immediately" in p.summary[0]
    assert "period_spend_cap: 500 -> 900 is queued; executable from " in p.summary[1] and " until " in p.summary[1]
    # Same ISO form as TypeScript's Date.toISOString (milliseconds included).
    assert p.summary[1].endswith(f"executable from {_iso(now + 3_600)} until {_iso(now + 3_600 + 604_800)}")
    assert t.rpc.sent == []
    n = await m.preview_policy({"max_trade_usdc": "50"})
    assert (n.eta_if_queued, n.expires_if_queued, n.queued) == (None, None, ())


def test_effective_eta_takes_the_larger_delay() -> None:
    assert effective_eta(100, 60, 3_600) == 3_700
    assert effective_eta(100, 3_600, 60) == 3_700


# --- queue view -----------------------------------------------------------------------------------------------------

async def test_list_queued_from_registry_logs() -> None:
    t, m = await mgr()
    rpc = t.rpc
    now = rpc.block["timestamp"]
    rpc.logs = [queue_log(1), queue_log(2, "IncreaseDelayQueued"), queue_log(3),
                log(AGENT_POLICY_REGISTRY, REGISTRY, "AgentQueued", account=A(0x55), id=9)]
    add = add_payload(AGENT.address, now + 86_400)
    delay = to_hex(encode(["uint32"], [60]))

    def queued(a: list[object]) -> tuple[object, ...]:
        items = {1: (1, now - 10, 1, 1, add), 2: (5, now + 100, 1, 1, delay), 3: (1, now - 10, 0, 1, add)}
        if a[1] not in items:
            raise AssertionError(f"another account's id {a[1]} was read")
        return items[a[1]]  # type: ignore[index]

    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", queued)
    items = await m.list_queued()
    assert [(q.id, q.kind, q.status) for q in items] == [(1, "addAgent", "ready"), (2, "delay", "pending"), (3, "addAgent", "cancelled")]
    assert items[0].detail == {"agent": AGENT.address, "expires_at": now + 86_400, "permissions": ["buy", "launch", "swap", "claim"]}
    flt = rpc.methods("eth_getLogs")[0][0]
    assert flt["address"].lower() == REGISTRY.lower()
    assert flt["topics"] == [None, "0x" + "0" * 24 + ACCOUNT[2:].lower()]


async def test_list_queued_skips_malformed_logs() -> None:
    t, m = await mgr()
    rpc = t.rpc
    now = rpc.block["timestamp"]
    bad = {**queue_log(7), "data": "0x01"}  # right topics, truncated data
    rpc.logs = [bad, queue_log(1)]
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", lambda a: (1, now - 10, 1, 1, add_payload(AGENT.address, now + 86_400)))
    assert [q.id for q in await m.list_queued()] == [1]


async def test_stale_items_and_superseded_policy_fields() -> None:
    t, m = await mgr()
    rpc = t.rpc
    now = rpc.block["timestamp"]
    rpc.logs = [queue_log(1), queue_log(2, "PolicyQueued")]
    target = replace(DEFAULT_POLICY, period_spend_cap=900_000_000)
    policy_payload = to_hex(encode([POLICY_TYPE], [tuple(target.to_abi().values())]))
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued",
             lambda a: (2, now - 10, 1, 5, add_payload(AGENT.address, now + 86_400)) if a[1] == 1 else (3, now + 100, 1, 5, policy_payload))
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agentWrite", 7)
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "policyWrite", lambda a: 9 if a[1] == 0 else 0)
    items = await m.list_queued()
    assert [(q.id, q.kind, q.seq, q.status) for q in items] == [(1, "setAgent", 5, "stale"), (2, "policy", 5, "pending")]
    assert items[1].detail["superseded"] == ["max_trade_usdc"]
    assert items[1].detail["policy"].period_spend_cap == 900_000_000
    # every field superseded: the whole policy item is stale
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "policyWrite", 9)
    again = await m.list_queued()
    assert again[1].status == "stale" and again[1].warning is not None and "changes nothing" in again[1].warning


async def test_expired_and_stale_flags_with_warnings() -> None:
    t, m = await mgr()
    rpc = t.rpc
    now = rpc.block["timestamp"]
    rpc.logs = [queue_log(1), queue_log(2, "TokenAllowQueued"), queue_log(3, "IncreaseDelayQueued")]

    def queued(a: list[object]) -> tuple[object, ...]:
        if a[1] == 1:
            return (4, now - 604_800 - 5, 1, 1, owner_payload(TOKEN))
        if a[1] == 2:
            return (4, now - 10, 1, 1, owner_payload(TOKEN))
        return (5, now + 10, 1, 2, to_hex(encode(["uint32"], [60])))

    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", queued)
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "tokenWrite", 3)
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "delayWrite", 2)
    items = await m.list_queued()
    assert [(q.id, q.status) for q in items] == [(1, "expired"), (2, "stale"), (3, "pending")]
    assert items[0].expires_at == now - 5
    assert items[0].warning is not None and "QueuedExpired" in items[0].warning
    assert items[1].warning is not None and "StaleQueued" in items[1].warning
    assert items[2].warning is None


async def test_expired_wins_over_stale_like_execute_queued() -> None:
    t, m = await mgr()
    now = t.rpc.block["timestamp"]
    t.rpc.logs = [queue_log(1, "TokenAllowQueued")]
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", (4, now - 604_800 - 5, 1, 1, owner_payload(TOKEN)))
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "tokenWrite", 3)
    assert (await m.list_queued())[0].status == "expired"


async def test_unexecutable_agent_items_and_owner_items() -> None:
    t, m = await mgr()
    rpc = t.rpc
    now = rpc.block["timestamp"]
    rpc.logs = [queue_log(1), queue_log(2, "OwnershipQueued"), queue_log(3, "OwnershipQueued")]

    def queued(a: list[object]) -> tuple[object, ...]:
        if a[1] == 1:
            return (1, now + 3_600, 1, 1, add_payload(AGENT.address, now + 1_800, 1))
        if a[1] == 2:
            return (6, now + 100, 1, 1, owner_payload(NEW_OWNER))
        return (6, now - 10, 0, 1, owner_payload(NEW_OWNER))

    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", queued)
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agentWrite", 99)  # owner items are never stale by seq; agent item here is unexecutable
    items = await m.list_queued()
    assert [(q.id, q.kind, q.status) for q in items] == [(1, "addAgent", "stale"), (2, "owner", "pending"), (3, "owner", "cancelled")]
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agentWrite", 0)
    items = await m.list_queued()
    assert [(q.id, q.status) for q in items] == [(1, "unexecutable"), (2, "pending"), (3, "cancelled")]
    assert items[0].warning is not None and "AgentExpiryOutOfRange" in items[0].warning
    assert items[1].warning is not None and "new owner calling acceptOwnership" in items[1].warning
    assert items[2].warning is not None and "Only cancelQueued clears it" in items[2].warning
    assert items[1].detail == {"new_owner": NEW_OWNER}


async def test_pending_ownership_for_the_incoming_owner() -> None:
    t = await setup(NEW_OWNER)
    now = t.rpc.block["timestamp"]
    t.rpc.logs = [queue_log(1, "OwnershipQueued"), queue_log(2, "OwnershipQueued")]
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued",
               lambda a: (6, now - 10, 1, 1, owner_payload(OWNER.address if a[1] == 1 else A(0x77))))
    mine = await t.owner.pending_ownership(ACCOUNT)
    assert [(q.id, q.status) for q in mine] == [(1, "ready")]


class FakeApi:
    def __init__(self, pending: list[dict[str, Any]] | Exception, pages: int = 0) -> None:
        self.pending, self.account_calls, self.action_calls = pending, 0, 0
        self.pages = pages

    async def get_account(self, account: str) -> dict[str, Any]:
        self.account_calls += 1
        if isinstance(self.pending, Exception):
            raise self.pending
        return {"pending": self.pending}

    async def list_actions(self, account: str, cursor: str | None) -> dict[str, Any]:
        self.action_calls += 1
        return {"items": [], "nextCursor": "more"}


async def test_api_candidates_are_verified_on_chain_and_logs_are_not_scanned() -> None:
    api = FakeApi([{"id": "1"}, {"id": "zz"}])
    t, m = await mgr(api=api, api_key="k")
    now = t.rpc.block["timestamp"]
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", (1, now - 10, 1, 1, add_payload(AGENT.address, now + 86_400)))
    assert [q.id for q in await m.list_queued()] == [1]
    assert t.rpc.methods("eth_getLogs") == []


async def test_api_failure_and_empty_answers_fall_back_to_a_bounded_log_scan() -> None:
    down = FakeApi(RuntimeError("down"))
    t, m = await mgr(api=down, api_key="k")
    t.rpc.logs = []
    assert await m.list_queued() == []
    assert down.account_calls == 1 and t.rpc.methods("eth_getLogs")
    empty = FakeApi([])
    t2, m2 = await mgr(api=empty, api_key="k")
    now = t2.rpc.block["timestamp"]
    t2.rpc.logs = [queue_log(1)]
    t2.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", (1, now - 10, 1, 1, add_payload(A(0x51), 1_800_000_000, 1)))
    assert [q.id for q in await m.list_queued()] == [] and [q.id for q in await m2.list_queued()] == [1]
    assert empty.account_calls == 1 and t2.rpc.methods("eth_getLogs")
    nokey = FakeApi([{"id": "1"}])
    _, m3 = await mgr(api=nokey)
    await m3.list_queued()
    assert nokey.account_calls == 0


# --- registry writes ------------------------------------------------------------------------------------------------

async def test_add_agent_queues_on_the_registry_with_id_and_eta_from_the_mined_event() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "addAgent", 6)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=6, eta=ETA)]
    r = await m.add_agent(AGENT2, expires_in_days=30, permissions=["buy"])
    to, name, args = sent(t.rpc)
    assert (to, name, args[0], args[1], args[3]) == (REGISTRY.lower(), "addAgent", ACCOUNT, AGENT2, 1)
    assert args[2] == t.rpc.block["timestamp"] + 30 * 86_400
    assert (r.outcome, r.queued_id, r.eta) == ("queued", 6, ETA)
    assert "queued as item 6" in r.summary


async def test_queue_id_comes_from_the_receipt_not_the_preflight_and_must_match_the_account() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "addAgent", 6)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=77, eta=ETA)]
    assert (await m.add_agent(AGENT2)).queued_id == 77
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=5, eta=ETA, account=A(0x88))]
    with pytest.raises(MercurifiError) as exc:
        await m.add_agent(AGENT2)
    assert exc.value.code == "MISSING_EVENT"


async def test_agent_expiry_the_delay_would_outlive_is_refused_before_sending() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "increaseDelay", 2 * 86_400)
    with pytest.raises(InvalidInputError, match="could never be executed"):
        await m.add_agent(AGENT2, expires_in_days=2)
    with pytest.raises(InvalidInputError, match="could never be executed"):
        await m.rotate_agent(AGENT.address, AGENT2, expires_in_days=1)
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agent", {"active": True, "expiresAt": 1_700_000_100, "permissions": 1})
    with pytest.raises(InvalidInputError, match="could never be executed"):
        await m.set_agent(AGENT.address, expires_in_days=2)
    assert t.rpc.sent == []


async def test_owner_cannot_be_an_agent_and_a_queue_only_call_needs_its_event() -> None:
    t, m = await mgr()
    for call in (m.add_agent(OWNER.address), m.rotate_agent(AGENT.address, OWNER.address)):
        with pytest.raises(InvalidInputError):
            await call
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "addAgent", 6)
    with pytest.raises(MercurifiError) as exc:
        await m.add_agent(AGENT2)
    assert exc.value.code == "MISSING_EVENT"
    assert len(t.rpc.sent) == 1


async def test_eight_active_agents_warn() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "activeAgentCount", 8)
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "addAgent", 6)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=6, eta=ETA)]
    r = await m.add_agent(AGENT2)
    assert "TooManyAgents" in " ".join(r.warnings)
    assert any("TooManyAgents" in w for w in t.warnings)


async def test_sell_risk_warning_is_in_the_result_as_well_as_on_warning() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "addAgent", 6)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=6, eta=ETA)]
    r = await m.add_agent(A(0x51), permissions=["buy", "sell"])
    assert SELL_RISK_WARNING in r.warnings and SELL_RISK_WARNING in t.warnings


async def test_set_agent_narrower_now_wider_queued() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setAgent", 0)
    r = await m.set_agent(AGENT.address, permissions=["buy"])
    assert sent(t.rpc) == (REGISTRY.lower(), "setAgent", [ACCOUNT, AGENT.address, 1_800_000_000, 1])
    assert (r.outcome, r.queued_id, r.eta) == ("immediate", None, None)
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agent", lambda a: {"active": a[1] == AGENT.address, "expiresAt": 1_800_000_000, "permissions": 1})
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setAgent", 9)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=9, eta=ETA)]
    w = await m.set_agent(AGENT.address, permissions=["buy", "swap"])
    assert (w.outcome, w.queued_id) == ("queued", 9) and "old terms stay" in " ".join(w.warnings)
    with pytest.raises(InvalidInputError, match="not an active agent"):
        await m.set_agent(A(0x42))


async def test_rotate_revokes_now_and_queues_the_new_key() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "rotateAgent", 11)
    t.rpc.receipt_logs = [registry_log("AgentQueued", id=11, eta=ETA)]
    r = await m.rotate_agent(AGENT.address, AGENT2, expires_in_days=30)
    to, name, args = sent(t.rpc)
    assert (to, name, args[0], args[1], args[2], args[4]) == (REGISTRY.lower(), "rotateAgent", ACCOUNT, AGENT.address, AGENT2, 1 | 4 | 8 | 16)
    assert (r.outcome, r.queued_id) == ("mixed", 11)


async def test_revoke_cancel_and_pause() -> None:
    t, m = await mgr()
    for fn in ("revokeAgent", "cancelQueued", "pauseAgents"):
        t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, fn, None)
    assert (await m.revoke_agent(AGENT.address)).outcome == "immediate"
    assert (await m.cancel_queued(4)).outcome == "immediate"
    p = await m.pause_agents(True)
    assert sent(t.rpc, 0) == (REGISTRY.lower(), "revokeAgent", [ACCOUNT, AGENT.address])
    assert sent(t.rpc, 1) == (REGISTRY.lower(), "cancelQueued", [ACCOUNT, 4])
    assert sent(t.rpc, 2) == (REGISTRY.lower(), "pauseAgents", [ACCOUNT, True])
    assert "voids every queued item" in " ".join(p.warnings)


async def test_increase_delay_raise_lower_equal() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setIncreaseDelay", 0)
    up = await m.set_increase_delay(7_200)
    assert sent(t.rpc) == (REGISTRY.lower(), "setIncreaseDelay", [ACCOUNT, 7_200])
    assert up.outcome == "immediate"
    joined = " ".join(up.warnings)
    assert "postpones every item already queued" in joined and "past its own expiry" in joined
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setIncreaseDelay", 12)
    t.rpc.receipt_logs = [registry_log("IncreaseDelayQueued", id=12, delay=60, eta=ETA)]
    down = await m.set_increase_delay(60)
    assert sent(t.rpc, 1)[2] == [ACCOUNT, 60]
    assert (down.outcome, down.queued_id, down.eta) == ("queued", 12, ETA) and "Lowering the delay" in " ".join(down.warnings)
    assert (await m.set_increase_delay(3_600)).outcome == "none"
    assert len(t.rpc.sent) == 2


async def test_transfer_ownership_queues_and_warns() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "transferOwnership", 8)
    t.rpc.receipt_logs = [registry_log("OwnershipQueued", id=8, newOwner=NEW_OWNER, eta=ETA)]
    r = await m.transfer_ownership(NEW_OWNER)
    assert sent(t.rpc) == (REGISTRY.lower(), "transferOwnership", [ACCOUNT, NEW_OWNER])
    assert (r.outcome, r.queued_id) == ("queued", 8)
    joined = " ".join(r.warnings)
    assert "acceptOwnership" in joined and "retires the new owner as an agent" in joined and t.warnings


async def test_token_allowlist_rules() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "tokenAllowed", True)
    assert (await m.set_token_allowed(TOKEN, True)).outcome == "none" and t.rpc.sent == []
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "tokenAllowed", False)
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "setTokenAllowed", 0)
    t.rpc.receipt_logs = []
    with pytest.raises(MercurifiError) as missing:  # id 0 and no event: the outcome is unknown
        await m.set_token_allowed(TOKEN, True)
    assert missing.value.code == "MISSING_EVENT"
    assert sent(t.rpc) == (REGISTRY.lower(), "setTokenAllowed", [ACCOUNT, TOKEN, True])
    t.rpc.receipt_logs = [registry_log("TokenAllowed", account=A(0x99), token=TOKEN, allowed=True)]
    with pytest.raises(MercurifiError, match="no \\*Queued event"):  # another account's event proves nothing
        await m.set_token_allowed(TOKEN, True)
    t.rpc.receipt_logs = [registry_log("TokenAllowed", token=TOKEN, allowed=True)]
    r = await m.set_token_allowed(TOKEN, True)  # id 0, but the receipt shows it applied
    assert (r.outcome, r.queued_id) == ("immediate", None) and r.warnings
    t.rpc.receipt_logs = []
    assert (await m.set_token_allowed(TOKEN, False)).outcome == "immediate"
    with pytest.raises(InvalidInputError, match="not a Mercurifi Launch token"):
        await m.set_token_allowed(A(0x42), True)


async def test_execute_queued_outcome_comes_from_the_receipt() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", (1, 1_700_000_000, 1, 1, "0x"))
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "executeQueued", None)
    t.rpc.receipt_logs = [registry_log("QueuedExecuted", id=3)]
    ok = await m.execute_queued(3)
    assert sent(t.rpc) == (REGISTRY.lower(), "executeQueued", [ACCOUNT, 3]) and ok.outcome == "immediate"
    t.rpc.receipt_logs = [registry_log("QueuedCancelled", id=3)]
    voided = await m.execute_queued(3)
    assert voided.outcome == "cancelled" and "nothing was applied" in voided.summary
    t.rpc.receipt_logs = [registry_log("QueuedCancelled", id=4)]
    with pytest.raises(MercurifiError) as exc:
        await m.execute_queued(3)
    assert exc.value.code == "MISSING_EVENT"


async def test_execute_queued_refuses_owner_items_and_unknown_ids_locally() -> None:
    t, m = await mgr()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued",
               lambda a: (6, 1_700_000_000, 1, 1, owner_payload(NEW_OWNER)) if a[1] == 8 else (0, 0, 0, 0, "0x"))
    with pytest.raises(InvalidInputError, match="acceptOwnership"):
        await m.execute_queued(8)
    with pytest.raises(InvalidInputError, match="no queued item 99"):
        await m.execute_queued(99)
    assert t.rpc.sent == []


async def test_accept_ownership_on_the_registry() -> None:
    t = await setup()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "acceptOwnership", None)
    t.rpc.receipt_logs = [registry_log("QueuedExecuted", id=3)]
    res = await t.owner.accept_ownership(ACCOUNT, 3)
    assert res.outcome == "immediate" and res.warnings == []
    assert sent(t.rpc) == (REGISTRY.lower(), "acceptOwnership", [ACCOUNT, 3])


async def test_accept_ownership_needs_the_event_for_this_id_and_account() -> None:
    t = await setup()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "acceptOwnership", None)
    for logs in ([], [registry_log("QueuedExecuted", id=4)], [registry_log("QueuedExecuted", id=3, account=A(0x88))]):
        t.rpc.receipt_logs = logs
        with pytest.raises(MercurifiError) as exc:
            await t.owner.accept_ownership(ACCOUNT, 3)
        assert exc.value.code == "MISSING_EVENT"


async def test_accept_ownership_warns_about_retirement_only_for_an_active_agent() -> None:
    t = await setup()
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "acceptOwnership", None)
    t.rpc.receipt_logs = [registry_log("QueuedExecuted", id=3)]
    as_agent = await t.mf.owner(AGENT).accept_ownership(ACCOUNT, 3)
    assert "retires it as an agent" in " ".join(as_agent.warnings)
    t.rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "agent", {"active": False, "expiresAt": 0, "permissions": 0})
    assert (await t.mf.owner(AGENT).accept_ownership(ACCOUNT, 3)).warnings == []


# --- money in and out -----------------------------------------------------------------------------------------------

async def test_deposit_and_fund_gas_send_native_value() -> None:
    t = await setup()
    t.rpc.on("eth_call", lambda p: "0x" if p[0].get("data", "0x") == "0x" else t.rpc._call(p[0]))
    t.rpc.on("eth_estimateGas", lambda p: hex(21_000))
    await t.owner.deposit(ACCOUNT, usdc="2")
    await t.owner.fund_gas(AGENT.address, usdc6=500_000)
    from .helpers import _tx

    assert _tx(t.rpc, 0)["value"] == 2 * WAD and _tx(t.rpc, 1)["value"] == 500_000 * 10**12


async def test_withdraw_native_from_the_account() -> None:
    t, m = await mgr()
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdraw", None)
    await m.withdraw(usdc="10")
    assert sent(t.rpc) == (ACCOUNT.lower(), "withdraw", [ZERO, 10 * WAD])
    with pytest.raises(InvalidInputError, match="as native"):
        await m.withdraw(token=USDC, amount="1")
    await m.withdraw(all=True)
    assert sent(t.rpc, 1)[2] == [ZERO, 1_000 * WAD]


async def test_withdraw_amount_all_string_is_a_token_amount_not_the_all_flag() -> None:
    t, m = await mgr()
    t.rpc.read(DD, LAUNCH_TOKEN, "balanceOf", 7)
    t.rpc.read(TOKEN, LAUNCH_TOKEN, "balanceOf", 3)
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdraw", None)
    with pytest.raises(InvalidInputError, match="amount is for a token"):
        await m.withdraw(amount="all")
    with pytest.raises(InvalidInputError, match="amount assumes 18 decimals"):
        await m.withdraw(token=DD, amount="all")
    assert t.rpc.sent == []
    await m.withdraw(token=TOKEN, amount="all")  # a Launch token may use it
    assert sent(t.rpc)[2] == [TOKEN, 3]


async def test_withdraw_has_no_recipient_parameter() -> None:
    t, m = await mgr()
    with pytest.raises(InvalidInputError, match="no recipient"):
        await m.withdraw(usdc="1", to=A(0x99))
    with pytest.raises(InvalidInputError, match="always go to the account owner"):
        await m.withdraw(usdc="1", recipient=A(0x99))
    assert t.rpc.sent == []


async def test_withdraw_rejects_mixed_or_missing_amount_fields() -> None:
    t, m = await mgr()
    bad: list[dict[str, Any]] = [
        {"usdc": "1", "all": True}, {"usdc": "1", "usdc6": 1}, {"usdc": "1", "amount": "1"}, {"amount": "1"},
        {"token": TOKEN, "usdc": "1"}, {}, {"token": TOKEN, "amount": "1", "amount_wei": 1}, {"amount_wei": 1},
    ]
    for kwargs in bad:
        with pytest.raises(InvalidInputError):
            await m.withdraw(**kwargs)
    assert t.rpc.sent == []


async def test_non_launch_tokens_need_amount_wei_or_all() -> None:
    t, m = await mgr()
    t.rpc.read(DD, LAUNCH_TOKEN, "balanceOf", 7)
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdraw", None)
    with pytest.raises(InvalidInputError, match="amount_wei"):
        await m.withdraw(token=DD, amount="1")
    await m.withdraw(token=DD, amount_wei=5)
    await m.withdraw(token=DD, all=True)
    assert sent(t.rpc, 0) == (ACCOUNT.lower(), "withdraw", [DD, 5])
    assert sent(t.rpc, 1) == (ACCOUNT.lower(), "withdraw", [DD, 7])
    # a Launch token may use a decimal amount
    await m.withdraw(token=TOKEN, amount="1")
    assert sent(t.rpc, 2)[2] == [TOKEN, WAD]


async def test_withdraw_many_native_first_in_its_own_tx_then_tokens() -> None:
    t, m = await mgr()
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdrawMany", None)
    hashes, held = await m.withdraw_many([TOKEN, TOKEN, USDC])
    assert held == [TOKEN] and len(hashes) == 2
    assert sent(t.rpc, 0) == (ACCOUNT.lower(), "withdrawMany", [[ZERO]])
    assert sent(t.rpc, 1) == (ACCOUNT.lower(), "withdrawMany", [[TOKEN]])


async def test_withdraw_many_skips_noops_and_chunks_by_100() -> None:
    t, m = await mgr()
    t.rpc.balances[ACCOUNT.lower()] = 0
    t.rpc.read(TOKEN, LAUNCH_TOKEN, "balanceOf", 0)
    assert await m.withdraw_many([TOKEN]) == ([], []) and t.rpc.sent == []
    toks = [A(0x1000 + i) for i in range(230)]
    t.rpc.read(TOKEN, LAUNCH_TOKEN, "balanceOf", 0)
    for tok in toks:
        t.rpc.read(tok, LAUNCH_TOKEN, "balanceOf", 1)
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdrawMany", None)
    hashes, held = await m.withdraw_many(toks)
    assert len(held) == 230 and len(hashes) == 3  # no native balance: 100 + 100 + 30
    assert [len(sent(t.rpc, i)[2][0]) for i in range(3)] == [100, 100, 30]


async def test_withdraw_many_discovers_launch_tokens_only_from_the_account_logs() -> None:
    t, m = await mgr()
    t.rpc.logs = [agent_action_log(token=TOKEN), agent_action_log(token=A(0xDD))]
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdrawMany", None)
    _, held = await m.withdraw_many()
    assert held == [TOKEN]
    assert sent(t.rpc, 1)[2] == [[TOKEN]]
    flt = t.rpc.methods("eth_getLogs")[0][0]
    assert flt["address"].lower() == ACCOUNT.lower()


class _OneTokenApi:
    def __init__(self) -> None:
        self.action_calls = 0

    async def list_actions(self, account: str, cursor: str | None) -> dict[str, Any]:
        self.action_calls += 1
        return {"items": [{"token": TOKEN}], "nextCursor": None}


async def test_withdraw_many_merges_the_api_list_with_the_chain_scan() -> None:
    # An API that omits a token cannot hide it: the account's own logs are always scanned.
    other = A(0xDE)
    api = _OneTokenApi()
    t, m = await mgr(api=api)
    t.rpc.read(LAUNCH_FACTORY, LF, "curveOf", lambda a: A(0xCC))
    t.rpc.read(TOKEN, LAUNCH_TOKEN, "balanceOf", 3)
    t.rpc.read(other, LAUNCH_TOKEN, "balanceOf", 7)
    t.rpc.logs = [agent_action_log(token=other)]
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdrawMany", None)
    _, held = await m.withdraw_many()
    assert api.action_calls == 1
    assert sorted(h.lower() for h in held) == sorted([TOKEN.lower(), other.lower()])


async def test_api_pagination_is_capped_at_50_pages_then_the_chain_is_read() -> None:
    api = FakeApi([])
    t, m = await mgr(api=api)
    t.rpc.balances[ACCOUNT.lower()] = 0
    t.rpc.logs = [agent_action_log(token=TOKEN)]
    t.rpc.read(ACCOUNT, AGENT_ACCOUNT, "withdrawMany", None)
    _, held = await m.withdraw_many()
    assert api.action_calls == 50 and held == [TOKEN]


async def test_owner_client_is_reachable_from_the_client() -> None:
    t = await setup()
    assert isinstance(t.mf.owner(OWNER), OwnerClient)


async def test_reads_and_payload_decoding() -> None:
    from mercurifi.queue import decode_queued_payload, list_queued
    from mercurifi.reads import is_agent_account, read_account_state, read_agent, read_ceilings

    t = await setup()
    agents, rpc = t.mf.require_agents(), t.mf.rpc
    state = await read_account_state(rpc, agents, ACCOUNT)
    assert (state.owner, state.registry, state.increase_delay, state.epoch, state.write_seq) == (OWNER.address, REGISTRY, 3_600, 1, 1)
    assert state.balance_wei == 1_000 * WAD and state.policy == DEFAULT_POLICY and not state.factory_paused
    assert await is_agent_account(rpc, agents, ACCOUNT) and not await is_agent_account(rpc, agents, A(0x42))
    assert (await read_ceilings(rpc, agents)).max_trade_usdc == 1_000_000_000
    info = await read_agent(rpc, agents, ACCOUNT, AGENT.address, 1_700_000_000)
    assert info.active and not info.retired and not info.expired and info.permission_bits == 63
    assert decode_queued_payload(99, "0x1234") == ("unknown", {"raw": "0x1234"})
    assert decode_queued_payload(5, "0x12") == ("unknown", {"raw": "0x12"})
    assert callable(list_queued)


async def test_list_queued_scans_to_the_head_after_it_moves() -> None:
    # Chain-only listing (no API) reads the head on every call: blocks mined since the last listing are scanned.
    t, m = await mgr()
    rpc = t.rpc
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "queued", lambda a: (0, 0, 0, 0, "0x"))
    await m.list_queued()
    rpc.block["number"] += 7
    before = len(rpc.calls)
    await m.list_queued()
    scans = [p[0]["toBlock"] for meth, p in rpc.calls[before:] if meth == "eth_getLogs"]
    assert scans and scans[-1] == hex(rpc.block["number"])
