from dataclasses import replace
from typing import Any

import pytest

from mercurifi.abi import AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, GRADUATION_MANAGER, V4_QUOTER
from mercurifi.abi import LAUNCH_FACTORY as LF
from mercurifi.agent import AgentClient, ImageUpload, metadata_uri_problem
from mercurifi.errors import InvalidInputError, MercurifiError
from mercurifi.policy import DEFAULT_POLICY
from mercurifi.pool import estimate_pool_impact_bps
from mercurifi.revert import ContractRevertError
from mercurifi.signers import local_key

from .helpers import (
    ACCOUNT,
    AGENT_KEY,
    CURVE,
    FACTORY,
    LAUNCH_FACTORY,
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
    sent_call,
)

SIGNER = local_key(AGENT_KEY)
SALT = "0x" + "cd" * 32
HASH = "0x" + "92" * 32
USDC = "0x3600000000000000000000000000000000000000"
CONFIG = {"virtualUsdc": 6_000 * WAD, "virtualTokens": 1_066_666_666_666_666_666_666_666_666, "curveSupply": 800_000_000 * WAD,
          "poolSupply": 200_000_000 * WAD, "launchFee": WAD, "maxInitialBuyTokens": 50_000_000 * WAD, "tradeFeeBps": 100,
          "creatorShareBps": 5_000, "referrerShareBps": 2_000, "snipeStartBps": 9_900, "snipeBlocks": 120}
KEY = {"currency0": TOKEN, "currency1": USDC, "fee": 0, "tickSpacing": 60, "hooks": A(4)}
CRASH_BASIS = (110_000_000, 11_000 * WAD, 10**23)
BIG = replace(DEFAULT_POLICY, max_trade_usdc=1_000_000_000, period_spend_cap=5_000_000_000, per_token_period_cap=2_000_000_000)


class FakeApi:
    def __init__(self, uri: Any = "https://api.example/v1/metadata/abc") -> None:
        self.calls: list[tuple[Any, Any]] = []
        self.uri = uri

    async def upload_launch_metadata(self, meta: dict[str, Any], image: Any = None) -> dict[str, Any]:
        self.calls.append((meta, image))
        return {"metadataURI": self.uri, "imageStatus": None}


async def setup(api: Any = None, action: int = 3, account: dict[str, Any] | None = None, warnings: list[str] | None = None, **curve: Any) -> tuple[MockRpc, AgentClient]:
    rpc = local_rpc()
    mock_account(rpc, owner=A(0x99), agent=SIGNER.address, **(account or {}))
    mock_curve(rpc, **curve)
    rpc.read(LAUNCH_FACTORY, LF, "config", CONFIG)
    rpc.read(LAUNCH_FACTORY, LF, "configHash", HASH)
    rpc.read(LAUNCH_FACTORY, LF, "paused", False)
    rpc.read(ACCOUNT, AGENT_ACCOUNT, "launch", (TOKEN, CURVE))
    for fn in ("claimFees", "swapExactIn"):
        rpc.read(ACCOUNT, AGENT_ACCOUNT, fn, 0)
    rpc.read(ACCOUNT, AGENT_ACCOUNT, "sweepToOwner", None)
    rpc.receipt_logs = [
        agent_action_log(agent=SIGNER.address, action=action, token=TOKEN, usdcSpent=11_000_000, tokenDelta=1_757_100 * WAD, periodId=19_637),
        log(LF, LAUNCH_FACTORY, "TokenCreated", token=TOKEN, curve=CURVE, creator=ACCOUNT),
    ]
    extra: dict[str, Any] = {} if warnings is None else {"on_warning": warnings.append}
    mf = await local_client(rpc, api=api, **extra)
    return rpc, await mf.agent(ACCOUNT, SIGNER, slippage=0.02)


async def refused(run: Any, name: str) -> ContractRevertError:
    with pytest.raises(ContractRevertError) as e:
        await run
    assert e.value.revert.name == name
    assert e.value.phase == "local"
    return e.value


def quoter(rpc: MockRpc, f: Any) -> None:
    rpc.read(A(3), GRADUATION_MANAGER, "poolKey", KEY)
    rpc.read(A(8), V4_QUOTER, "quoteExactInputSingle", lambda a: (f(a[0]), 120_000))


def args_of(rpc: MockRpc) -> list[Any]:
    return list(sent_call(rpc, AGENT_ACCOUNT)[1].values())


def request_of(rpc: MockRpc) -> dict[str, Any]:
    first: dict[str, Any] = args_of(rpc)[0]
    return first


# ---------------------------------------------------------------- launch


async def test_launch_pins_hash_exact_first_buy_and_chain_deadline() -> None:
    rpc, agent = await setup()
    fill = await agent.launch("Example", "EX", metadata_uri="ipfs://m", initial_buy_usdc="10", salt=SALT)
    name, _, _ = sent_call(rpc, AGENT_ACCOUNT)
    assert name == "launch"
    assert request_of(rpc) == {"name": "Example", "symbol": "EX", "metadataURI": "ipfs://m", "salt": SALT, "expectedConfigHash": HASH,
                               "initialBuyUsdc": 10_000_000, "minTokensOut": 1_757_100_783_706_883_641_990_715, "deadline": rpc.block["timestamp"] + 60}
    assert fill.action == "launch"
    assert fill.launched is not None and (fill.launched.token, fill.launched.curve) == (TOKEN, CURVE)


async def test_launch_without_salt_draws_a_random_one() -> None:
    rpc, agent = await setup()
    await agent.launch("Ok", "OK", metadata_uri="")
    salt = request_of(rpc)["salt"]
    assert len(salt) == 66 and salt != "0x" + "00" * 32


@pytest.mark.parametrize("bad", ["0x12", "0x" + "zz" * 32, "11" * 32, "0x" + "11" * 33, "", 5])
async def test_launch_refuses_a_malformed_salt(bad: object) -> None:
    rpc, agent = await setup()
    with pytest.raises(InvalidInputError, match="salt"):
        await agent.launch("Ok", "OK", metadata_uri="", salt=bad)  # type: ignore[arg-type]
    assert rpc.sent == []


async def test_launch_checks_before_signing_in_the_accounts_order() -> None:
    rpc, agent = await setup()
    with pytest.raises(InvalidInputError, match="1–32 bytes"):
        await agent.launch("é" * 17, "EX", metadata_uri="")
    with pytest.raises(InvalidInputError, match="1–10 bytes"):
        await agent.launch("Ok", "TOOLONGSYMB", metadata_uri="")
    with pytest.raises(InvalidInputError, match="longer than 256 bytes"):
        await agent.launch("Ok", "OK", metadata_uri="https://" + "x" * 250)
    # The account checks maxTradeUsdc (initial buy + fee) before the factory checks maxInitialBuyTokens.
    await refused(agent.launch("Ok", "OK", metadata_uri="", initial_buy_usdc="100"), "TradeTooLarge")
    await refused(agent.launch("Ok", "OK", metadata_uri="", initial_buy_usdc="10000"), "TradeTooLarge")
    roomy_rpc, roomy = await setup(account={"policy": BIG})
    await refused(roomy.launch("Ok", "OK", metadata_uri="", initial_buy_usdc="900"), "InitialBuyTooLarge")
    spent_rpc, spent = await setup(account={"headroom": (5_000_000, 500_000_000, 499, 3)})
    err = await refused(spent.launch("Ok", "OK", metadata_uri="", initial_buy_usdc="10"), "PeriodSpendExceeded")
    assert err.revert.args == [5_000_000]
    none_rpc, none = await setup(account={"headroom": (400_000_000, 500_000_000, 499, 0)})
    await refused(none.launch("Ok", "OK", metadata_uri=""), "LaunchLimit")
    assert rpc.sent == roomy_rpc.sent == spent_rpc.sent == none_rpc.sent == []


async def test_launch_trade_limit_is_checked_before_the_amount_ceiling() -> None:
    _, agent = await setup()
    await refused(agent.launch("Ok", "OK", metadata_uri="", initial_buy_usdc6=1 << 250), "TradeTooLarge")


async def test_launch_refused_without_permission_while_paused_or_launch_paused() -> None:
    _, no_perm = await setup(account={"agent_permissions": 1})
    await refused(no_perm.launch("Ok", "OK", metadata_uri=""), "MissingPermission")
    rpc, paused = await setup()
    rpc.read(FACTORY, AGENT_ACCOUNT_FACTORY, "isPaused", True)
    await refused(paused.launch("Ok", "OK", metadata_uri=""), "Paused")
    rpc2, launch_paused = await setup()
    rpc2.read(LAUNCH_FACTORY, LF, "paused", True)
    await refused(launch_paused.launch("Ok", "OK", metadata_uri=""), "EnforcedPause")


async def test_launch_reads_the_config_hash_on_the_pinned_block() -> None:
    rpc, agent = await setup()
    await agent.launch("Ok", "OK", metadata_uri="")
    pinned = hex(rpc.block["number"])
    reads = [c for c in rpc.methods("eth_call") if c[0]["to"].lower() == LAUNCH_FACTORY.lower()]
    assert len(reads) == 3 and all(c[1] == pinned for c in reads)


async def test_launch_uploads_through_api_or_refuses_chain_only() -> None:
    chain_only_rpc, chain_only = await setup()
    with pytest.raises(InvalidInputError, match="needs the Mercurifi API"):
        await chain_only.launch("Ok", "OK", description="hello")
    assert chain_only_rpc.sent == []
    api = FakeApi()
    rpc, agent = await setup(api=api)
    image = ImageUpload(b"\x01\x02\x03", "image/png")
    await agent.launch("Ok", "OK", description="hello", links={"x": "https://x.com/ok"}, image=image)
    assert api.calls == [({"description": "hello", "links": {"x": "https://x.com/ok"}}, image)]
    assert request_of(rpc)["metadataURI"] == "https://api.example/v1/metadata/abc"
    with pytest.raises(InvalidInputError, match="either metadata_uri or"):
        await agent.launch("Ok", "OK", description="hello", metadata_uri="ipfs://m")


async def test_launch_does_not_upload_when_a_check_would_refuse_it() -> None:
    api = FakeApi()
    _, agent = await setup(api=api)
    await refused(agent.launch("Ok", "OK", description="hello", initial_buy_usdc="100"), "TradeTooLarge")
    assert api.calls == []


async def test_launch_fill_needs_token_created_by_this_account_for_this_token() -> None:
    rpc, agent = await setup()
    action = rpc.receipt_logs[0]
    rpc.receipt_logs = [action, log(LF, LAUNCH_FACTORY, "TokenCreated", token=TOKEN, curve=CURVE, creator=A(0x55))]
    with pytest.raises(MercurifiError) as creator:
        await agent.launch("Ok", "OK", metadata_uri="")
    assert creator.value.code == "FILL_NOT_FOUND"
    rpc.receipt_logs = [action, log(LF, LAUNCH_FACTORY, "TokenCreated", token=A(0x56), curve=CURVE, creator=ACCOUNT)]
    with pytest.raises(MercurifiError) as other_token:
        await agent.launch("Ok", "OK", metadata_uri="")
    assert other_token.value.code == "FILL_NOT_FOUND"
    rpc.receipt_logs = [action]
    with pytest.raises(MercurifiError) as missing:
        await agent.launch("Ok", "OK", metadata_uri="")
    assert missing.value.code == "FILL_NOT_FOUND"


# ---------------------------------------------------------------- metadata URI rules

BAD = ["", "javascript:alert(1)", "data:text/plain;base64,AAAA", "http://insecure.example/m", "https://exa‮mple/m", "https://a b/m",
       "https://" + "x" * 249, "https://user:pass@example.com/m.json", "ipfs://tok@host/m", "https://" + "é" * 125]


@pytest.mark.parametrize("uri", [None, 5, *BAD])
async def test_an_uploaded_uri_is_untrusted(uri: Any) -> None:
    api = FakeApi(uri)
    rpc, agent = await setup(api=api)
    with pytest.raises(MercurifiError) as e:
        await agent.launch("Ok", "OK", description="hi")
    assert e.value.code == "API_BAD_RESPONSE"
    for secret in ("javascript", "alert", "insecure", "user:pass", "pass@", "tok@", "exa", "x" * 20, "é"):
        assert secret not in str(e.value)
    assert rpc.sent == []


async def test_uri_byte_limit_counts_bytes_not_characters() -> None:
    assert len(("https://" + "é" * 124).encode()) == 256
    assert len(("https://" + "é" * 125).encode()) == 258
    rpc, agent = await setup()
    await agent.launch("Ok", "OK", metadata_uri="https://" + "é" * 124)
    assert len(rpc.sent) == 1
    with pytest.raises(InvalidInputError, match="longer than 256 bytes"):
        await agent.launch("Ok", "OK", metadata_uri="https://" + "é" * 125)


@pytest.mark.parametrize("uri", [u for u in BAD[1:] if u != "https://" + "é" * 125])
async def test_bad_user_supplied_uris_are_invalid_input(uri: str) -> None:
    rpc, agent = await setup()
    with pytest.raises(InvalidInputError):
        await agent.launch("Ok", "OK", metadata_uri=uri)
    assert rpc.sent == []


async def test_good_uris_pass_at_the_limit() -> None:
    api = FakeApi("ipfs://" + "x" * 249)
    rpc, agent = await setup(api=api)
    await agent.launch("Ok", "OK", description="hi")
    assert len(rpc.sent) == 1
    rpc2, agent2 = await setup()
    await agent2.launch("Ok", "OK", metadata_uri="https://example.com/m.json")
    assert len(rpc2.sent) == 1
    assert metadata_uri_problem("https://example.com/m.json") is None


async def test_an_empty_user_supplied_uri_is_sent_but_warns() -> None:
    warnings: list[str] = []
    rpc, agent = await setup(warnings=warnings)
    await agent.launch("Ok", "OK", metadata_uri="")
    assert len(rpc.sent) == 1
    assert any("hidden from the Mercurifi board" in w for w in warnings)


async def test_a_key_expiring_before_the_transaction_lands_is_refused() -> None:
    _, soon = await setup(account={"agent_expires_at": 1_700_000_001})
    await refused(soon.launch("Ok", "OK", metadata_uri=""), "AgentExpired")
    rpc, fine = await setup(account={"agent_expires_at": 1_700_000_002})
    await fine.launch("Ok", "OK", metadata_uri="")
    assert len(rpc.sent) == 1


# ---------------------------------------------------------------- pool swaps


async def test_pool_buy_through_the_derived_launch_hook_pool() -> None:
    rpc, agent = await setup(action=4, phase=2)
    rpc.read(A(3), GRADUATION_MANAGER, "poolKey", KEY)
    seen: list[dict[str, Any]] = []

    def quote(a: list[Any]) -> tuple[int, int]:
        seen.append(a[0])
        return (5_000 * WAD if a[0]["exactAmount"] == 10_000_000 else 5 * WAD, 120_000)

    rpc.read(A(8), V4_QUOTER, "quoteExactInputSingle", quote)
    fill = await agent.swap_exact_in(TOKEN, "buy", usdc="10")
    assert (seen[0]["zeroForOne"], seen[0]["exactAmount"]) == (False, 10_000_000)
    assert args_of(rpc) == [TOKEN, True, 10_000_000, 4_900 * WAD, rpc.block["timestamp"] + 60]
    assert fill.action == "poolBuy"


async def test_refuses_foreign_pool_wrong_pair_and_token_on_its_curve() -> None:
    rpc, agent = await setup(phase=2)
    rpc.read(A(3), GRADUATION_MANAGER, "poolKey", {**KEY, "hooks": A(0x666)})
    with pytest.raises(MercurifiError, match="LaunchHook"):
        await agent.swap_exact_in(TOKEN, "buy", usdc="1")
    rpc.read(A(3), GRADUATION_MANAGER, "poolKey", {**KEY, "currency1": A(0x777)})
    with pytest.raises(MercurifiError) as e:
        await agent.swap_exact_in(TOKEN, "buy", usdc="1")
    assert e.value.code == "POOL_KEY_MISMATCH"
    trading_rpc, trading = await setup(phase=0)
    await refused(trading.swap_exact_in(TOKEN, "buy", usdc="1"), "NotGraduated")
    assert rpc.sent == trading_rpc.sent == []


async def test_paused_is_checked_before_the_graduation_phase() -> None:
    rpc, agent = await setup(phase=0)
    rpc.read(FACTORY, AGENT_ACCOUNT_FACTORY, "isPaused", True)
    await refused(agent.swap_exact_in(TOKEN, "buy", usdc="1"), "Paused")


async def test_allowlist_applies_to_buys_only() -> None:
    rpc, agent = await setup(action=4, phase=2, balance=5 * WAD, account={"policy": replace(DEFAULT_POLICY, allowlist_only=True)})
    quoter(rpc, lambda p: 1_000_000 if p["zeroForOne"] else 5 * WAD)
    await refused(agent.swap_exact_in(TOKEN, "buy", usdc="1"), "TokenNotAllowed")
    await agent.swap_exact_in(TOKEN, "sell", amount_wei=WAD)
    assert len(rpc.sent) == 1


async def test_pool_buy_above_limits_refused_locally() -> None:
    rpc, agent = await setup(action=4, phase=2)
    quoter(rpc, lambda p: 5_000 * WAD)
    await refused(agent.swap_exact_in(TOKEN, "buy", usdc="150"), "TradeTooLarge")
    low_rpc, low = await setup(action=4, phase=2, account={"headroom": (5_000_000, 500_000_000, 499, 3)})
    quoter(low_rpc, lambda p: 5_000 * WAD)
    err = await refused(low.swap_exact_in(TOKEN, "buy", usdc="10"), "PeriodSpendExceeded")
    assert err.revert.args == [5_000_000]
    assert rpc.sent == low_rpc.sent == []


async def test_amounts_must_be_positive_and_fit_uint128_and_fields_must_not_mix() -> None:
    rpc, agent = await setup(action=4, phase=2)
    quoter(rpc, lambda p: 5 * WAD)
    with pytest.raises(InvalidInputError, match="above zero"):
        await agent.swap_exact_in(TOKEN, "buy", usdc="0")
    await refused(agent.swap_exact_in(TOKEN, "buy", usdc6=1 << 128), "AmountTooLarge")
    with pytest.raises(InvalidInputError, match="holds none"):
        await agent.swap_exact_in(TOKEN, "sell", amount="all")
    with pytest.raises(InvalidInputError):
        await agent.swap_exact_in(TOKEN, "buy", usdc="1", amount="1")
    with pytest.raises(InvalidInputError):
        await agent.swap_exact_in(TOKEN, "sell", usdc="1", amount="1")
    with pytest.raises(InvalidInputError):
        await agent.swap_exact_in(TOKEN, "hold", usdc="1")  # type: ignore[arg-type]
    assert rpc.sent == []


async def test_pool_sell_valued_at_high_water_refused_before_it_even_quotes() -> None:
    # Recorded 2,000 tokens at the 0.1 USDC high-water = 200 USDC, above the 100 USDC per-trade limit (the 20 USDC average does not count).
    rpc, agent = await setup(action=5, account={"basis": CRASH_BASIS}, phase=2, balance=11_000 * WAD)
    rpc.read(A(3), GRADUATION_MANAGER, "poolKey", KEY)
    err = await refused(agent.swap_exact_in(TOKEN, "sell", amount_wei=2_000 * WAD), "TradeTooLarge")
    assert err.revert.args == [100_000_000]
    assert [c for c in rpc.methods("eth_call") if c[0]["to"].lower() == A(8).lower()] == []
    assert rpc.sent == []


async def test_pool_sell_adds_the_excess_share_of_the_proceeds_and_checks_sell_headroom() -> None:
    # 500 recorded tokens cost 50 USDC at the high-water; 300 excess tokens carry 300/800 of 120 USDC proceeds = 45 -> 95 total.
    basis = (50_000_000, 500 * WAD, 10**23)
    fits_rpc, fits = await setup(action=5, account={"basis": basis}, phase=2, balance=800 * WAD)
    quoter(fits_rpc, lambda p: 120_000_000)
    await fits.swap_exact_in(TOKEN, "sell", amount_wei=800 * WAD)
    assert args_of(fits_rpc) == [TOKEN, False, 800 * WAD, 117_600_000, fits_rpc.block["timestamp"] + 60]
    over_rpc, over = await setup(action=5, account={"basis": basis}, phase=2, balance=800 * WAD)
    quoter(over_rpc, lambda p: 200_000_000)  # 50 + 75 = 125 > 100
    await refused(over.swap_exact_in(TOKEN, "sell", amount_wei=800 * WAD), "TradeTooLarge")
    short_rpc, short = await setup(action=5, account={"basis": basis, "headroom": (400_000_000, 90_000_000, 499, 3)}, phase=2, balance=800 * WAD)
    quoter(short_rpc, lambda p: 120_000_000)
    err = await refused(short.swap_exact_in(TOKEN, "sell", amount_wei=800 * WAD), "PeriodSellExceeded")
    assert err.revert.args == [90_000_000]
    assert over_rpc.sent == short_rpc.sent == []


async def test_pool_sell_with_usdc6_minimum_never_zero() -> None:
    rpc, agent = await setup(action=5, account={"basis": CRASH_BASIS}, phase=2, balance=500 * WAD)
    quoter(rpc, lambda p: 50_000_000)
    await agent.swap_exact_in(TOKEN, "sell", amount_wei=500 * WAD)
    assert args_of(rpc) == [TOKEN, False, 500 * WAD, 49_000_000, rpc.block["timestamp"] + 60]
    dust_rpc, dust = await setup(action=5, phase=2, balance=5 * WAD)
    quoter(dust_rpc, lambda p: 1)
    await dust.swap_exact_in(TOKEN, "sell", amount_wei=5 * WAD)
    assert args_of(dust_rpc)[3] == 1
    none_rpc, none = await setup(action=5, phase=2, balance=5 * WAD)
    quoter(none_rpc, lambda p: 0)
    with pytest.raises(InvalidInputError, match="below 1 micro-USDC"):
        await none.swap_exact_in(TOKEN, "sell", amount_wei=5 * WAD)
    assert none_rpc.sent == []


async def test_pool_sell_all_uses_the_balance() -> None:
    rpc, agent = await setup(action=5, phase=2, balance=5 * WAD)
    quoter(rpc, lambda p: 10_000_000)
    await agent.swap_exact_in(TOKEN, "sell", amount="all")
    assert args_of(rpc)[2] == 5 * WAD


async def test_explicit_sell_above_the_balance_is_refused_with_a_plain_message() -> None:
    pool_rpc, pool = await setup(action=5, account={"basis": CRASH_BASIS}, phase=2, balance=WAD)
    pool_rpc.read(A(3), GRADUATION_MANAGER, "poolKey", KEY)
    with pytest.raises(InvalidInputError, match="holds less of this token"):
        await pool.swap_exact_in(TOKEN, "sell", amount_wei=2_000 * WAD)
    native_rpc, native = await setup(action=7)
    with pytest.raises(InvalidInputError, match="holds 1000 USDC, less than"):
        await native.sweep_to_owner(usdc="5000")
    token_rpc, token = await setup(action=7, balance=WAD)
    with pytest.raises(InvalidInputError, match="holds less of this token"):
        await token.sweep_to_owner(token=TOKEN, amount="2")
    assert pool_rpc.sent == native_rpc.sent == token_rpc.sent == []


async def test_a_high_pool_impact_warns_but_does_not_block_and_a_small_one_is_quiet() -> None:
    # Constant product with 1,000 USDC of reserve: a 100 USDC buy moves the price by about 21%.
    reserve = 1_000_000_000
    heavy_warnings: list[str] = []
    rpc, heavy = await setup(action=4, phase=2, warnings=heavy_warnings, account={"policy": replace(DEFAULT_POLICY, max_price_impact_bps=300)})
    quoter(rpc, lambda p: p["exactAmount"] * reserve * WAD // (reserve + p["exactAmount"]) // 1_000_000)
    await heavy.swap_exact_in(TOKEN, "buy", usdc="100")
    assert any("approximate" in w and "move the pool price by about 2" in w for w in heavy_warnings)
    assert len(rpc.sent) == 1
    light_warnings: list[str] = []
    light_rpc, light = await setup(action=4, phase=2, warnings=light_warnings)
    quoter(light_rpc, lambda p: p["exactAmount"] * (100 * reserve) * WAD // (100 * reserve + p["exactAmount"]) // 1_000_000)
    await light.swap_exact_in(TOKEN, "buy", usdc="10")
    assert light_warnings == []


async def test_estimate_of_a_falling_price_is_one_minus_inverse_k_squared() -> None:
    rpc, agent = await setup(phase=2)
    reserve = 1_000 * WAD
    rpc.read(A(8), V4_QUOTER, "quoteExactInputSingle", lambda a: (a[0]["exactAmount"] * reserve // (reserve + a[0]["exactAmount"]), 0))
    mf = agent._mf  # noqa: SLF001
    amount_in = 500 * WAD  # x = 0.5 of the reserve: the sqrt price moves by 1/1.5, the price by 1 - 1/2.25
    out = amount_in * reserve // (reserve + amount_in)
    down = await estimate_pool_impact_bps(mf.rpc, mf.network, KEY, True, amount_in, out, ACCOUNT)
    assert down is not None and 5_400 < down < 5_600
    up = await estimate_pool_impact_bps(mf.rpc, mf.network, KEY, False, amount_in, out, ACCOUNT)
    assert up is not None and up > 12_000
    assert await estimate_pool_impact_bps(mf.rpc, mf.network, KEY, True, 999, 5, ACCOUNT) is None


# ---------------------------------------------------------------- claims and sweeps


async def test_claim_fees_without_a_deadline() -> None:
    rpc, agent = await setup(action=6)
    fill = await agent.claim_fees()
    name, args, _ = sent_call(rpc, AGENT_ACCOUNT)
    assert (name, args) == ("claimFees", {})
    assert fill.action == "claim"


async def test_sweep_native_in_wei_or_all() -> None:
    rpc, agent = await setup(action=7)
    await agent.sweep_to_owner(usdc="2")
    assert args_of(rpc) == [ZERO, 2 * WAD]
    all_rpc, everything = await setup(action=7)
    await everything.sweep_to_owner(all=True)
    assert args_of(all_rpc) == [ZERO, 1_000 * WAD]
    string_rpc, by_string = await setup(action=7)
    await by_string.sweep_to_owner(amount="all")
    assert args_of(string_rpc) == [ZERO, 1_000 * WAD]
    with pytest.raises(InvalidInputError, match="cannot be combined"):
        await agent.sweep_to_owner(all=True, usdc="1")
    with pytest.raises(InvalidInputError, match="Nothing to sweep"):
        await agent.sweep_to_owner(usdc="0")
    with pytest.raises(InvalidInputError, match="native sweep is in USDC"):
        await agent.sweep_to_owner(amount="1")


async def test_sweep_only_registered_launch_tokens_all_or_an_amount() -> None:
    rpc, agent = await setup(action=7, balance=7 * WAD)
    await refused(agent.sweep_to_owner(token=A(0xDD), amount="1"), "TokenNotRegistered")
    await agent.sweep_to_owner(token=TOKEN, amount="all")
    assert args_of(rpc) == [TOKEN, 7 * WAD]
    some_rpc, some = await setup(action=7, balance=7 * WAD)
    await some.sweep_to_owner(token=TOKEN, amount="2.5")
    assert args_of(some_rpc) == [TOKEN, 25 * WAD // 10]
    all_rpc, everything = await setup(action=7, balance=7 * WAD)
    await everything.sweep_to_owner(token=TOKEN, all=True)
    assert args_of(all_rpc) == [TOKEN, 7 * WAD]
    _, empty = await setup(action=7, balance=0)
    with pytest.raises(InvalidInputError, match="Nothing to sweep"):
        await empty.sweep_to_owner(token=TOKEN, all=True)
    with pytest.raises(InvalidInputError):
        await agent.sweep_to_owner(token=TOKEN, usdc="1")


async def test_claim_and_sweep_go_through_the_gate() -> None:
    _, claim = await setup(action=6, account={"agent_permissions": 1})
    await refused(claim.claim_fees(), "MissingPermission")
    _, sweep = await setup(action=7, account={"agent_permissions": 1})
    await refused(sweep.sweep_to_owner(usdc="1"), "MissingPermission")
    rpc, paused = await setup(action=6)
    rpc.read(FACTORY, AGENT_ACCOUNT_FACTORY, "isPaused", True)
    await refused(paused.claim_fees(), "Paused")
    rpc2, paused_sweep = await setup(action=7)
    rpc2.read(FACTORY, AGENT_ACCOUNT_FACTORY, "isPaused", True)
    await refused(paused_sweep.sweep_to_owner(usdc="1"), "Paused")
