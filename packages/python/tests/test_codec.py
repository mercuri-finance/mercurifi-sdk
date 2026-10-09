from eth_utils import keccak, to_checksum_address

from mercurifi.abi import ALL, AGENT_ACCOUNT, AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY, LAUNCH_FACTORY
from mercurifi.policy import DEFAULT_POLICY

TOKEN = to_checksum_address("0x" + "00" * 19 + "bb")
ACCOUNT = to_checksum_address("0x" + "00" * 19 + "aa")
AGENT = to_checksum_address("0x" + "00" * 19 + "cc")


def test_all_follows_the_ts_sources_order() -> None:
    assert [c.name for c in ALL] == [
        "AgentAccount", "AgentPolicyRegistry", "AgentAccountFactory", "BondingCurve", "LaunchFactory", "FeeManager",
        "GraduationManager", "LaunchHook", "LaunchToken", "V4Quoter", "UniversalRouter",
    ]


def test_selector_is_keccak_of_canonical_signature() -> None:
    assert AGENT_ACCOUNT.selector("buy") == "0x" + keccak(text="buy(address,uint256,uint256,uint256)")[:4].hex()


def test_round_trips_registry_calls_with_structs() -> None:
    # Owner functions live on the registry and take the account first.
    data = AGENT_POLICY_REGISTRY.encode("setPolicy", ACCOUNT, DEFAULT_POLICY.to_abi())
    name, args = AGENT_POLICY_REGISTRY.decode_input(data)
    assert name == "setPolicy"
    assert args["account"] == ACCOUNT
    assert list(args.values())[1] == DEFAULT_POLICY.to_abi()
    try:
        AGENT_ACCOUNT.function("setPolicy")
    except KeyError:
        pass
    else:
        raise AssertionError("setPolicy must not be on the account")


def test_round_trips_account_calls() -> None:
    buy = AGENT_ACCOUNT.encode("buy", TOKEN, 25_000_000, 1, 2)
    assert AGENT_ACCOUNT.decode_input(buy) == ("buy", {"token": TOKEN, "usdcIn": 25_000_000, "minTokensOut": 1, "deadline": 2})


def test_round_trips_the_eight_field_launch_request() -> None:
    request = {
        "name": "Example", "symbol": "EX", "metadataURI": "ipfs://m", "salt": "0x" + "cd" * 32, "expectedConfigHash": "0x" + "92" * 32,
        "initialBuyUsdc": 10_000_000, "minTokensOut": 1_757_100_783_706_883_641_990_715, "deadline": 1_700_000_060,
    }
    name, args = AGENT_ACCOUNT.decode_input(AGENT_ACCOUNT.encode("launch", request))
    assert name == "launch"
    assert list(args.values()) == [request]
    assert list(request) == [c["name"] for c in AGENT_ACCOUNT.function("launch")["inputs"][0]["components"]]


def test_errors_and_results() -> None:
    data = AGENT_POLICY_REGISTRY.encode_error("PeriodSpendExceeded", 12_500_000)
    assert AGENT_POLICY_REGISTRY.decode_error(data) == ("PeriodSpendExceeded", [12_500_000])
    assert AGENT_ACCOUNT.decode_error(data) is None  # registry error: decoding merges ABIs
    assert AGENT_ACCOUNT.decode_error(AGENT_ACCOUNT.encode_error("TradeTooLarge", 100_000_000)) == ("TradeTooLarge", [100_000_000])
    assert AGENT_ACCOUNT.decode_error("0xdeadbeef") is None
    headroom = AGENT_POLICY_REGISTRY.encode_result("headroom", (1, 2, 3, 4))
    assert AGENT_POLICY_REGISTRY.decode_output("headroom", headroom) == (1, 2, 3, 4)
    assert AGENT_POLICY_REGISTRY.decode_input(AGENT_POLICY_REGISTRY.encode("headroom", ACCOUNT)) == ("headroom", {"account": ACCOUNT})
    queued = AGENT_POLICY_REGISTRY.encode_result("queued", (1, 1_700_003_600, 1, 5, "0x1234"))
    assert AGENT_POLICY_REGISTRY.decode_output("queued", queued) == (1, 1_700_003_600, 1, 5, "0x1234")
    basis = AGENT_ACCOUNT.encode_result("basis", (25_000_000, 10**24, 10**23))
    assert AGENT_ACCOUNT.decode_output("basis", basis) == (25_000_000, 10**24, 10**23)


def test_logs_round_trip_indexed_and_plain_arguments() -> None:
    topics, data = AGENT_ACCOUNT.encode_log("AgentAction", {"agent": TOKEN, "action": 1, "token": TOKEN, "usdcSpent": 5, "tokenDelta": -7, "periodId": 9})
    name, args = AGENT_ACCOUNT.decode_log(topics, data)  # type: ignore[misc]
    assert name == "AgentAction"
    assert (args["agent"], args["token"], args["usdcSpent"], args["tokenDelta"], args["periodId"]) == (TOKEN, TOKEN, 5, -7, 9)
    assert AGENT_ACCOUNT_FACTORY.decode_log(topics, data) is None
    assert LAUNCH_FACTORY.function("createToken")["name"] == "createToken"


def test_registry_queue_events_carry_the_account_as_topic_one() -> None:
    topics, data = AGENT_POLICY_REGISTRY.encode_log(
        "AgentQueued", {"account": ACCOUNT, "id": 4, "agent": AGENT, "expiresAt": 1_800_000_000, "permissions": 29, "eta": 1_700_003_600}
    )
    assert len(topics) == 4  # topic0 + account + id + agent
    assert topics[1] == "0x" + "00" * 12 + ACCOUNT[2:].lower()
    name, args = AGENT_POLICY_REGISTRY.decode_log(topics, data)  # type: ignore[misc]
    assert name == "AgentQueued"
    assert (args["account"], args["id"], args["agent"], args["permissions"], args["eta"]) == (ACCOUNT, 4, AGENT, 29, 1_700_003_600)
    assert AGENT_ACCOUNT.decode_log(topics, data) is None
