from collections.abc import Iterator, Mapping
from typing import Any

import pytest

from mercurifi.abi import AGENT_ACCOUNT, AGENT_POLICY_REGISTRY
from mercurifi.build_verify import verify_built_tx
from mercurifi.errors import BuildMismatchError, InvalidInputError
from mercurifi.policy import DEFAULT_POLICY

from .helpers import ACCOUNT, TOKEN, WAD, A

EXP: dict[str, Any] = {"chain_id": 5042002, "account": ACCOUNT, "function_name": "buy", "exact": {"token": TOKEN, "usdcIn": 25_000_000},
                       "at_least": {"minTokensOut": 980 * WAD}, "deadline": (900, 1_100)}
LAUNCH_EXACT = {"name": "Robo", "symbol": "ROBO", "metadataURI": "https://x.example/m/ab.json", "salt": "0x" + "11" * 32,
                "expectedConfigHash": "0x" + "22" * 32, "initialBuyUsdc": 0, "minTokensOut": 0}
LAUNCH_EXP: dict[str, Any] = {"chain_id": 5042002, "account": ACCOUNT, "function_name": "launch", "exact": LAUNCH_EXACT, "deadline": (900, 1_100)}


def buy(min_out: int = 980 * WAD, deadline: int = 1_000, token: str = TOKEN) -> str:
    return AGENT_ACCOUNT.encode("buy", token, 25_000_000, min_out, deadline)


def launch(deadline: int, **over: Any) -> str:
    return AGENT_ACCOUNT.encode("launch", {
        "name": "Robo", "symbol": "ROBO", "metadataURI": "https://x.example/m/ab.json", "salt": "0x" + "11" * 32,
        "expectedConfigHash": "0x" + "22" * 32, "initialBuyUsdc": 0, "minTokensOut": 0, "deadline": deadline, **over,
    })


def built(data: str | None = None, **over: object) -> dict[str, object]:
    return {"chainId": 5042002, "to": ACCOUNT, "data": buy() if data is None else data, "value": "0", **over}


def verify(b: dict[str, object], **over: Any) -> tuple[str, dict[str, Any]]:
    return verify_built_tx(b, **{**EXP, **over})


def test_accepts_matching_with_or_without_the_server_selector() -> None:
    assert verify(built())[1]["usdcIn"] == 25_000_000
    assert verify(built(selector=buy()[:10]))[0] == "buy"


def test_flattens_the_launch_request_and_checks_its_deadline() -> None:
    _, args = verify_built_tx(built(launch(1_000)), **LAUNCH_EXP)
    assert (args["name"], args["symbol"], args["deadline"]) == ("Robo", "ROBO", 1_000)
    with pytest.raises(BuildMismatchError, match="deadline"):
        verify_built_tx(built(launch(5_000)), **LAUNCH_EXP)


@pytest.mark.parametrize(("bad", "pattern"), [
    (built(to=A(0xCC)), "target"), (built(chainId=5042), "chain"), (built(chainId=True), "chain"), (built(value="1"), "value"), (built(value=0), "value"),
    (built(value="-1"), "value"), (built(selector="0xdeadbeef"), "selector"), (built(selector=None), "selector"),
    (built(buy(979 * WAD)), "minTokensOut"), (built(buy(980 * WAD, 5_000)), "deadline"),
    (built(buy() + "deadbeef"), "trailing"),
    (built(AGENT_ACCOUNT.encode("withdraw", TOKEN, 1)), "not an agent trade function"),
    (built(AGENT_POLICY_REGISTRY.encode("setPolicy", ACCOUNT, DEFAULT_POLICY.to_abi())), "does not decode against AgentAccount"),
    (built("0x12"), "not hex"), (built("nothex"), "not hex"), ({**built(), "data": 5}, "not a string"), (built(buy()[:-2]), "trailing"),
])
def test_refuses(bad: dict[str, object], pattern: str) -> None:
    with pytest.raises(BuildMismatchError, match=pattern):
        verify(bad)


def test_refuses_a_non_mapping_built_transaction() -> None:
    with pytest.raises(BuildMismatchError):
        verify_built_tx(["not", "a", "mapping"], **EXP)  # type: ignore[arg-type]


def test_refuses_a_deadline_on_a_function_that_takes_none() -> None:
    claim = AGENT_ACCOUNT.encode("claimFees")
    with pytest.raises(BuildMismatchError, match="no deadline"):
        verify_built_tx(built(claim), chain_id=5042002, account=ACCOUNT, function_name="claimFees", deadline=(1, 2))
    assert verify_built_tx(built(claim), chain_id=5042002, account=ACCOUNT, function_name="claimFees")[0] == "claimFees"


def test_compares_addresses_case_insensitively_and_refuses_names_the_function_lacks() -> None:
    mixed = "0x00000000000000000000000000000000000000Bb"
    assert verify(built(to="0x00000000000000000000000000000000000000AA"), exact={"token": mixed, "usdcIn": 25_000_000})[0] == "buy"
    with pytest.raises(BuildMismatchError, match="no argument nope"):
        verify(built(), exact={**EXP["exact"], "nope": 1})
    with pytest.raises(BuildMismatchError, match="no numeric argument"):
        verify(built(), at_least={"minTokensOut": 1, "minNopeOut": 1})
    with pytest.raises(BuildMismatchError, match="built buy, asked for sell"):
        verify(built(), function_name="sell")
    for name in ("withdraw", "toString", "constructor", "", 5):
        with pytest.raises(InvalidInputError, match="not an agent trade function"):
            verify(built(), function_name=name)


def test_pins_the_launch_config_hash_and_compares_bytes32_case_insensitively() -> None:
    assert verify_built_tx(built(launch(1_000)), **LAUNCH_EXP)[0] == "launch"
    with pytest.raises(BuildMismatchError, match="expectedConfigHash"):
        verify_built_tx(built(launch(1_000)), **{**LAUNCH_EXP, "exact": {**LAUNCH_EXACT, "expectedConfigHash": "0x" + "33" * 32}})
    upper = {**LAUNCH_EXACT, "expectedConfigHash": "0x" + "22" * 32, "salt": "0x" + "11" * 32}
    assert verify_built_tx(built(launch(1_000)), **{**LAUNCH_EXP, "exact": {**upper, "expectedConfigHash": "0x" + "22".upper() * 32}})[0] == "launch"


def test_fails_closed_every_argument_must_be_covered_by_name() -> None:
    bare = {k: v for k, v in EXP.items() if k not in ("exact", "at_least")}
    cases: list[dict[str, Any]] = [
        dict(bare), {**bare, "deadline": EXP["deadline"]},
        {**EXP, "exact": {"usdcIn": 25_000_000}},  # token uncovered
        {**EXP, "at_least": None},  # minTokensOut uncovered
        {**EXP, "deadline": None},  # deadline uncovered
        {**EXP, "exact": None},
    ]
    for e in cases:
        with pytest.raises(BuildMismatchError, match="not covered by your expectation"):
            verify_built_tx(built(), **e)
    with pytest.raises(BuildMismatchError, match="token of buy"):
        verify_built_tx(built(), **bare)
    assert verify(built())[0] == "buy"


def test_a_bare_buy_with_no_expectation_at_all_is_refused() -> None:
    with pytest.raises(BuildMismatchError, match="not covered"):
        verify_built_tx(built(), chain_id=5042002, account=ACCOUNT, function_name="buy")


def test_refuses_hostile_buys() -> None:
    with pytest.raises(BuildMismatchError, match="token is"):
        verify(built(buy(token=A(0xCC))))
    with pytest.raises(BuildMismatchError, match="minTokensOut"):
        verify(built(buy(1)))
    with pytest.raises(BuildMismatchError, match="deadline"):
        verify(built(buy(980 * WAD, 1_101)))
    with pytest.raises(BuildMismatchError, match="deadline"):
        verify(built(buy(980 * WAD, 899)))


def test_covers_swap_exact_in_flipped_buy_token_and_sweep_to_owner() -> None:
    def swap(buy_token: bool) -> str:
        return AGENT_ACCOUNT.encode("swapExactIn", TOKEN, buy_token, 5, 4, 1_000)
    e: dict[str, Any] = {"chain_id": 5042002, "account": ACCOUNT, "function_name": "swapExactIn", "exact": {"token": TOKEN, "buyToken": True, "amountIn": 5},
                         "at_least": {"minAmountOut": 4}, "deadline": EXP["deadline"]}
    assert verify_built_tx(built(swap(True)), **e)[0] == "swapExactIn"
    with pytest.raises(BuildMismatchError, match="buyToken"):
        verify_built_tx(built(swap(False)), **e)
    # a bool is never an int expectation, nor an int a bool one
    with pytest.raises(InvalidInputError):
        verify_built_tx(built(swap(True)), **{**e, "exact": {**e["exact"], "amountIn": True}})
    with pytest.raises(BuildMismatchError):
        verify_built_tx(built(swap(True)), **{**e, "exact": {**e["exact"], "buyToken": 1}})
    sweep = AGENT_ACCOUNT.encode("sweepToOwner", TOKEN, 7)
    w: dict[str, Any] = {"chain_id": 5042002, "account": ACCOUNT, "function_name": "sweepToOwner", "exact": {"token": TOKEN, "amount": 7}}
    assert verify_built_tx(built(sweep), **w)[0] == "sweepToOwner"
    with pytest.raises(BuildMismatchError, match="amount of sweepToOwner"):
        verify_built_tx(built(sweep), **{**w, "exact": {"token": TOKEN}})
    with pytest.raises(BuildMismatchError, match="amount"):
        verify_built_tx(built(sweep), **{**w, "exact": {"token": TOKEN, "amount": 8}})


def test_requires_all_eight_launch_fields() -> None:
    for k in LAUNCH_EXACT:
        rest = {key: v for key, v in LAUNCH_EXACT.items() if key != k}
        with pytest.raises(BuildMismatchError, match=f"{k} of launch is not covered"):
            verify_built_tx(built(launch(1_000)), **{**LAUNCH_EXP, "exact": rest})
    with pytest.raises(BuildMismatchError, match="deadline of launch is not covered"):
        verify_built_tx(built(launch(1_000)), **{**LAUNCH_EXP, "deadline": None})
    for k, v in (("metadataURI", "https://evil.example/x"), ("salt", "0x" + "99" * 32), ("initialBuyUsdc", 5), ("minTokensOut", 1),
                 ("expectedConfigHash", "0x" + "44" * 32)):
        with pytest.raises(BuildMismatchError, match=k):
            verify_built_tx(built(launch(1_000)), **{**LAUNCH_EXP, "exact": {**LAUNCH_EXACT, k: v}})
    with pytest.raises(BuildMismatchError, match="metadataURI"):
        verify_built_tx(built(launch(1_000, metadataURI="https://evil.example/x")), **LAUNCH_EXP)


def test_validates_its_own_inputs() -> None:
    with pytest.raises(InvalidInputError):
        verify(built(), at_least={"usdcIn": 1})
    with pytest.raises(InvalidInputError):
        verify(built(), at_least={"toString": 1})
    for window in ((5, 1), (1,), (True, 5), ("1", 5), 5, (1.0, 2.0), (1, 2, 3)):
        with pytest.raises(InvalidInputError):
            verify(built(), deadline=window)
    with pytest.raises(InvalidInputError):
        verify(built(), exact=[("token", TOKEN)])
    with pytest.raises(InvalidInputError):
        verify(built(), account="nope")


@pytest.mark.parametrize("bad", [None, "", "abc", "5", -1, True, False, 1.5, [], 2**8 * 0.5])
def test_rejects_a_non_int_or_negative_at_least_value(bad: object) -> None:
    with pytest.raises(InvalidInputError):
        verify(built(), at_least={"minTokensOut": bad})


@pytest.mark.parametrize("bad", ["", " 25000000", "25000000 ", "-1", "0x10", "abc", "٢٥", "1" * 79, False, [], None, 25_000_000.0, 1.5])
def test_rejects_a_bad_numeric_exact_value(bad: object) -> None:
    with pytest.raises(InvalidInputError):
        verify(built(), exact={"token": TOKEN, "usdcIn": bad})


def test_numeric_exact_accepts_ints_and_decimal_strings() -> None:
    assert verify(built(), exact={"token": TOKEN, "usdcIn": "25000000"})[0] == "buy"
    with pytest.raises(BuildMismatchError):
        verify(built(), exact={"token": TOKEN, "usdcIn": "25000001"})


def test_reads_each_expectation_value_once() -> None:
    class Liar(Mapping[str, Any]):
        def __init__(self) -> None:
            self.reads = 0

        def __getitem__(self, key: str) -> Any:
            self.reads += 1
            return 25_000_000 if self.reads == 1 else 1

        def __iter__(self) -> Iterator[str]:
            return iter(["usdcIn"])

        def __len__(self) -> int:
            return 1
    liar = Liar()
    # a one-shot lying mapping is read once during the copy: validation and comparison see the same value
    assert verify_built_tx(built(), **{**EXP, "exact": _Merged(liar)})[0] == "buy"
    assert liar.reads == 1


class _Merged(Mapping[str, Any]):
    def __init__(self, inner: Mapping[str, Any]) -> None:
        self.inner = inner

    def __getitem__(self, key: str) -> Any:
        return TOKEN if key == "token" else self.inner[key]

    def __iter__(self) -> Iterator[str]:
        return iter(["token", "usdcIn"])

    def __len__(self) -> int:
        return 2


def test_error_text_sanitises_attacker_values() -> None:
    evil = "https://evil.example/p?token=1" + "x" * 500
    with pytest.raises(BuildMismatchError) as e:
        verify_built_tx(built(launch(1_000, metadataURI=evil)), **LAUNCH_EXP)
    assert "token=1" not in str(e.value) and len(str(e.value)) < 400


def test_str_subclasses_in_the_built_tx_are_refused() -> None:
    class Sneaky(str):
        def __str__(self) -> str:
            return CLAIM_OTHER

        def lower(self) -> str:
            return ACCOUNT.lower()

    for field in ("to", "data", "value", "selector"):
        base = built()
        base[field] = Sneaky(str(base.get(field, "0")))
        with pytest.raises(BuildMismatchError, match="not a string"):
            verify(base)
    with pytest.raises(BuildMismatchError, match="chainId is a bool"):
        verify(built(chainId=True))
    with pytest.raises(BuildMismatchError, match="chainId is a str"):
        verify(built(chainId="5042002"))


CLAIM_OTHER = AGENT_ACCOUNT.encode("claimFees")


def test_int_subclasses_in_the_expectation_are_refused() -> None:
    class Liar(int):
        def __eq__(self, other: object) -> bool:
            return True

        def __lt__(self, other: object) -> bool:
            return False

        __gt__ = __lt__
        __hash__ = int.__hash__

    with pytest.raises(InvalidInputError):
        verify(built(), exact={"token": TOKEN, "usdcIn": Liar(1)})
    with pytest.raises(InvalidInputError):
        verify(built(), at_least={"minTokensOut": Liar(0)})
    with pytest.raises(InvalidInputError):
        verify(built(), deadline=(Liar(0), Liar(10**12)))
