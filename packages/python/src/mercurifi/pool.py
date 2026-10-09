"""The graduated Launch pool: key derivation, V4Quoter quotes and an approximate price-impact estimate (TS pool.ts)."""
from __future__ import annotations

from typing import Any

from eth_abi.abi import encode

from .abi import GRADUATION_MANAGER, V4_QUOTER
from .codec import to_hex
from .errors import MercurifiError
from .networks import NetworkBook
from .rpc import Rpc, RpcError

UINT128_MAX = 2**128 - 1
_WAD = 10**18


async def read_pool_key(rpc: Rpc, book: NetworkBook, token: str, *, at: int | None = None) -> dict[str, Any]:
    """The graduated pool, derived exactly as the account derives it (spec 4.6): the GraduationManager's key for the token,
    which must go through LaunchHook and pair the token with USDC. Never supplied by a caller."""
    raw: dict[str, Any] = await rpc.read(GRADUATION_MANAGER, book.launch.graduation_manager, "poolKey", token, at=at)
    key: dict[str, Any] = {
        "currency0": raw["currency0"], "currency1": raw["currency1"], "fee": int(raw["fee"]), "tickSpacing": int(raw["tickSpacing"]), "hooks": raw["hooks"],
    }
    if str(key["hooks"]).lower() != book.launch.launch_hook.lower():
        raise MercurifiError(f"The pool for {token} is not hooked by LaunchHook; refusing to quote or trade it.", code="POOL_KEY_MISMATCH")
    pair = {str(key["currency0"]).lower(), str(key["currency1"]).lower()}
    if pair != {book.launch.usdc.lower(), token.lower()}:
        raise MercurifiError(f"The pool for {token} does not pair the token with USDC; refusing to quote or trade it.", code="POOL_KEY_MISMATCH")
    return key


async def quote_exact_in(rpc: Rpc, book: NetworkBook, key: dict[str, Any], zero_for_one: bool, amount_in: int, account: str, *, at: int | None = None) -> int:
    """V4Quoter exact-in quote with the account's own address as hookData. The pool's USDC side is the 6-decimal ERC-20 view,
    so USDC amounts in and out are usdc6. Advisory: the minimum is enforced on-chain."""
    params = {"poolKey": key, "zeroForOne": zero_for_one, "exactAmount": amount_in, "hookData": to_hex(encode(["address"], [account]))}
    result = await rpc.read(V4_QUOTER, book.launch.v4_quoter, "quoteExactInputSingle", params, at=at)
    return int(result[0])


async def estimate_pool_impact_bps(
    rpc: Rpc, book: NetworkBook, key: dict[str, Any], zero_for_one: bool, amount_in: int, amount_out: int, account: str, *, at: int | None = None,
) -> int | None:
    """Approximate price impact of a swap in basis points, from the quoter alone: the trade's execution price against a probe a
    thousandth of its size gives k > 1, the execution-price ratio. For a constant-product pool the sqrt price moves with it, so
    the price rises by k^2 - 1 (token1 -> token0 buys) or falls by 1 - 1/k^2 (`zero_for_one`). None when the probe gives no
    answer. Approximate and for a warning only: the account enforces the real limit."""
    probe_in = amount_in // 1000
    if probe_in == 0 or amount_out == 0:
        return None
    try:
        probe_out = await quote_exact_in(rpc, book, key, zero_for_one, probe_in, account, at=at)
    except (MercurifiError, RpcError):
        return None
    if probe_out == 0:
        return None
    k = probe_out * amount_in * _WAD // (amount_out * probe_in)
    if k <= _WAD:
        return 0
    k2 = k * k // _WAD
    return (_WAD - _WAD * _WAD // k2) * 10_000 // _WAD if zero_for_one else (k2 - _WAD) * 10_000 // _WAD
