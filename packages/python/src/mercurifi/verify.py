from __future__ import annotations

from eth_utils.crypto import keccak

from .abi import AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY
from .codec import from_hex, to_hex
from .errors import NetworkMismatchError
from .networks import NetworkBook
from .rpc import Rpc


async def _check_code(rpc: Rpc, label: str, address: str, expected: str) -> None:
    code = await rpc.get_code(address)
    if code in ("0x", "") or to_hex(keccak(from_hex(code))).lower() != expected.lower():
        raise NetworkMismatchError(
            f"The agent account {label} at {address} does not match the pinned code hash."
        )


async def verify_network(rpc: Rpc, book: NetworkBook) -> None:
    """Start-up check, identical to the TypeScript SDK: the RPC serves the book's chain, and the agent
    factory, implementation and policy registry carry the pinned runtime code and point at each other. Refuses rather
    than warns: a wrong network or code means every later step is unsafe."""
    chain_id = await rpc.chain_id()
    if chain_id != book.chain_id:
        raise NetworkMismatchError(
            f"The RPC serves chain {chain_id}, but the {book.name} address book is chain {book.chain_id}. Testnet and mainnet are never mixed."
        )
    agents = book.agents
    if agents is None:
        return
    await _check_code(rpc, "factory", agents.factory, agents.factory_code_hash)
    await _check_code(rpc, "implementation", agents.implementation, agents.implementation_code_hash)
    await _check_code(rpc, "policy registry", agents.registry, agents.registry_code_hash)
    impl = await rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "implementation")
    registry = await rpc.read(AGENT_ACCOUNT_FACTORY, agents.factory, "registry")
    registry_factory = await rpc.read(AGENT_POLICY_REGISTRY, agents.registry, "FACTORY")
    if str(impl).lower() != agents.implementation.lower():
        raise NetworkMismatchError(
            f"The factory reports implementation {impl}, not the pinned {agents.implementation}."
        )
    if str(registry).lower() != agents.registry.lower():
        raise NetworkMismatchError(
            f"The factory reports registry {registry}, not the pinned {agents.registry}."
        )
    if str(registry_factory).lower() != agents.factory.lower():
        raise NetworkMismatchError(
            f"The policy registry at {agents.registry} belongs to factory {registry_factory}, not the pinned {agents.factory}."
        )
