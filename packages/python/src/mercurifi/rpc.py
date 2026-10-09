"""Minimal async JSON-RPC over httpx: the dozen methods the SDK needs, instead of web3.py's dependency tree.

Transport failures surface as MercurifiError("RPC_ERROR") naming the host only and dropping the cause, because httpx
messages and tracebacks embed the full URL (often with a provider key in the path).
"""
from __future__ import annotations

from typing import Any

import httpx

from .codec import Contract, to_hex
from .errors import MercurifiError
from .redact import first_line, redact_url, redact_urls_in


class RpcError(Exception):
    """The node answered a JSON-RPC error (a revert carries its data here)."""

    def __init__(self, code: int, message: str, data: str | None) -> None:
        super().__init__(redact_urls_in(first_line(message)))
        self.code = code
        self.data = data


def _data_of(error: dict[str, Any]) -> str | None:
    d = error.get("data")
    if isinstance(d, str) and d.startswith("0x"):
        return d
    if isinstance(d, dict) and isinstance(d.get("data"), str):
        return str(d["data"])
    return None


class Rpc:
    def __init__(self, url: str, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 15.0) -> None:
        self._url = url
        self._host = redact_url(url)
        self._http = httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=False)
        self._id = 0

    def __repr__(self) -> str:
        return f"Rpc(host={self._host!r})"

    def _int(self, value: Any, what: str) -> int:
        if not isinstance(value, str) or not value.startswith("0x"):
            raise self._fail(f"unexpected {what}")
        try:
            return int(value, 16)
        except ValueError:
            raise self._fail(f"unexpected {what}") from None

    def _fail(self, reason: str) -> MercurifiError:
        return MercurifiError(f"The RPC request to {self._host} failed: {redact_urls_in(first_line(reason))}", code="RPC_ERROR")

    async def request(self, method: str, params: list[Any]) -> Any:
        self._id += 1
        failure: str | None = None
        status, body = 0, None
        try:
            response = await self._http.post(self._url, json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
            status = response.status_code
            body = response.json() if status < 400 else None
        except httpx.HTTPError as exc:
            failure = f"{type(exc).__name__}: {exc}"
        except ValueError:
            failure = "the response is not JSON"
        # Raised outside the except block so the original exception (which embeds the URL) is not kept as context.
        if failure is not None:
            raise self._fail(failure)
        if status >= 400:
            raise self._fail(f"HTTP {status}")
        if not isinstance(body, dict):
            raise self._fail("the response is not a JSON-RPC object")
        error = body.get("error")
        if error:
            if not isinstance(error, dict):
                raise self._fail("malformed JSON-RPC error")
            code = error.get("code", 0)
            raise RpcError(code if isinstance(code, int) else 0, str(error.get("message", "")), _data_of(error))
        return body.get("result")

    async def chain_id(self) -> int:
        return self._int(await self.request("eth_chainId", []), "chain id")

    async def block_number(self) -> int:
        return self._int(await self.request("eth_blockNumber", []), "block number")

    async def get_block(self, tag: str = "latest") -> dict[str, Any]:
        block = await self.request("eth_getBlockByNumber", [tag, False])
        if not isinstance(block, dict):
            raise self._fail("no such block")
        return block

    async def latest_timestamp(self) -> int:
        return self._int((await self.get_block()).get("timestamp"), "block timestamp")

    async def get_code(self, address: str) -> str:
        code = await self.request("eth_getCode", [address, "latest"])
        if not isinstance(code, str):
            raise self._fail("unexpected code result")
        return code

    async def get_balance(self, address: str) -> int:
        return self._int(await self.request("eth_getBalance", [address, "latest"]), "balance")

    async def get_transaction_count(self, address: str, tag: str = "pending") -> int:
        return self._int(await self.request("eth_getTransactionCount", [address, tag]), "nonce")

    @staticmethod
    def _tx(to: str, data: str, from_: str | None, value: int, gas: int | None) -> dict[str, str]:
        tx = {"to": to, "data": data}
        if from_ is not None:
            tx["from"] = from_
        if value:
            tx["value"] = hex(value)
        if gas is not None:
            tx["gas"] = hex(gas)
        return tx

    async def call(self, to: str, data: str, *, from_: str | None = None, value: int = 0, gas: int | None = None, block: str | int = "latest") -> str:
        tag = block if isinstance(block, str) else hex(block)
        result = await self.request("eth_call", [self._tx(to, data, from_, value, gas), tag])
        if not isinstance(result, str):
            raise self._fail("unexpected call result")
        return result

    async def estimate_gas(self, to: str, data: str, *, from_: str, value: int = 0) -> int:
        return self._int(await self.request("eth_estimateGas", [self._tx(to, data, from_, value, None)]), "gas estimate")

    async def max_priority_fee(self) -> int:
        return self._int(await self.request("eth_maxPriorityFeePerGas", []), "priority fee")

    async def send_raw(self, raw: bytes) -> str:
        result = await self.request("eth_sendRawTransaction", [to_hex(raw)])
        if not isinstance(result, str):
            raise self._fail("unexpected transaction hash")
        return result

    async def get_receipt(self, tx_hash: str) -> dict[str, Any] | None:
        receipt = await self.request("eth_getTransactionReceipt", [tx_hash])
        if receipt is not None and not isinstance(receipt, dict):
            raise self._fail("unexpected receipt")
        return receipt

    async def get_logs(
        self, address: str, from_block: int, to_block: int, topics: list[str | None] | None = None
    ) -> list[dict[str, Any]]:
        """eth_getLogs for one emitter; `topics` is positional, None a wildcard (the registry's events carry the
        account as topic 1, so one filter covers every queue event of one account)."""
        f: dict[str, Any] = {"address": address, "fromBlock": hex(from_block), "toBlock": hex(to_block)}
        if topics is not None:
            f["topics"] = topics
        logs = await self.request("eth_getLogs", [f])
        if not isinstance(logs, list):
            raise self._fail("unexpected logs result")
        return logs

    async def read(self, contract: Contract, address: str, fn: str, *args: object) -> Any:
        return contract.decode_output(fn, await self.call(address, contract.encode(fn, *args)))

    async def aclose(self) -> None:
        await self._http.aclose()
