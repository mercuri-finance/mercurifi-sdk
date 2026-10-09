"""Test doubles: a scriptable JSON-RPC endpoint behind httpx.MockTransport, and a verified local client."""
from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
from eth_utils.address import to_checksum_address
from eth_utils.crypto import keccak

from mercurifi.abi import AGENT_ACCOUNT_FACTORY, AGENT_POLICY_REGISTRY
from mercurifi.client import AsyncClient, create_client
from mercurifi.codec import Contract, from_hex, to_hex
from mercurifi.networks import local_network


def A(n: int) -> str:
    """A checksummed test address, so it compares equal to what the codec decodes."""
    return to_checksum_address("0x" + format(n, "040x"))


ACCOUNT, TOKEN, CURVE = A(0xAA), A(0xBB), A(0xCC)
# The policy registry; A(11) stays free as "a wrong implementation" in tests.
REGISTRY = A(12)
OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
AGENT_KEY = "0x5de4111afa1a4b94908f83536b1543d1e1b8f8a8b9a5c5e7a5e0d0ff0a0b0c0d"
FACTORY_CODE, IMPL_CODE, REGISTRY_CODE = "0x6001600101", "0x6002600201", "0x6003600301"

TopicFilter = list[str | list[str] | None]


def _topics_match(wanted: TopicFilter | None, topics: list[str]) -> bool:
    """eth_getLogs topic matching: None is a wildcard, a list is "any of", comparison ignores case."""
    for i, want in enumerate(wanted or []):
        if want is None:
            continue
        have = topics[i].lower() if i < len(topics) else None
        if have not in [w.lower() for w in (want if isinstance(want, list) else [want])]:
            return False
    return True


class _Revert(Exception):
    def __init__(self, data: str) -> None:
        self.data = data


Revert = _Revert


class NodeError(Exception):
    """A JSON-RPC error answer (not a revert): the node itself failed the request."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class MockRpc:
    def __init__(self, chain_id: int) -> None:
        self.chain_id = chain_id
        self.calls: list[tuple[str, list[Any]]] = []
        self.sent: list[str] = []
        self.block = {"number": 1_000, "timestamp": 1_700_000_000, "base_fee": 20_000_000_000}
        self.codes: dict[str, str] = {}
        self.balances: dict[str, int] = {}
        self.logs: list[dict[str, Any]] = []
        self.nonce = 7
        self.receipt_mode = "success"
        self.receipt_logs: list[dict[str, Any]] = []
        self.gas_estimate = 150_000
        self._reads: dict[tuple[str, str], tuple[Contract, str, Any]] = {}
        self._reverts: dict[tuple[str, str], str] = {}
        self._receipts: dict[str, dict[str, Any]] = {}
        self._on: dict[str, Callable[[list[Any]], Any]] = {}

    def on(self, method: str, handler: Callable[[list[Any]], Any]) -> MockRpc:
        """Overrides one method. The handler returns a result, raises NodeError (a JSON-RPC error answer), Revert, or any
        other exception (a transport failure)."""
        self._on[method] = handler
        return self

    def read(self, address: str, contract: Contract, fn: str, result: Any) -> MockRpc:
        key = (address.lower(), contract.selector(fn))
        self._reads[key] = (contract, fn, result)
        self._reverts.pop(key, None)
        return self

    def revert(self, address: str, contract: Contract, fn: str, data: str) -> MockRpc:
        self._reverts[(address.lower(), contract.selector(fn))] = data
        return self

    def methods(self, name: str) -> list[list[Any]]:
        return [p for m, p in self.calls if m == name]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        method, params = body["method"], body.get("params", [])
        self.calls.append((method, params))
        try:
            result = self._dispatch(method, params)
        except _Revert as r:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": 3, "message": "execution reverted", "data": r.data}})
        except NodeError as e:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "error": {"code": e.code, "message": str(e)}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    def _call(self, tx: dict[str, Any]) -> str:
        key = (tx["to"].lower(), tx.get("data", "0x")[:10].lower())
        if key in self._reverts:
            raise _Revert(self._reverts[key])
        if key not in self._reads:
            raise AssertionError(f"unmocked eth_call {key}")
        contract, fn, result = self._reads[key]
        _, args = contract.decode_input(tx["data"])
        value = result(list(args.values())) if callable(result) else result
        return contract.encode_result(fn, value)

    def _get_logs(self, f: dict[str, Any]) -> list[dict[str, Any]]:
        addr = str(f.get("address") or "").lower()
        out = []
        for i, entry in enumerate(self.logs):
            if addr and entry["address"].lower() != addr:
                continue
            if not _topics_match(f.get("topics"), entry["topics"]):
                continue
            out.append({
                "blockNumber": hex(self.block["number"]), "transactionHash": to_hex(keccak(i.to_bytes(32, "big"))),
                "logIndex": hex(i), "removed": False, **entry,
            })
        return out

    def _dispatch(self, method: str, params: list[Any]) -> Any:
        b = self.block
        if method in self._on:
            return self._on[method](params)
        if method == "eth_chainId":
            return hex(self.chain_id)
        if method == "eth_blockNumber":
            return hex(b["number"])
        if method == "eth_getBlockByNumber":
            return {"number": hex(b["number"]), "timestamp": hex(b["timestamp"]), "baseFeePerGas": hex(b["base_fee"]), "transactions": []}
        if method == "eth_getCode":
            return self.codes.get(params[0].lower(), "0x")
        if method == "eth_getBalance":
            return hex(self.balances.get(params[0].lower(), 0))
        if method == "eth_getTransactionCount":
            return hex(self.nonce)
        if method == "eth_maxPriorityFeePerGas":
            return hex(1_000_000_000)
        if method == "eth_estimateGas":
            self._call(params[0])
            return hex(self.gas_estimate)
        if method == "eth_call":
            return self._call(params[0])
        if method == "eth_sendRawTransaction":
            tx_hash = to_hex(keccak(from_hex(params[0])))
            self.sent.append(params[0])
            if self.receipt_mode != "none":
                self._receipts[tx_hash] = {"status": self.receipt_mode, "logs": list(self.receipt_logs)}
            return tx_hash
        if method == "eth_getTransactionReceipt":
            r = self._receipts.get(params[0])
            if r is None:
                return None
            return {
                "transactionHash": params[0], "blockNumber": hex(b["number"] + 1), "status": "0x1" if r["status"] == "success" else "0x0",
                "gasUsed": hex(120_000), "effectiveGasPrice": hex(21_000_000_000), "logs": r["logs"],
            }
        if method == "eth_getLogs":
            return self._get_logs(params[0])
        raise AssertionError(f"unmocked RPC method {method}")


def local_json(**over: Any) -> dict[str, Any]:
    book = {
        "chainId": 31337, "launchFactory": A(1), "feeManager": A(2), "graduationManager": A(3), "launchHook": A(4), "poolManager": A(5),
        "permit2": A(6), "universalRouter": A(7), "v4Quoter": A(8), "usdc": "0x3600000000000000000000000000000000000000",
        "agentFactory": A(9), "agentImplementation": A(10), "agentRegistry": REGISTRY,
        "agentFactoryCodeHash": to_hex(keccak(from_hex(FACTORY_CODE))), "agentImplementationCodeHash": to_hex(keccak(from_hex(IMPL_CODE))),
        "agentRegistryCodeHash": to_hex(keccak(from_hex(REGISTRY_CODE))), "deployBlock": 1,
    }
    book.update(over)
    return book


def local_rpc() -> MockRpc:
    """A MockRpc that passes start-up verification of the local book."""
    rpc = MockRpc(31337)
    rpc.codes[A(9).lower()] = FACTORY_CODE
    rpc.codes[A(10).lower()] = IMPL_CODE
    rpc.codes[REGISTRY.lower()] = REGISTRY_CODE
    rpc.read(A(9), AGENT_ACCOUNT_FACTORY, "implementation", A(10))
    rpc.read(A(9), AGENT_ACCOUNT_FACTORY, "registry", REGISTRY)
    rpc.read(REGISTRY, AGENT_POLICY_REGISTRY, "FACTORY", A(9))
    return rpc


async def local_client(rpc: MockRpc, **over: Any) -> AsyncClient:
    opts: dict[str, Any] = {"rpc_url": "http://127.0.0.1:8545", "rpc_transport": rpc.transport(), "poll_interval": 0.001, "on_warning": lambda m: None, "api": None}
    opts.update(over)
    return await create_client(local_network(local_json()), **opts)


Log = Callable[..., dict[str, Any]]


def log(contract: Contract, address: str, name: str, **values: Any) -> dict[str, Any]:
    topics, data = contract.encode_log(name, values)
    return {"address": address, "topics": topics, "data": data, "blockNumber": "0x1", "transactionHash": "0x" + "00" * 32, "logIndex": "0x0"}
