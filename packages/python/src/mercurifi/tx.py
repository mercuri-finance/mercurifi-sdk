"""The send pipeline: chain check, preflight, estimate, fees, chain check, sign, send, wait, decode.

Everything from the first chain check to the receipt runs inside the per-key nonce lock, so a queued send is preflighted
against the state its predecessor left behind. Every non-revert failure leaves as a credential-free RPC_ERROR (see
`rpc_error`); raw httpx errors embed the RPC URL, which often carries a key.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .errors import InvalidInputError, MercurifiError, NetworkMismatchError, TxDroppedError
from .gas import GRADUATION_GAS_LIMIT, MAX_PRIORITY_FEE_PER_GAS, fees_with_floor, gas_limit_for
from .nonce import NonceManager
from .redact import first_line, redact_urls_in, rpc_error
from .revert import (
    ContractRevertError,
    DecodedRevert,
    TxRevertedError,
    decode_revert,
    extract_revert_data,
)
from .rpc import Rpc, RpcError
from .signers import Signer

_DEFAULT_PRIORITY = 1_000_000_000


@dataclass(frozen=True)
class WriteRequest:
    to: str
    data: str
    label: str
    value: int = 0
    # A buy that may complete the curve: preflight and send with at least GRADUATION_GAS_LIMIT.
    may_graduate: bool = False


@dataclass(frozen=True)
class SentTx:
    tx_hash: str
    receipt: dict[str, Any]
    preflight_data: str


def _positive(field: str, value: object) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0 < value < float("inf")
    ):
        raise InvalidInputError(field, f"{field} must be a positive number (seconds)")


# Provider throttling, not the node's verdict on the call: JSON-RPC codes and wording used by RPC providers.
_RATE_LIMIT_CODES = frozenset({429, -32005, -32029})
_RATE_LIMIT_TEXT = re.compile(r"rate[ -]?limit|too many requests|compute units", re.IGNORECASE)


def _rate_limited(exc: RpcError) -> bool:
    """A rate limit says nothing about the call, so it never earns the gas fallback."""
    return exc.code in _RATE_LIMIT_CODES or _RATE_LIMIT_TEXT.search(str(exc)) is not None


class TxSender:
    def __init__(
        self,
        rpc: Rpc,
        chain_id: int,
        nonces: NonceManager,
        receipt_timeout: float,
        poll_interval: float,
        max_fee_per_gas_cap: int | None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        max_priority_fee_per_gas: int = MAX_PRIORITY_FEE_PER_GAS,
    ) -> None:
        _positive("receipt_timeout", receipt_timeout)
        _positive("poll_interval", poll_interval)
        if (
            isinstance(max_priority_fee_per_gas, bool)
            or not isinstance(max_priority_fee_per_gas, int)
            or max_priority_fee_per_gas < 1
        ):
            raise InvalidInputError(
                "max_priority_fee_per_gas",
                "max_priority_fee_per_gas must be a positive integer (wei per gas)",
            )
        self._rpc = rpc
        self._chain_id = chain_id
        self._nonces = nonces
        self._timeout = receipt_timeout
        self._poll = poll_interval
        self._cap = max_fee_per_gas_cap
        self._sleep = sleep
        self._max_priority = max_priority_fee_per_gas

    async def _assert_chain(self) -> None:
        """One uncached eth_chainId per call: an RPC swapped or repointed after start-up must not receive a signed
        transaction. Raises NetworkMismatchError before anything is signed."""
        served = await self._rpc.chain_id()
        if served != self._chain_id:
            raise NetworkMismatchError(
                f"The RPC now serves chain {served}, but this client was verified for chain {self._chain_id}. Nothing was signed."
            )

    async def preflight(self, from_: str, req: WriteRequest) -> str:
        """eth_call from `from_`; a revert becomes ContractRevertError('preflight') with a readable message."""
        failure: MercurifiError | None = None
        try:
            return await self._preflight_raw(from_, req)
        except Exception as exc:
            failure = rpc_error(exc)
        raise failure

    async def _preflight_raw(self, from_: str, req: WriteRequest) -> str:
        revert: DecodedRevert | None = None
        try:
            return await self._rpc.call(
                req.to,
                req.data,
                from_=from_,
                value=req.value,
                gas=GRADUATION_GAS_LIMIT if req.may_graduate else None,
            )
        except RpcError as exc:
            data = extract_revert_data(exc)
            if data is None:
                raise
            revert = decode_revert(data)
        raise ContractRevertError(
            revert, "preflight"
        )  # outside the except block: no cause or context

    async def send(self, signer: Signer, req: WriteRequest) -> SentTx:
        failure: MercurifiError | None = None
        outcome: tuple[str, dict[str, Any], str] | None = None
        try:
            outcome = await self._nonces.with_nonce(
                signer.address, lambda nonce: self._attempt(signer, req, nonce)
            )
        except Exception as exc:
            failure = rpc_error(exc)
        if failure is not None:
            raise failure
        assert outcome is not None
        tx_hash, receipt, preflight_data = outcome
        if receipt.get("status") != "0x1":
            block_number: int | None = None
            try:
                block_number = int(receipt["blockNumber"], 16)
            except Exception:
                block_number = None
            if block_number is None:
                raise MercurifiError(
                    "The RPC request failed: the receipt has no valid block number",
                    code="RPC_ERROR",
                )
            raise TxRevertedError(tx_hash, await self._replay(signer.address, req, block_number))
        return SentTx(tx_hash, receipt, preflight_data)

    async def _attempt(
        self, signer: Signer, req: WriteRequest, nonce: int
    ) -> tuple[str, dict[str, Any], str]:
        await self._assert_chain()
        preflight_data = await self._preflight_raw(signer.address, req)
        estimate = await self._estimate(signer.address, req)
        gas = (
            GRADUATION_GAS_LIMIT if estimate is None else gas_limit_for(estimate, req.may_graduate)
        )
        block = await self._rpc.get_block()
        quoted: int | None = None
        try:
            quoted = await self._rpc.max_priority_fee()
        except Exception:
            quoted = None
        priority = min(_DEFAULT_PRIORITY if quoted is None else quoted, self._max_priority)
        max_fee, prio = fees_with_floor(
            int(block.get("baseFeePerGas", "0x0"), 16), priority, self._cap
        )
        await self._assert_chain()
        raw = await self._sign(
            signer,
            {
                "type": 2,
                "chainId": self._chain_id,
                "nonce": nonce,
                "to": req.to,
                "value": req.value,
                "data": req.data,
                "gas": gas,
                "maxFeePerGas": max_fee,
                "maxPriorityFeePerGas": prio,
            },
        )
        tx_hash = await self._rpc.send_raw(raw)
        receipt = await self._wait(tx_hash)
        if receipt is None:
            raise TxDroppedError(tx_hash, round(self._timeout))
        return tx_hash, receipt, preflight_data

    @staticmethod
    async def _sign(signer: Signer, tx: dict[str, Any]) -> bytes:
        failure: MercurifiError | None = None
        try:
            return await signer.sign_transaction(tx)
        except MercurifiError:
            raise
        except Exception as exc:
            failure = MercurifiError(
                f"The signer failed: {redact_urls_in(first_line(str(exc) or type(exc).__name__))}",
                code="SIGNER_ERROR",
            )
        raise failure

    async def _estimate(self, from_: str, req: WriteRequest) -> int | None:
        """A revert is reported as such; the 1.8M fallback (None) applies only when the node itself failed to estimate
        (a JSON-RPC error answer), never to transport errors or provider rate limits."""
        revert: DecodedRevert | None = None
        try:
            return await self._rpc.estimate_gas(req.to, req.data, from_=from_, value=req.value)
        except RpcError as exc:
            data = extract_revert_data(exc)
            if data is not None:
                revert = decode_revert(data)
            elif req.may_graduate and not _rate_limited(exc):
                return None
            else:
                raise
        raise ContractRevertError(revert, "preflight")

    async def _wait(self, tx_hash: str) -> dict[str, Any] | None:
        """Polls for a receipt; None after the budget, measured in monotonic wall time (Arc can drop a transaction without one)."""
        deadline = time.monotonic() + self._timeout
        while True:
            receipt = await self._rpc.get_receipt(tx_hash)
            if receipt is not None:
                return receipt
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            await self._sleep(min(self._poll, remaining))

    async def _replay(
        self, from_: str, req: WriteRequest, block_number: int
    ) -> DecodedRevert | None:
        """Re-runs the call on the state before the inclusion block (without this transaction's effects) to recover a
        revert reason; None if it does not reproduce."""
        data: str | None = None
        try:
            await self._rpc.call(
                req.to, req.data, from_=from_, value=req.value, block=block_number - 1
            )
        except Exception as exc:
            data = extract_revert_data(exc)
        return None if data is None else decode_revert(data)
