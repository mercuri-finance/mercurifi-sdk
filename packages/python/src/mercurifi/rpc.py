"""Minimal async JSON-RPC over httpx: the dozen methods the SDK needs, instead of web3.py's dependency tree.

Transport failures surface as MercurifiError("RPC_ERROR") naming the host only and dropping the cause, because httpx
messages and tracebacks embed the full URL (often with a provider key in the path).
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from .codec import Contract, to_hex
from .errors import MercurifiError
from .redact import first_line, install_log_redaction, redact_url, redact_urls_in

MAX_RESPONSE_BYTES = 16 * 1024 * 1024


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
    def __init__(
        self,
        url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
    ) -> None:
        install_log_redaction()
        self._max_bytes = max_response_bytes
        self._url = url
        self._host = redact_url(url)
        self._http = httpx.AsyncClient(
            transport=transport, timeout=timeout, follow_redirects=False, trust_env=False
        )
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
        return MercurifiError(
            f"The RPC request to {self._host} failed: {redact_urls_in(first_line(reason))}",
            code="RPC_ERROR",
        )

    async def request(self, method: str, params: list[Any]) -> Any:
        self._id += 1
        rid = self._id  # captured locally: concurrent requests must each compare their own id
        failure: str | None = None
        status, raw = 0, b""
        try:
            payload = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
            async with self._http.stream("POST", self._url, json=payload) as response:
                status = response.status_code
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > self._max_bytes:
                    failure = f"the response is larger than {self._max_bytes} bytes"
                elif 200 <= status < 300:
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > self._max_bytes:
                            failure = f"the response is larger than {self._max_bytes} bytes"
                            break
                        chunks.append(chunk)
                    raw = b"".join(chunks)
        except (
            Exception
        ) as exc:  # transport, decoding or anything else: the text may embed the URL, so redact it
            failure = f"{type(exc).__name__}: {exc}"
        # Raised outside the except block so the original exception (which embeds the URL) is not kept as context.
        if failure is not None:
            raise self._fail(failure)
        if not 200 <= status < 300:
            raise self._fail(f"HTTP {status}")
        body: Any = None
        try:
            body = json.loads(raw)
        except ValueError:
            failure = "the response is not JSON"
        if failure is not None:
            raise self._fail(failure)
        if not isinstance(body, dict):
            raise self._fail("the response is not a JSON-RPC object")
        if body.get("jsonrpc") != "2.0":
            raise self._fail("the response is not JSON-RPC 2.0")
        if body.get("id") != rid or isinstance(body.get("id"), bool):
            raise self._fail("the response id does not match the request")
        error = body.get("error")
        if error:
            if not isinstance(error, dict):
                raise self._fail("malformed JSON-RPC error")
            code = error.get("code", 0)
            raise RpcError(
                code if isinstance(code, int) else 0, str(error.get("message", "")), _data_of(error)
            )
        if "result" not in body:
            raise self._fail("the response has neither result nor error")
        return body["result"]

    async def chain_id(self) -> int:
        return self._int(await self.request("eth_chainId", []), "chain id")

    async def block_number(self) -> int:
        return self._int(await self.request("eth_blockNumber", []), "block number")

    async def get_block(self, tag: str = "latest") -> dict[str, Any]:
        block = await self.request("eth_getBlockByNumber", [tag, False])
        if not isinstance(block, dict):
            raise self._fail("no such block")
        return block

    async def latest_block(self) -> tuple[int, int]:
        """(number, timestamp) of the latest block; a malformed answer is an RPC_ERROR, never a KeyError or ValueError."""
        block = await self.get_block()
        return self._int(block.get("number"), "block number"), self._int(
            block.get("timestamp"), "block timestamp"
        )

    async def latest_timestamp(self) -> int:
        return self._int((await self.get_block()).get("timestamp"), "block timestamp")

    async def get_code(self, address: str) -> str:
        code = await self.request("eth_getCode", [address, "latest"])
        if not isinstance(code, str):
            raise self._fail("unexpected code result")
        return code

    async def get_balance(self, address: str, *, at: int | None = None) -> int:
        return self._int(
            await self.request("eth_getBalance", [address, "latest" if at is None else hex(at)]),
            "balance",
        )

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

    async def call(
        self,
        to: str,
        data: str,
        *,
        from_: str | None = None,
        value: int = 0,
        gas: int | None = None,
        block: str | int = "latest",
    ) -> str:
        tag = block if isinstance(block, str) else hex(block)
        result = await self.request("eth_call", [self._tx(to, data, from_, value, gas), tag])
        if not isinstance(result, str):
            raise self._fail("unexpected call result")
        return result

    async def estimate_gas(self, to: str, data: str, *, from_: str, value: int = 0) -> int:
        return self._int(
            await self.request("eth_estimateGas", [self._tx(to, data, from_, value, None)]),
            "gas estimate",
        )

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
        f: dict[str, Any] = {
            "address": address,
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
        }
        if topics is not None:
            f["topics"] = topics
        logs = await self.request("eth_getLogs", [f])
        if not isinstance(logs, list):
            raise self._fail("unexpected logs result")
        return logs

    async def read(
        self, contract: Contract, address: str, fn: str, *args: object, at: int | None = None
    ) -> Any:
        """A view call; `at` pins it to a block number (default: latest)."""
        data = await self.call(
            address, contract.encode(fn, *args), block="latest" if at is None else at
        )
        return contract.decode_output(fn, data)

    async def aclose(self) -> None:
        await self._http.aclose()
