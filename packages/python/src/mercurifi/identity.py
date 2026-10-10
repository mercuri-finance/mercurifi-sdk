"""Optional ERC-8004 identity helpers: a registration file that links an agent account, calldata for the caller's own
wallet to register it, and reads of the IdentityRegistry. Nothing here signs or sends.

Who signs: an EOA, normally the owner wallet. An agent account cannot register itself (it only calls allowlisted
Mercurifi targets), and it cannot prove control by signature (`isValidSignature` always fails), so it can never be the
registry's verified `agentWallet`. The account is linked only through the registration file.

Same behaviour as TypeScript's identity.ts; the shared vectors in fixtures/vectors/identity.json decide.
"""

from __future__ import annotations

import base64
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal

from eth_utils.address import to_checksum_address

from .agent import metadata_uri_problem
from .codec import AbiDecodeError, Contract
from .errors import InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError
from .networks import NETWORKS
from .redact import rpc_error
from .rpc import Rpc, RpcError

IdentityNetwork = Literal["testnet", "mainnet"]


@dataclass(frozen=True)
class Erc8004Book:
    """The ERC-8004 registries on one Arc network (all three are upgradeable proxies)."""

    chain_id: int
    identity_registry: str
    reputation_registry: str
    validation_registry: str


# Checked with eth_getCode on each network. Mainnet is listed but refused until Agent Accounts are recorded there.
ERC8004_REGISTRIES: Mapping[str, Erc8004Book] = MappingProxyType(
    {
        "testnet": Erc8004Book(
            5042002,
            "0x8004A818BFB912233c491871b3d84c89A494BD9e",
            "0x8004B663056A597Dffe9eCcC1965A193B7388713",
            "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
        ),
        "mainnet": Erc8004Book(
            5042,
            "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
            "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
            "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
        ),
    }
)

REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
"""The registration-file `type` of the ERC-8004 version deployed on Arc (IdentityRegistry `getVersion()` 2.0.0)."""
AGENT_ACCOUNT_SERVICE = "MercurifiAgentAccount"
"""The service entry that links the agent account, as `eip155:<chainId>:<account>`. Callers cannot add another."""
TRUST_MODELS = ("reputation", "crypto-economic", "tee-attestation")
_DATA_PREFIX = "data:application/json;base64,"
_MAX_DATA_URI_BYTES = 16_384
_MAX_SERVICES = 16
_MAX_SAFE_INTEGER = 2**53 - 1
_MAX_UINT256 = 2**256 - 1
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_CANONICAL_BASE64 = re.compile(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")

# The IdentityRegistry functions and events this module uses, written by hand from the ERC-8004 text and checked
# against the deployed implementation's bytecode (every selector and event topic is present).
IDENTITY_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "register",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "agentURI", "type": "string"}],
        "outputs": [{"name": "agentId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "setAgentURI",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "newURI", "type": "string"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "ownerOf",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "tokenURI",
        "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "string"}],
    },
    {
        "type": "function",
        "name": "getAgentWallet",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "event",
        "name": "Registered",
        "anonymous": False,
        "inputs": [
            {"name": "agentId", "type": "uint256", "indexed": True},
            {"name": "agentURI", "type": "string", "indexed": False},
            {"name": "owner", "type": "address", "indexed": True},
        ],
    },
    {
        "type": "event",
        "name": "Transfer",
        "anonymous": False,
        "inputs": [
            {"name": "from", "type": "address", "indexed": True},
            {"name": "to", "type": "address", "indexed": True},
            {"name": "tokenId", "type": "uint256", "indexed": True},
        ],
    },
]
IDENTITY_REGISTRY = Contract(IDENTITY_REGISTRY_ABI, "IdentityRegistry")
_ZERO = "0x" + "00" * 20


def erc8004_registries(network: str) -> Erc8004Book:
    """The registry for a network. Like every other agent feature, a network without a recorded Agent Accounts deployment
    in this SDK (mainnet today) is refused with `NotDeployedError`."""
    if network not in ("testnet", "mainnet"):
        raise InvalidInputError(
            "network",
            'ERC-8004 helpers support network "testnet" (and "mainnet" once Agent Accounts are deployed there).',
        )
    if NETWORKS[network].agents is None:
        raise NotDeployedError(network)
    return ERC8004_REGISTRIES[network]


def _utf8_len(value: str) -> int:
    return len(value.encode("utf-8"))


def _has_control(value: str, allow_newline: bool = False) -> bool:
    """Control, format and lone-surrogate characters; `allow_newline` keeps "\\n" (descriptions)."""
    return any(
        unicodedata.category(c) in ("Cc", "Cf", "Cs")
        for c in (value.replace("\n", "") if allow_newline else value)
    )


def _text(
    field: str,
    value: object,
    max_bytes: int,
    *,
    min_bytes: int = 0,
    allow_newline: bool = False,
    no_space: bool = False,
) -> str:
    size = (
        f"{field} must be {min_bytes}-{max_bytes} bytes (UTF-8)"
        if min_bytes > 0
        else f"{field} must be a string of at most {max_bytes} bytes (UTF-8)"
    )
    if not isinstance(value, str):
        raise InvalidInputError(field, size)
    # Characters first, then length: a lone surrogate is reported as a control character, as in TypeScript.
    if _has_control(value, allow_newline):
        raise InvalidInputError(field, f"{field} contains control or format characters")
    if no_space and any(c.isspace() for c in value):
        raise InvalidInputError(field, f"{field} contains whitespace")
    if not min_bytes <= _utf8_len(value) <= max_bytes:
        raise InvalidInputError(field, size)
    return value


def _account(value: object) -> str:
    if not isinstance(value, str) or _ADDRESS.fullmatch(value) is None:
        raise InvalidInputError("account", "account must be a 20-byte hex address")
    if int(value, 16) == 0:
        raise InvalidInputError("account", "account cannot be the zero address")
    return to_checksum_address(value)


def _agent_id(value: object, max_value: int = _MAX_UINT256) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= max_value:
        raise InvalidInputError("agent_id", f"agentId must be an int in 0..{max_value}")
    return int(value)


def _services(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise InvalidInputError("services", "services must be a list of {name, endpoint, version?}")
    if len(value) > _MAX_SERVICES:
        raise InvalidInputError("services", f"services can hold at most {_MAX_SERVICES} entries")
    out: list[dict[str, str]] = []
    for i, s in enumerate(value):
        if not isinstance(s, Mapping):
            raise InvalidInputError(
                "services", f"services[{i}] must be {{name, endpoint, version?}}"
            )
        for key in s:
            if key not in ("name", "endpoint", "version"):
                raise InvalidInputError("services", f"services[{i}] has an unknown field {key}")
        name = _text("services", s.get("name"), 64, min_bytes=1, no_space=True)
        if name.lower() == AGENT_ACCOUNT_SERVICE.lower():
            raise InvalidInputError(
                "services",
                f"services[{i}]: the name {AGENT_ACCOUNT_SERVICE} is reserved for the account entry",
            )
        entry = {
            "name": name,
            "endpoint": _text("services", s.get("endpoint"), 512, min_bytes=1, no_space=True),
        }
        if s.get("version") is not None:
            entry["version"] = _text("services", s["version"], 32, min_bytes=1, no_space=True)
        out.append(entry)
    return out


def build_registration_file(
    network: str,
    account: str,
    name: str,
    *,
    description: str | None = None,
    image: str | None = None,
    services: Sequence[Mapping[str, str]] | None = None,
    agent_id: int | None = None,
    x402_support: bool = False,
    active: bool = True,
    supported_trust: Sequence[str] | None = None,
) -> dict[str, Any]:
    """The ERC-8004 registration file for an agent account (pure; no network access). Keys are in a fixed order so
    `registration_file_json` gives the same bytes as TypeScript. The account appears as the `MercurifiAgentAccount`
    service with endpoint `eip155:<chainId>:<account>`; it is never the registry's `agentWallet`.

    `services` are extra endpoints (A2A, MCP, web, ENS, DID…) after the account entry. `agent_id`, known after
    registering, adds the `registrations` entry the standard asks for; set it with a second `setAgentURI`."""
    book = erc8004_registries(network)
    acct = _account(account)
    checked_name = _text("name", name, 64, min_bytes=1)
    desc = (
        "" if description is None else _text("description", description, 2000, allow_newline=True)
    )
    if image is not None:
        problem = metadata_uri_problem(image)
        if problem is not None:
            raise InvalidInputError("image", f"image cannot be used: {problem}")
    extra = _services(services)
    if not isinstance(x402_support, bool):
        raise InvalidInputError("x402_support", "x402Support must be a boolean")
    if not isinstance(active, bool):
        raise InvalidInputError("active", "active must be a boolean")
    trust: list[str] = []
    if supported_trust is not None:
        if (
            isinstance(supported_trust, (str, bytes))
            or not isinstance(supported_trust, Sequence)
            or any(t not in TRUST_MODELS for t in supported_trust)
        ):
            raise InvalidInputError(
                "supported_trust", f"supportedTrust entries must be {', '.join(TRUST_MODELS)}"
            )
        trust = list(dict.fromkeys(supported_trust))
    # A JSON number: ids above 2^53 - 1 would lose precision in readers.
    aid = None if agent_id is None else _agent_id(agent_id, _MAX_SAFE_INTEGER)
    file: dict[str, Any] = {"type": REGISTRATION_TYPE, "name": checked_name, "description": desc}
    if image is not None:
        file["image"] = image
    file["services"] = [
        {"name": AGENT_ACCOUNT_SERVICE, "endpoint": f"eip155:{book.chain_id}:{acct}"},
        *extra,
    ]
    file["x402Support"] = x402_support
    file["active"] = active
    file["registrations"] = (
        []
        if aid is None
        else [{"agentId": aid, "agentRegistry": f"eip155:{book.chain_id}:{book.identity_registry}"}]
    )
    if trust:
        file["supportedTrust"] = trust
    return file


def registration_file_json(file: Mapping[str, Any]) -> str:
    """The compact JSON to publish (https:// or ipfs://) or to embed with `registration_data_uri`."""
    return json.dumps(file, separators=(",", ":"), ensure_ascii=False)


def registration_data_uri(file: Mapping[str, Any]) -> str:
    """A fully on-chain agent URI: `data:application/json;base64,…` of the compact JSON (UTF-8)."""
    return _DATA_PREFIX + base64.b64encode(registration_file_json(file).encode("utf-8")).decode(
        "ascii"
    )


def agent_uri_problem(uri: object) -> str | None:
    """Why an agent URI cannot be used, or None: https:// or ipfs:// under the metadata URI rules (at most 256 bytes), or
    `data:application/json;base64,` with canonical base64 and at most 16,384 bytes in all. The value is never echoed."""
    if not isinstance(uri, str) or uri == "":
        return "it is empty or not a string"
    if uri.startswith(_DATA_PREFIX):
        payload = uri[len(_DATA_PREFIX) :]
        if payload == "" or _CANONICAL_BASE64.fullmatch(payload) is None:
            return "its base64 payload is empty or not canonical base64"
        if len(uri) > _MAX_DATA_URI_BYTES:
            return f"it is longer than {_MAX_DATA_URI_BYTES} bytes"
        return None
    problem = metadata_uri_problem(uri)
    if problem == "it must start with https:// or ipfs://":
        return "it must start with https://, ipfs:// or data:application/json;base64,"
    return problem


def _checked_uri(uri: object) -> str:
    problem = agent_uri_problem(uri)
    if problem is not None:
        raise InvalidInputError("agent_uri", f"agentURI cannot be used: {problem}")
    return str(uri)


def encode_register(network: str, agent_uri: str) -> dict[str, Any]:
    """`register(agentURI)` calldata as `{"chainId", "to", "data", "value": 0}` for the caller's own wallet (an EOA; see
    the module note). The sender becomes the agent's owner and its initial `agentWallet`."""
    book = erc8004_registries(network)
    data = IDENTITY_REGISTRY.encode("register", _checked_uri(agent_uri))
    return {"chainId": book.chain_id, "to": book.identity_registry, "data": data, "value": 0}


def encode_set_agent_uri(network: str, agent_id: int, agent_uri: str) -> dict[str, Any]:
    """`setAgentURI(agentId, agentURI)` calldata, for the agent's owner or an approved operator."""
    book = erc8004_registries(network)
    data = IDENTITY_REGISTRY.encode("setAgentURI", _agent_id(agent_id), _checked_uri(agent_uri))
    return {"chainId": book.chain_id, "to": book.identity_registry, "data": data, "value": 0}


@dataclass(frozen=True)
class RegisteredAgent:
    agent_id: int
    owner: str
    agent_uri: str | None
    """None when only the mint Transfer was found."""


def agent_id_from_receipt(network: str, receipt: Mapping[str, Any]) -> RegisteredAgent:
    """The agent a `register` transaction created, from the registry's `Registered` log (or, without one, its mint
    `Transfer`; `agent_uri` is then None). `receipt` is a JSON-RPC receipt (as `Rpc.get_receipt` returns it). Exactly one
    registration from this network's registry must be present."""
    book = erc8004_registries(network)
    tx_hash = str(receipt.get("transactionHash"))
    status = receipt.get("status")
    if status in ("0x0", 0):
        raise MercurifiError(f"{tx_hash} reverted; no agent was registered.", code="TX_REVERTED")
    decoded: list[tuple[str, dict[str, Any]]] = []
    for log in receipt.get("logs") or []:
        if (
            not isinstance(log, Mapping)
            or str(log.get("address", "")).lower() != book.identity_registry.lower()
        ):
            continue
        try:
            hit = IDENTITY_REGISTRY.decode_log(
                list(log.get("topics") or []), str(log.get("data", "0x"))
            )
        except AbiDecodeError:
            continue
        if hit is not None:
            decoded.append(hit)
    registered = [args for name, args in decoded if name == "Registered"]
    if len(registered) > 1:
        raise MercurifiError(
            f"{tx_hash} registered {len(registered)} agents; read each Registered log yourself.",
            code="MISSING_EVENT",
        )
    if registered:
        r = registered[0]
        return RegisteredAgent(
            int(r["agentId"]), to_checksum_address(r["owner"]), str(r["agentURI"])
        )
    mints = [args for name, args in decoded if name == "Transfer" and int(args["from"], 16) == 0]
    if len(mints) != 1:
        count = "no" if not mints else str(len(mints))
        raise MercurifiError(
            f"{tx_hash} has {count} agent registration event{'' if len(mints) == 1 else 's'} from the {network} IdentityRegistry.",
            code="MISSING_EVENT",
        )
    return RegisteredAgent(int(mints[0]["tokenId"]), to_checksum_address(mints[0]["to"]), None)


@dataclass(frozen=True)
class AgentIdentity:
    agent_id: int
    owner: str
    agent_uri: str
    """The agent URI as stored; untrusted text written by the agent's owner."""
    agent_wallet: str
    """The registry's verified payment wallet: the registering EOA by default, zero after a transfer. Never an agent account."""


async def get_agent(rpc: Rpc, network: str, agent_id: int) -> AgentIdentity:
    """Reads one agent from the network's IdentityRegistry (`client.rpc` of an `AsyncClient`, or any `Rpc`). The RPC
    must be on that network (`NetworkMismatchError` otherwise); an unknown id fails with `AGENT_NOT_FOUND`."""
    book = erc8004_registries(network)
    aid = _agent_id(agent_id)
    chain_id = await rpc.chain_id()
    if chain_id != book.chain_id:
        raise NetworkMismatchError(
            f"The RPC is on chain {chain_id}, not {network} ({book.chain_id})."
        )
    # Errors are raised outside the except blocks, so no __context__ keeps the original exception.
    failure: MercurifiError | None = None
    try:
        owner = await rpc.read(IDENTITY_REGISTRY, book.identity_registry, "ownerOf", aid)
    except RpcError as exc:
        # A revert (ERC721NonexistentToken) carries data; anything else is an RPC failure.
        failure = (
            rpc_error(exc)
            if exc.data is None
            else MercurifiError(
                f"There is no agent {aid} in the {network} IdentityRegistry.",
                code="AGENT_NOT_FOUND",
            )
        )
    if failure is not None:
        raise failure
    try:
        uri = await rpc.read(IDENTITY_REGISTRY, book.identity_registry, "tokenURI", aid)
        wallet = await rpc.read(IDENTITY_REGISTRY, book.identity_registry, "getAgentWallet", aid)
    except RpcError as exc:
        failure = rpc_error(exc)
    if failure is not None:
        raise failure
    return AgentIdentity(aid, to_checksum_address(owner), str(uri), to_checksum_address(wallet))


__all__ = [
    "AGENT_ACCOUNT_SERVICE",
    "ERC8004_REGISTRIES",
    "IDENTITY_REGISTRY",
    "IDENTITY_REGISTRY_ABI",
    "REGISTRATION_TYPE",
    "TRUST_MODELS",
    "AgentIdentity",
    "Erc8004Book",
    "IdentityNetwork",
    "RegisteredAgent",
    "agent_id_from_receipt",
    "agent_uri_problem",
    "build_registration_file",
    "encode_register",
    "encode_set_agent_uri",
    "erc8004_registries",
    "get_agent",
    "registration_data_uri",
    "registration_file_json",
]
