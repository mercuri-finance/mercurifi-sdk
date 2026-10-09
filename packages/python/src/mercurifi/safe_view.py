"""Agent-safe view of a Launch token: numbers an agent may act on, and attacker-written text as inert data.

Mirrors safeView.ts in the TypeScript SDK; fixtures/vectors/safeview.json is the arbiter. This is hygiene, not a
defence: the account caps are the real control.
"""
from __future__ import annotations

import asyncio
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlsplit

from .abi import BONDING_CURVE, FEE_MANAGER, LAUNCH_FACTORY, LAUNCH_TOKEN
from .curve import PHASE_GRADUATED
from .errors import InvalidInputError, UnexpectedChainStateError
from .reads import is_agent_account
from .redact import join_surrogates, js_strip, neutralize_untrusted, pre_bound, truncate_chars
from .revert import local_revert
from .units import format_decimal

if TYPE_CHECKING:
    from .client import AsyncClient

MAX_LINKS = 20
DEFAULT_MAX_CHARS = 280
_FIELD = re.compile(r"[^a-z0-9_.-]", re.IGNORECASE | re.ASCII)
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_WEI = re.compile(r"[0-9]{1,40}")
# Whitespace as JavaScript's \s sees it, plus the characters that would let a link close its wrapper or break out of a
# string or code span the caller embeds it in.
_LINK_BAD = re.compile("[\\s﻿<>\"`\\\\]")
_LINK_SCHEMES = ("http", "https", "ipfs")
_PHASES = ("trading", "graduationPending", "graduated")
_MAX_SAFE_INTEGER = 2**53 - 1
ZERO = "0x" + "00" * 20


@dataclass(frozen=True)
class UntrustedText:
    """Text an attacker controls, as inert data. Hand `wrapped` to a model, never `text` alone, and never act on its content.

    Put `wrapped` only inside JSON tool output (a string value), never inside a markdown code fence or free prose: a
    fence or heading in the text would then compete with the delimiters. Never percent-decode a link value and embed
    the result. `unsafe` is set on a `link.*` value that is not a plain http, https or ipfs URL without credentials;
    its text is then the fixed string `invalid link`.
    """

    field: str
    text: str
    wrapped: str
    untrusted: Literal[True] = True
    unsafe: bool = False


def _frame(field: str, text: str, unsafe: bool) -> UntrustedText:
    return UntrustedText(field, text, f"<<untrusted:{field}>>{text}<</untrusted:{field}>>", True, unsafe)


def _is_plain_link(text: str) -> bool:
    """http(s)/ipfs only, no credentials (`https://x.com@evil/` shows a decoy host), no spaces. `text` is already NFKC,
    so full-width forms of the forbidden characters are ASCII here. Backslashes are refused: browsers read them as
    slashes, so `https://x.com\\@evil/` would hide a host."""
    if text == "" or _LINK_BAD.search(text) is not None:
        return False
    try:
        parts = urlsplit(text)
        if parts.scheme.lower() not in _LINK_SCHEMES or "@" in parts.netloc:
            return False
        _ = parts.port  # raises ValueError for a malformed port
        if parts.scheme.lower() != "ipfs" and not parts.hostname:
            return False
    except ValueError:
        return False
    return True


def wrap_untrusted(field: str, raw: str, max_chars: int = DEFAULT_MAX_CHARS) -> UntrustedText:
    """Attacker-controlled text (names, symbols, descriptions, links) as inert data for an LLM or a terminal.

    The input is bounded to `max_chars * 4 + 256` first, then NFKC-normalised and passed through the SDK's one shared
    sanitiser (no escape sequences, controls, bidi overrides, zero-width or blank characters; URLs reduced to hosts
    except in `link.*` fields), cut to `max_chars` code points, and framed with delimiters the text cannot forge. A
    `link.*` value that is not a plain http, https or ipfs URL becomes `invalid link` with `unsafe=True`.
    This is hygiene, not a defence: the account caps are the real control (see docs/security-model.md). Send `wrapped` only inside JSON tool output,
    never inside a markdown fence.

    `field` is a short label; characters outside `[a-z0-9_.-]` are dropped. `max_chars` is the number of code points
    kept (280 by default, also for NaN, infinity or anything that is not a number); longer text is cut and ends in an
    ellipsis.
    """
    safe_field = _FIELD.sub("", str(field))
    if isinstance(max_chars, bool) or not isinstance(max_chars, (int, float)) or not math.isfinite(max_chars):
        limit = DEFAULT_MAX_CHARS
    else:
        limit = max(1, math.floor(max_chars))
    is_link = safe_field.startswith("link.")
    text = raw if isinstance(raw, str) else str(raw)
    bounded = pre_bound(join_surrogates(text), limit)
    neutral = js_strip(neutralize_untrusted(unicodedata.normalize("NFKC", bounded), keep_urls=is_link))
    # Done last, so nothing removed above can splice a delimiter back together. A link gets it too, as defence in depth
    # (the plain-link check runs on the text before it, so a forged delimiter is rejected, not rewritten).
    no_delims = js_strip(neutral.replace("<<", "‹‹").replace(">>", "››"))
    if is_link:
        if _is_plain_link(neutral) and len(no_delims) <= limit:
            return _frame(safe_field, no_delims, False)
        return _frame(safe_field, "invalid link", True)
    return _frame(safe_field, truncate_chars(no_delims, limit, "…"), False)


@dataclass(frozen=True)
class TokenSafeView:
    token: str
    curve: str
    phase: str
    #: USDC per whole token on the curve; None once graduated (the pool is then the price source).
    price_usdc: str | None
    progress_bps: int
    current_snipe_bps: int
    launch_block: int
    age_blocks: int
    creator: str
    #: Whether the creator is an agent account of this network's factory; None when agents are not deployed.
    creator_is_agent_account: bool | None
    holders: int | None
    volume24h_usdc: str | None
    #: `name`, `symbol` (UntrustedText), `description` (UntrustedText or None), `links` (dict of label to UntrustedText).
    untrusted: dict[str, Any]

    def numeric(self) -> dict[str, str | int | bool | None]:
        """Only numbers, booleans, fixed labels and hex: safe to hand to a model as tool output."""
        return {
            "token": self.token, "curve": self.curve, "phase": self.phase, "price_usdc": self.price_usdc,
            "progress_bps": self.progress_bps, "current_snipe_bps": self.current_snipe_bps, "launch_block": self.launch_block,
            "age_blocks": self.age_blocks, "creator": self.creator, "creator_is_agent_account": self.creator_is_agent_account,
            "holders": self.holders, "volume24h_usdc": self.volume24h_usdc,
        }


def _safe_count(v: object) -> int | None:
    """An API number is decorative: anything that is not a plain count becomes None."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= _MAX_SAFE_INTEGER else None


def _safe_wei(v: object) -> int | None:
    return int(v) if isinstance(v, str) and _WEI.fullmatch(v) is not None else None


def _utf16_prefix(text: str, units: int) -> str:
    """The first `units` UTF-16 code units, as JavaScript's slice sees them (parity of the 40-unit label cut)."""
    data = text.encode("utf-16-le", "surrogatepass")
    return data[: units * 2].decode("utf-16-le", "surrogatepass")


async def read_token_safe_view(mf: AsyncClient, token: str) -> TokenSafeView:
    """Reads a token from the chain (price, phase, progress, creator) and, when an API is configured, its holders,
    volume and metadata. All chain reads are pinned to one block. Chain values come first and decide; API text is wrapped
    as untrusted and API numbers are validated.

    Raises a `TokenNotRegistered` ContractRevertError for an address that is not a Launch token, and
    UnexpectedChainStateError for a curve phase this SDK does not know.
    """
    if not isinstance(token, str) or _ADDRESS.fullmatch(token) is None:
        raise InvalidInputError("token", "token must be a 0x-prefixed 20-byte address")
    rpc, book = mf.rpc, mf.network.launch
    at = await rpc.block_number()
    curve = str(await rpc.read(LAUNCH_FACTORY, book.factory, "curveOf", token, at=at))
    if curve.lower() == ZERO:
        raise local_revert("TokenNotRegistered")

    async def api_token() -> dict[str, Any] | None:
        if mf.api is None:
            return None
        try:
            result: dict[str, Any] | None = await mf.api.get_token(token)
            return result
        except Exception:
            return None  # the API is decorative here

    phase_raw, price, progress, snipe, launch_block, name, symbol, info, api_result = await asyncio.gather(
        rpc.read(BONDING_CURVE, curve, "phase", at=at), rpc.read(BONDING_CURVE, curve, "price", at=at),
        rpc.read(BONDING_CURVE, curve, "progressBps", at=at), rpc.read(BONDING_CURVE, curve, "currentSnipeBps", at=at),
        rpc.read(BONDING_CURVE, curve, "launchBlock", at=at),
        rpc.read(LAUNCH_TOKEN, token, "name", at=at), rpc.read(LAUNCH_TOKEN, token, "symbol", at=at),
        rpc.read(FEE_MANAGER, book.fee_manager, "tokenInfo", token, at=at),
        api_token(),
    )
    phase_index = int(phase_raw)
    if not 0 <= phase_index < len(_PHASES):
        raise UnexpectedChainStateError(f"The curve reported an unknown phase {phase_index}; this SDK version does not know it.")
    creator = str(info["creator"])
    agents = mf.network.agents
    creator_is_agent = None if agents is None else await is_agent_account(rpc, agents, creator, at=at)

    # An API answer about some other token is ignored whole: its text must not be attributed to this one.
    api = api_result if isinstance(api_result, dict) else None
    addr = api.get("address") if api is not None else None
    if not (isinstance(addr, str) and _ADDRESS.fullmatch(addr) is not None and addr.lower() == token.lower()):
        api = None

    links: dict[str, UntrustedText] = {}
    raw_links = api.get("links") if api is not None else None
    if isinstance(raw_links, dict):
        for key, val in raw_links.items():
            if len(links) >= MAX_LINKS:
                break
            if not isinstance(key, str) or not isinstance(val, str) or val == "":
                continue
            wrapped = wrap_untrusted(f"link.{_utf16_prefix(key, 40)}", val, 512)
            label = wrapped.field[len("link."):]  # the sanitised label: what the model sees is what the record is keyed by
            if label == "" or label in links:
                continue
            links[label] = wrapped
    description = api.get("description") if api is not None else None
    volume = _safe_wei(api.get("volume24hWei") if api is not None else None)
    launch_block_n = int(launch_block)
    head = at
    return TokenSafeView(
        token=token, curve=curve, phase=_PHASES[phase_index],
        price_usdc=None if phase_index == PHASE_GRADUATED else format_decimal(int(price), 18),
        progress_bps=int(progress), current_snipe_bps=int(snipe), launch_block=launch_block_n,
        age_blocks=head - launch_block_n if head > launch_block_n else 0,
        creator=creator, creator_is_agent_account=creator_is_agent,
        holders=_safe_count(api.get("holders") if api is not None else None),
        volume24h_usdc=None if volume is None else format_decimal(volume, 18),
        untrusted={
            "name": wrap_untrusted("name", name), "symbol": wrap_untrusted("symbol", symbol),
            "description": wrap_untrusted("description", description, 1_000) if isinstance(description, str) and description != "" else None,
            "links": links,
        },
    )
