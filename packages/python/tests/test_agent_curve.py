from dataclasses import replace
from typing import Any

import pytest

from mercurifi.abi import AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY, BONDING_CURVE
from mercurifi.agent import AgentClient
from mercurifi.errors import InvalidInputError, MercurifiError
from mercurifi.policy import DEFAULT_POLICY
from mercurifi.revert import ContractRevertError
from mercurifi.signers import local_key

from .helpers import (
    ACCOUNT,
    AGENT_KEY,
    CURVE,
    FACTORY,
    REGISTRY,
    TOKEN,
    WAD,
    A,
    MockRpc,
    agent_action_log,
    local_client,
    local_rpc,
    log,
    mock_account,
    mock_curve,
    sent_call,
)

SIGNER = local_key(AGENT_KEY)


async def setup(account: dict[str, Any] | None = None, **curve: Any) -> tuple[MockRpc, Any, AgentClient]:
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=SIGNER.address, **(account or {}))
    mock_curve(rpc, **curve)
    rpc.read(ACCOUNT, AGENT_ACCOUNT, "buy", 0)
    rpc.read(ACCOUNT, AGENT_ACCOUNT, "sell", 0)
    rpc.receipt_logs = [agent_action_log(agent=SIGNER.address, action=1, token=TOKEN, usdcSpent=25_000_000, tokenDelta=1_000_000 * WAD, periodId=19_637)]
    mf = await local_client(rpc)
    return rpc, mf, await mf.agent(ACCOUNT, SIGNER, slippage=0.02)


async def refused(run: Any, name: str) -> ContractRevertError:
    with pytest.raises(ContractRevertError) as e:
        await run
    assert e.value.revert.name == name
    assert e.value.phase == "local"
    return e.value


async def test_buy_with_floor_and_chain_deadline() -> None:
    rpc, _, agent = await setup()
    fill = await agent.buy(TOKEN, usdc="25")
    name, args, tx = sent_call(rpc, AGENT_ACCOUNT)
    assert name == "buy"
    assert list(args.values()) == [TOKEN, 25_000_000, 980_000 * WAD, rpc.block["timestamp"] + 60]
    assert tx["gas"] == 180_000
    assert (fill.action, fill.tokens_out, fill.usdc_spent, fill.launched) == ("buy", 1_000_000 * WAD, "25", None)


async def test_graduating_buy_floor() -> None:
    rpc, _, agent = await setup(used=lambda u: u - 1)
    await agent.buy(TOKEN, usdc="25")
    assert sent_call(rpc, AGENT_ACCOUNT)[2]["gas"] == 1_800_000


async def test_local_refusals() -> None:
    rpc, _, agent = await setup(phase=2)
    with pytest.raises(ContractRevertError) as e:
        await agent.buy(A(0xDD), usdc="1")
    assert e.value.revert.name == "TokenNotRegistered"
    with pytest.raises(ContractRevertError, match="swapExactIn"):
        await agent.buy(TOKEN, usdc="1")
    assert rpc.sent == []


async def test_sell_all_with_zero_balance_fails_locally() -> None:
    rpc, _, agent = await setup(balance=0)
    with pytest.raises(InvalidInputError, match="holds none of this token"):
        await agent.sell(TOKEN, amount="all")
    assert rpc.sent == []


async def test_sell_more_than_the_balance_fails_locally() -> None:
    rpc, _, agent = await setup(balance=WAD)
    with pytest.raises(InvalidInputError, match="holds less"):
        await agent.sell(TOKEN, amount_wei=2 * WAD)
    assert rpc.sent == []


async def test_sell_all_while_pending() -> None:
    rpc, _, agent = await setup(phase=1, balance=5 * WAD, usdc_out=9_900_000_000_000_000_000)
    await agent.sell(TOKEN, amount="all")
    assert list(sent_call(rpc, AGENT_ACCOUNT)[1].values()) == [TOKEN, 5 * WAD, 9_702_000, rpc.block["timestamp"] + 60]


async def test_sell_valued_at_high_water_refused_locally() -> None:
    # 100 USDC for 1,000 tokens, then a crash buy of 10 USDC for 10,000: the average is 0.01 but the high-water stays 0.1.
    rpc, _, agent = await setup({"basis": (110_000_000, 11_000 * WAD, 10**23)}, balance=11_000 * WAD)
    assert (await agent.position(TOKEN)).high_water == 10**23
    err = await refused(agent.sell(TOKEN, amount_wei=2_000 * WAD), "TradeTooLarge")  # valued at 200 USDC (high-water), not 20 (average)
    assert err.phase == "local"
    assert rpc.sent == []


async def test_headroom_from_the_registry() -> None:
    rpc, _, agent = await setup()
    h = await agent.headroom()
    assert (h.spend, h.sell, h.actions, h.launches, h.max_trade) == ("400", "500", 499, 3, "100")
    assert h.period_ends_at == (19_637 + 1) * 86_400
    headroom_call = AGENT_POLICY_REGISTRY.encode("headroom", ACCOUNT).lower()
    calls = [p[0] for p in rpc.methods("eth_call")]
    assert any(c["to"].lower() == REGISTRY.lower() and c["data"].lower() == headroom_call for c in calls)


async def test_refuses_non_account() -> None:
    _, mf, _ = await setup()
    with pytest.raises(InvalidInputError, match="not a Mercurifi agent account"):
        await mf.agent(A(0xEE), SIGNER)


# --- the preflight mirrors the account ---------------------------------------------------------------------------------

async def test_price_impact_with_the_same_bps_the_account_computes() -> None:
    rpc, _, agent = await setup(price=10**13)
    err = await refused(agent.buy(TOKEN, usdc="25"), "PriceImpactTooHigh")
    assert err.revert.args == [14_750]
    assert rpc.sent == []


async def test_snipe_age_and_allowlist() -> None:
    _, _, agent = await setup(snipe=500)
    await refused(agent.buy(TOKEN, usdc="1"), "SnipeTaxTooHigh")
    young = await setup({"policy": replace(DEFAULT_POLICY, min_token_age_blocks=1_000)})  # block 1000, launchBlock 100: age 900
    await refused(young[2].buy(TOKEN, usdc="1"), "TokenTooNew")
    listed = await setup({"policy": replace(DEFAULT_POLICY, allowlist_only=True)})
    await refused(listed[2].buy(TOKEN, usdc="1"), "TokenNotAllowed")
    assert young[0].sent == [] and listed[0].sent == []


async def test_max_trade_spend_headroom_and_token_cap() -> None:
    _, _, agent = await setup()
    await refused(agent.buy(TOKEN, usdc="101"), "TradeTooLarge")
    low = await setup({"headroom": (20_000_000, 500_000_000, 499, 3)})
    assert (await refused(low[2].buy(TOKEN, usdc="25"), "PeriodSpendExceeded")).revert.args == [20_000_000]
    capped = await setup()
    capped[0].read(REGISTRY, AGENT_POLICY_REGISTRY, "tokenSpent", 90_000_000)
    assert (await refused(capped[2].buy(TOKEN, usdc="25"), "TokenCapExceeded")).revert.args == [10_000_000]
    assert low[0].sent == [] and capped[0].sent == []


async def test_spend_checked_against_what_a_final_buy_really_uses() -> None:
    rpc, _, agent = await setup({"headroom": (16_000_000, 500_000_000, 499, 3)}, used=lambda u: u - 10**19)
    await agent.buy(TOKEN, usdc="25")
    assert len(rpc.sent) == 1


async def test_sell_above_the_sell_headroom_reports_the_remainder() -> None:
    rpc, _, agent = await setup({"headroom": (400_000_000, 5_000_000, 499, 3)}, balance=5 * WAD)
    err = await refused(agent.sell(TOKEN, amount="all"), "PeriodSellExceeded")
    assert err.revert.args == [5_000_000]
    assert rpc.sent == []


async def test_sell_price_impact() -> None:
    _, _, agent = await setup(balance=5 * WAD, price=4 * WAD)
    await refused(agent.sell(TOKEN, amount="all"), "PriceImpactTooHigh")


async def test_agent_state_checks() -> None:
    await refused((await setup({"agent_active": False}))[2].buy(TOKEN, usdc="1"), "NotAgent")
    await refused((await setup({"agent_expires_at": 1_600_000_000}))[2].buy(TOKEN, usdc="1"), "AgentExpired")
    await refused((await setup({"agent_permissions": 2}))[2].buy(TOKEN, usdc="1"), "MissingPermission")
    await refused((await setup({"headroom": (400_000_000, 500_000_000, 0, 3)}))[2].buy(TOKEN, usdc="1"), "ActionLimit")


async def test_agent_expiring_next_second_is_refused() -> None:
    now = 1_700_000_000
    await refused((await setup({"agent_expires_at": now + 1}))[2].buy(TOKEN, usdc="1"), "AgentExpired")
    ok = await setup({"agent_expires_at": now + 2})
    await ok[2].buy(TOKEN, usdc="1")


async def test_never_a_zero_minimum() -> None:
    rpc, _, agent = await setup(tokens_out=1, price=10**40)
    await agent.buy(TOKEN, usdc="1", slippage=0.02)
    assert list(sent_call(rpc, AGENT_ACCOUNT)[1].values())[2] == 1
    rpc2, _, agent2 = await setup(tokens_out=1_000 * WAD, price=10**40)
    await agent2.buy(TOKEN, usdc="1", min_tokens_out=999 * WAD)
    assert list(sent_call(rpc2, AGENT_ACCOUNT)[1].values())[2] == 999 * WAD


async def test_deadline_clamped_to_max_deadline_seconds() -> None:
    rpc, mf, _ = await setup({"policy": replace(DEFAULT_POLICY, max_deadline_seconds=30)})
    agent = await mf.agent(ACCOUNT, SIGNER, deadline_seconds=120)
    await agent.buy(TOKEN, usdc="1")
    assert list(sent_call(rpc, AGENT_ACCOUNT)[1].values())[3] == rpc.block["timestamp"] + 30


async def test_measured_fill_not_the_quote() -> None:
    rpc, _, agent = await setup()
    rpc.receipt_logs = [agent_action_log(agent=SIGNER.address, action=1, token=TOKEN, usdcSpent=24_000_000, tokenDelta=7 * WAD, basisValue=24_000_000, periodId=5)]
    fill = await agent.buy(TOKEN, usdc="25")
    assert (fill.usdc_spent6, fill.token_delta, fill.basis_value6, fill.period_id) == (24_000_000, 7 * WAD, 24_000_000, 5)


async def test_sell_fill_has_negative_token_delta() -> None:
    rpc, _, agent = await setup(balance=5 * WAD)
    rpc.receipt_logs = [agent_action_log(agent=SIGNER.address, action=2, token=TOKEN, usdcReceived=9_000_000, tokenDelta=-(5 * WAD), basisValue=9_900_000, periodId=3)]
    fill = await agent.sell(TOKEN, amount="all")
    assert (fill.action, fill.usdc_received6, fill.usdc_received, fill.tokens_in, fill.tokens, fill.basis_value6) == ("sell", 9_000_000, "9", 5 * WAD, "5", 9_900_000)


async def test_no_agent_action_in_the_receipt() -> None:
    rpc, _, agent = await setup()
    rpc.receipt_logs = []
    with pytest.raises(MercurifiError) as e:
        await agent.buy(TOKEN, usdc="1")
    assert e.value.code == "FILL_NOT_FOUND"


async def test_paused_is_checked_first() -> None:
    owner = await setup({"agent_active": False})
    owner[0].read(REGISTRY, AGENT_POLICY_REGISTRY, "ownerPaused", True)
    await refused(owner[2].buy(TOKEN, usdc="1"), "Paused")
    platform = await setup(phase=2)
    platform[0].read(FACTORY, AGENT_ACCOUNT_FACTORY, "isPaused", True)
    await refused(platform[2].buy(A(0xDD), usdc="1"), "Paused")
    await refused(platform[2].sell(TOKEN, amount="all"), "Paused")
    assert owner[0].sent == [] and platform[0].sent == []


async def test_half_of_what_is_left_may_graduate() -> None:
    # remaining = 800M - 100M = 700M; half = 350M
    half = await setup(tokens_out=350_000_000 * WAD)
    await half[2].buy(TOKEN, usdc="25")
    assert sent_call(half[0], AGENT_ACCOUNT)[2]["gas"] == 1_800_000
    under = await setup(tokens_out=349_999_999 * WAD)
    await under[2].buy(TOKEN, usdc="25")
    assert sent_call(under[0], AGENT_ACCOUNT)[2]["gas"] == 180_000


async def test_token_age_is_compared_against_latest_plus_one() -> None:
    ok = await setup({"policy": replace(DEFAULT_POLICY, min_token_age_blocks=901)})  # latest 1000, launchBlock 100: 901 once included
    await ok[2].buy(TOKEN, usdc="1")
    assert len(ok[0].sent) == 1
    await refused((await setup({"policy": replace(DEFAULT_POLICY, min_token_age_blocks=902)}))[2].buy(TOKEN, usdc="1"), "TokenTooNew")


async def test_dust_sell_minimum_is_one_micro_usdc() -> None:
    rpc, _, agent = await setup(balance=5 * WAD, usdc_out=1_500_000_000_000)
    await agent.sell(TOKEN, amount="all", slippage=0.49)
    assert list(sent_call(rpc, AGENT_ACCOUNT)[1].values())[2] == 1
    below, _, agent2 = await setup(balance=5 * WAD, usdc_out=999_999_999_999)
    with pytest.raises(InvalidInputError, match="below 1 micro-USDC"):
        await agent2.sell(TOKEN, amount="all")
    assert below.sent == []


async def test_reads_are_pinned_to_one_block() -> None:
    # The sender's own simulation of the trade is a separate, deliberate "latest" call.
    trade = {AGENT_ACCOUNT.selector("buy").lower(), AGENT_ACCOUNT.selector("sell").lower()}

    def pinned(calls: list[list[Any]]) -> set[str]:
        return {c[1] for c in calls if c[0]["data"][:10].lower() not in trade}

    rpc, _, agent = await setup(balance=5 * WAD)
    for i, run in enumerate((lambda: agent.buy(TOKEN, usdc="1"), lambda: agent.sell(TOKEN, amount="all"), agent.headroom)):
        start = len(rpc.methods("eth_call"))
        await run()
        blocks = pinned(rpc.methods("eth_call")[start:])
        assert blocks == {"0x3e8"}
        if i < 2:
            assert len(rpc.methods("eth_call")[start:]) > 8


async def test_unknown_action_code_is_an_error() -> None:
    rpc, _, agent = await setup()
    rpc.receipt_logs = [agent_action_log(agent=SIGNER.address, action=9, token=TOKEN, periodId=1)]
    with pytest.raises(MercurifiError) as e:
        await agent.buy(TOKEN, usdc="1")
    assert e.value.code == "UNKNOWN_ACTION"


async def test_other_accounts_action_ignored_and_duplicates_rejected() -> None:
    rpc, _, agent = await setup()
    own = agent_action_log(agent=SIGNER.address, action=1, token=TOKEN, usdcSpent=3_000_000, tokenDelta=2 * WAD, periodId=4)
    other = log(AGENT_ACCOUNT, A(0xAB), "AgentAction", agent=SIGNER.address, action=1, token=TOKEN, usdcSpent=99_000_000, tokenDelta=99 * WAD, periodId=9)
    rpc.receipt_logs = [other, own]
    fill = await agent.buy(TOKEN, usdc="3")
    assert (fill.usdc_spent6, fill.period_id) == (3_000_000, 4)
    rpc.receipt_logs = [own, own]
    with pytest.raises(MercurifiError) as e:
        await agent.buy(TOKEN, usdc="3")
    assert e.value.code == "FILL_NOT_FOUND"


async def test_amounts_are_checked_before_any_read() -> None:
    rpc, _, agent = await setup()
    start = len(rpc.methods("eth_call"))
    with pytest.raises(InvalidInputError):
        await agent.buy(TOKEN, usdc="0")
    with pytest.raises(InvalidInputError):
        await agent.buy(TOKEN, usdc=25)  # type: ignore[arg-type]
    assert len(rpc.methods("eth_call")) == start


async def test_logs_without_an_address_are_skipped() -> None:
    rpc, _, agent = await setup()
    own = agent_action_log(agent=SIGNER.address, action=1, token=TOKEN, usdcSpent=3_000_000, tokenDelta=2 * WAD, periodId=4)
    rpc.receipt_logs = [{k: v for k, v in own.items() if k != "address"}, {"address": None, "topics": [], "data": "0x"}, {"address": ACCOUNT}, own]
    assert (await agent.buy(TOKEN, usdc="3")).period_id == 4


async def test_malformed_block_is_an_rpc_error() -> None:
    rpc, _, agent = await setup()
    rpc.on("eth_getBlockByNumber", lambda p: {"number": "0x10", "timestamp": "soon"})
    with pytest.raises(MercurifiError) as e:
        await agent.headroom()
    assert e.value.code == "RPC_ERROR"
    rpc.on("eth_getBlockByNumber", lambda p: {"timestamp": "0x10"})
    with pytest.raises(MercurifiError) as e2:
        await agent.buy(TOKEN, usdc="1")
    assert e2.value.code == "RPC_ERROR"


async def test_sell_on_a_graduated_curve_is_refused_before_quoting() -> None:
    rpc, _, agent = await setup(phase=2, balance=5 * WAD)

    def boom(a: list[Any]) -> Any:
        raise AssertionError("quoteSell must not be read on a graduated curve")

    rpc.read(CURVE, BONDING_CURVE, "quoteSell", boom)
    await refused(agent.sell(TOKEN, amount_wei=WAD), "NotTrading")
