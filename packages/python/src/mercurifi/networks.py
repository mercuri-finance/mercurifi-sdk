from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import httpx

from .errors import InvalidInputError, NetworkMismatchError


@dataclass(frozen=True)
class LaunchBook:
    factory: str
    fee_manager: str
    graduation_manager: str
    launch_hook: str
    pool_manager: str
    permit2: str
    universal_router: str
    v4_quoter: str
    usdc: str


@dataclass(frozen=True)
class AgentBook:
    """One Agent Accounts deployment: the factory, the account implementation its clones run, and the singleton
    AgentPolicyRegistry the factory deployed in its constructor (owner functions, configuration and usage live there)."""

    factory: str
    implementation: str
    registry: str
    factory_code_hash: str
    implementation_code_hash: str
    registry_code_hash: str
    deploy_block: int


@dataclass(frozen=True)
class NetworkBook:
    name: str
    chain_id: int
    default_rpc_url: str | None
    api_base_url: str | None
    api_key_prefix: str | None
    launch: LaunchBook
    agents: AgentBook | None  # None until an owner-approved deployment is recorded


_SHARED = {
    "pool_manager": "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "universal_router": "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    "v4_quoter": "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    "usdc": "0x3600000000000000000000000000000000000000",
}

MAINNET = NetworkBook(
    "mainnet", 5042, None, "https://launch-api.mercuri.finance", "mfk_live_",
    LaunchBook(factory="0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB", fee_manager="0x31D1bfe59B783f4c077F853f962D1355AfB52580",
               graduation_manager="0x5E82a03a30a1627Cb0Fa860dBe708e262e5124e4", launch_hook="0xe6D50A6e12f3883605A4456dCDEe50EE05fAE0Cc", **_SHARED),
    None,
)
TESTNET = NetworkBook(
    "testnet", 5042002, "https://rpc.testnet.arc.io", "https://testnet-launch-api.mercuri.finance", "mfk_test_",
    LaunchBook(factory="0x08D8CDDA59b5ce9216F7eD9B34E1F0391C80cC0E", fee_manager="0xcE1260DF73dEEbD71A869CC4E9A2006994f3E5E2",
               graduation_manager="0x3A17cD90e34EBae71D92013f763FD01bAef1efdc", launch_hook="0x87e6BaBAc4598F99f4A0717ad294934455Fe60cc", **_SHARED),
    # From deployments/5042002.json in the agent contracts repository (github.com/mercuri-finance/mercuri-agent-contracts); deploy_block is the factory's.
    AgentBook(
        factory="0x6D56A15c25782FF638943A4E81A1eD1ea862C9Bd", implementation="0xD11567fDfc9833E39E7EEbB0964c7bB7f4FF40b5", registry="0xcfCDA6a022314eA7Ae995cCf88e4eeB3A8802C69",
        factory_code_hash="0xe46101aa4d40c13670b4a3cc796e842f66a78b20270151a9ad8a71993a743674",
        implementation_code_hash="0xc17ea4822c95a725023978abfbeb6a5e0083cce436a8bcd8530f83af6c10fa6f",
        registry_code_hash="0x6e690cd8038c639bfefa2a0f7db40242a6d99610ddd5d517d5fcb3ff22cdde22",
        deploy_block=66495930,
    ),
)
NETWORKS: Mapping[str, NetworkBook] = MappingProxyType({"mainnet": MAINNET, "testnet": TESTNET})
LOCAL_CHAIN_ID = 31337


_LOCAL_KEYS = (
    "chainId", "launchFactory", "feeManager", "graduationManager", "launchHook", "poolManager", "permit2", "universalRouter",
    "v4Quoter", "usdc", "agentFactory", "agentImplementation", "agentRegistry", "agentFactoryCodeHash",
    "agentImplementationCodeHash", "agentRegistryCodeHash", "deployBlock",
)


def local_network(book: Mapping[str, Any]) -> NetworkBook:
    """A book for the loopback Anvil deployment written by scripts/local-chain.sh. Only chain 31337 is accepted."""
    missing = [k for k in _LOCAL_KEYS if k not in book]
    if missing:
        raise InvalidInputError("book", f"the local address book is missing: {', '.join(missing)}")
    chain_id = book["chainId"]
    if isinstance(chain_id, bool) or not isinstance(chain_id, int) or chain_id != LOCAL_CHAIN_ID:
        raise NetworkMismatchError(f"a local address book must be for chain {LOCAL_CHAIN_ID} (Anvil), not {chain_id}")
    deploy_block = book["deployBlock"]
    if isinstance(deploy_block, bool) or not isinstance(deploy_block, int) or deploy_block < 0:
        raise InvalidInputError("book", "deployBlock must be a non-negative integer")
    return NetworkBook(
        "local", LOCAL_CHAIN_ID, "http://127.0.0.1:8545", None, None,
        LaunchBook(book["launchFactory"], book["feeManager"], book["graduationManager"], book["launchHook"], book["poolManager"],
                   book["permit2"], book["universalRouter"], book["v4Quoter"], book["usdc"]),
        AgentBook(
            factory=book["agentFactory"], implementation=book["agentImplementation"], registry=book["agentRegistry"],
            factory_code_hash=book["agentFactoryCodeHash"], implementation_code_hash=book["agentImplementationCodeHash"],
            registry_code_hash=book["agentRegistryCodeHash"], deploy_block=deploy_block,
        ),
    )


def _has_unsafe_chars(url: str) -> bool:
    """Backslashes and control characters make parsers disagree on the host ("http://evil.com\\@127.0.0.1")."""
    return "\\" in url or any(ord(c) < 0x21 or 0x7F <= ord(c) <= 0x9F for c in url)


def url_host(url: object) -> str | None:
    """The host as httpx will connect to it, or None for anything malformed or ambiguous."""
    if not isinstance(url, str) or _has_unsafe_chars(url):
        return None
    try:
        parsed = httpx.URL(url)
        if parsed.scheme not in ("http", "https") or (parsed.port is not None and not 0 < parsed.port <= 65535):
            return None
        return parsed.host or None
    except (httpx.InvalidURL, ValueError):
        return None


def is_loopback_url(url: str) -> bool:
    return url_host(url) in ("127.0.0.1", "localhost", "::1")
