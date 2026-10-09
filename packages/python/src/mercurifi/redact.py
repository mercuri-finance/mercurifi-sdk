"""Credential-free error text: RPC URLs often carry an API key in the path, so only the host is ever shown."""
from __future__ import annotations

import logging
import re
import unicodedata
from urllib.parse import urlsplit

from .errors import MercurifiError

# Any "scheme://" or "scheme:\\" matches anywhere (no leading word boundary, so "x:https://k@h/KEY" cannot slip
# through); data:/javascript: only after a non-alphanumeric so words such as "metadata:" are left alone. The lookbehind
# anchors a scheme at the start of its run, so a long letter run is scanned once, not once per start.
_URL_PATTERN = re.compile(
    r"(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:[\\/]{2}|(?<![A-Za-z0-9])(?:data|javascript):)[^\s\"'<>)]*", re.IGNORECASE
)


def redact_url(url: str) -> str:
    """Host (and port) only: no path, query or credentials."""
    try:
        parts = urlsplit(url.replace("\\", "/"))
        host = parts.hostname
        if not host:
            return "invalid URL"
        if not host.isascii():
            # As the WHATWG URL parser shows it (TS redactUrl): an internationalised name in its punycode form.
            try:
                host = host.encode("idna").decode("ascii").lower()
            except UnicodeError:
                return "invalid URL"
        shown = f"[{host}]" if ":" in host else host
        return f"{shown}:{parts.port}" if parts.port is not None else shown
    except ValueError:
        return "invalid URL"


def redact_urls_in(message: str) -> str:
    """Replaces every URL in a message with its host ("invalid URL" for schemes without one)."""
    return _URL_PATTERN.sub(lambda m: redact_url(m.group(0)), message)


# --- Untrusted text ---------------------------------------------------------------------------------------------------
# Mirrors neutralizeUntrusted / preBound / truncateChars in the TypeScript SDK (redact.ts); the shared vectors in
# fixtures/vectors/ are the arbiter. Unicode data dependency: categories (format characters, combining marks) come from
# this interpreter's unicodedata and the pictograph table from the Unicode emoji data, so a character assigned after
# either was built can be treated differently by the two SDKs, or by two Python versions. The output is hygiene, not a
# security boundary; when the vectors and a Unicode release disagree, the vectors decide and the table is regenerated.

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
_CONTROLS = re.compile("[\x00-\x1f\x7f-\x9f  ]+")

# Extended_Pictographic code point ranges (emoji-data.txt).
_EXT_PICTOGRAPHIC: tuple[tuple[int, int], ...] = (
    (0xa9, 0xa9), (0xae, 0xae), (0x203c, 0x203c), (0x2049, 0x2049), (0x2122, 0x2122), (0x2139, 0x2139),
    (0x2194, 0x2199), (0x21a9, 0x21aa), (0x231a, 0x231b), (0x2328, 0x2328), (0x23cf, 0x23cf), (0x23e9, 0x23f3),
    (0x23f8, 0x23fa), (0x24c2, 0x24c2), (0x25aa, 0x25ab), (0x25b6, 0x25b6), (0x25c0, 0x25c0), (0x25fb, 0x25fe),
    (0x2600, 0x2604), (0x260e, 0x260e), (0x2611, 0x2611), (0x2614, 0x2615), (0x2618, 0x2618), (0x261d, 0x261d),
    (0x2620, 0x2620), (0x2622, 0x2623), (0x2626, 0x2626), (0x262a, 0x262a), (0x262e, 0x262f), (0x2638, 0x263a),
    (0x2640, 0x2640), (0x2642, 0x2642), (0x2648, 0x2653), (0x265f, 0x2660), (0x2663, 0x2663), (0x2665, 0x2666),
    (0x2668, 0x2668), (0x267b, 0x267b), (0x267e, 0x267f), (0x2692, 0x2697), (0x2699, 0x2699), (0x269b, 0x269c),
    (0x26a0, 0x26a1), (0x26a7, 0x26a7), (0x26aa, 0x26ab), (0x26b0, 0x26b1), (0x26bd, 0x26be), (0x26c4, 0x26c5),
    (0x26c8, 0x26c8), (0x26ce, 0x26cf), (0x26d1, 0x26d1), (0x26d3, 0x26d4), (0x26e9, 0x26ea), (0x26f0, 0x26f5),
    (0x26f7, 0x26fa), (0x26fd, 0x26fd), (0x2702, 0x2702), (0x2705, 0x2705), (0x2708, 0x270d), (0x270f, 0x270f),
    (0x2712, 0x2712), (0x2714, 0x2714), (0x2716, 0x2716), (0x271d, 0x271d), (0x2721, 0x2721), (0x2728, 0x2728),
    (0x2733, 0x2734), (0x2744, 0x2744), (0x2747, 0x2747), (0x274c, 0x274c), (0x274e, 0x274e), (0x2753, 0x2755),
    (0x2757, 0x2757), (0x2763, 0x2764), (0x2795, 0x2797), (0x27a1, 0x27a1), (0x27b0, 0x27b0), (0x27bf, 0x27bf),
    (0x2934, 0x2935), (0x2b05, 0x2b07), (0x2b1b, 0x2b1c), (0x2b50, 0x2b50), (0x2b55, 0x2b55), (0x3030, 0x3030),
    (0x303d, 0x303d), (0x3297, 0x3297), (0x3299, 0x3299), (0x1f004, 0x1f004), (0x1f02c, 0x1f02f),
    (0x1f094, 0x1f09f), (0x1f0af, 0x1f0b0), (0x1f0c0, 0x1f0c0), (0x1f0cf, 0x1f0d0), (0x1f0f6, 0x1f0ff),
    (0x1f170, 0x1f171), (0x1f17e, 0x1f17f), (0x1f18e, 0x1f18e), (0x1f191, 0x1f19a), (0x1f1ae, 0x1f1e5),
    (0x1f201, 0x1f20f), (0x1f21a, 0x1f21a), (0x1f22f, 0x1f22f), (0x1f232, 0x1f23a), (0x1f23c, 0x1f23f),
    (0x1f249, 0x1f25f), (0x1f266, 0x1f321), (0x1f324, 0x1f393), (0x1f396, 0x1f397), (0x1f399, 0x1f39b),
    (0x1f39e, 0x1f3f0), (0x1f3f3, 0x1f3f5), (0x1f3f7, 0x1f3fa), (0x1f400, 0x1f4fd), (0x1f4ff, 0x1f53d),
    (0x1f549, 0x1f54e), (0x1f550, 0x1f567), (0x1f56f, 0x1f570), (0x1f573, 0x1f57a), (0x1f587, 0x1f587),
    (0x1f58a, 0x1f58d), (0x1f590, 0x1f590), (0x1f595, 0x1f596), (0x1f5a4, 0x1f5a5), (0x1f5a8, 0x1f5a8),
    (0x1f5b1, 0x1f5b2), (0x1f5bc, 0x1f5bc), (0x1f5c2, 0x1f5c4), (0x1f5d1, 0x1f5d3), (0x1f5dc, 0x1f5de),
    (0x1f5e1, 0x1f5e1), (0x1f5e3, 0x1f5e3), (0x1f5e8, 0x1f5e8), (0x1f5ef, 0x1f5ef), (0x1f5f3, 0x1f5f3),
    (0x1f5fa, 0x1f64f), (0x1f680, 0x1f6c5), (0x1f6cb, 0x1f6d2), (0x1f6d5, 0x1f6e5), (0x1f6e9, 0x1f6e9),
    (0x1f6eb, 0x1f6f0), (0x1f6f3, 0x1f6ff), (0x1f7da, 0x1f7ff), (0x1f80c, 0x1f80f), (0x1f848, 0x1f84f),
    (0x1f85a, 0x1f85f), (0x1f888, 0x1f88f), (0x1f8ae, 0x1f8af), (0x1f8bc, 0x1f8bf), (0x1f8c2, 0x1f8cf),
    (0x1f8d9, 0x1f8ff), (0x1f90c, 0x1f93a), (0x1f93c, 0x1f945), (0x1f947, 0x1f9ff), (0x1fa58, 0x1fa5f),
    (0x1fa6e, 0x1faff), (0x1fc00, 0x1fffd),
)


def _class_of(ranges: tuple[tuple[int, int], ...]) -> str:
    return "".join(f"\\U{a:08x}-\\U{b:08x}" for a, b in ranges)


# Blank "letters": Hangul fillers, Braille blank, combining grapheme joiner, variation selectors 17-256, and variation
# selectors 1-16 unless they follow a pictograph, digit, # or * (where they keep their emoji or keycap meaning). The
# lookbehind sees the text as it was before this pass, as in the TypeScript regular expression.
_BLANKS = re.compile(
    "[͏ᅟᅠ⠀ㅤﾠ]|[\U000e0100-\U000e01ef]"
    f"|(?<![{_class_of(_EXT_PICTOGRAPHIC)}#*0-9])[︀-️]"
)
_SURROGATES = re.compile("[\ud800-\udfff]")
_JS_SPACE = (
    " \t\n\v\f\r\xa0                "
    "　﻿"
)
_MAX_MARKS = 4


def join_surrogates(text: str) -> str:
    """Combines adjacent high and low surrogate code points into one character, as a UTF-16 string holds them."""
    if _SURROGATES.search(text) is None:
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def js_strip(text: str) -> str:
    """Strips the characters JavaScript's trim() strips."""
    return text.strip(_JS_SPACE)


def _cap_mark_runs(text: str) -> str:
    out: list[str] = []
    run = 0
    for ch in text:
        if unicodedata.category(ch)[0] == "M":
            run += 1
            if run > _MAX_MARKS:
                continue
        else:
            run = 0
        out.append(ch)
    return "".join(out)


def neutralize_untrusted(raw: str, *, keep_urls: bool = False) -> str:
    """The one sanitiser for text an attacker controls (revert reasons, token names, descriptions, links).

    Escape sequences are removed; control characters and line/paragraph separators become one space; format characters
    (bidi overrides, zero-width, BOM, Tag characters) are removed before URL redaction, so "ht\\u200btp://" cannot hide
    a URL; blank letters and variation selectors outside emoji are removed; combining-mark runs are capped at four;
    URLs are reduced to hosts unless `keep_urls`; lone surrogates are dropped. Callers add their own quoting, length
    bound and framing.

    The work is linear but proportional to the input: callers must `pre_bound` the text first (and normalise it, as
    untrusted_reason does), or a megabyte of attacker text is sanitised for nothing.
    """
    text = _ANSI.sub("", join_surrogates(raw))
    text = _CONTROLS.sub(" ", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = _BLANKS.sub("", text)
    text = _cap_mark_runs(text)
    text = _SURROGATES.sub("", text)
    return text if keep_urls else redact_urls_in(text)


def pre_bound(raw: str, max_chars: int) -> str:
    """The first `max_chars * 4 + 256` UTF-16 code units of the text.

    Stripping only shrinks text (NFKC can expand a character, but the result is truncated to `max_chars` afterwards, so
    the output bound holds). A cut inside a surrogate pair leaves a lone surrogate, which neutralize_untrusted drops,
    exactly as in TypeScript.
    """
    limit = max_chars * 4 + 256
    if len(raw) * 2 <= limit:  # at most two UTF-16 units per character
        return raw
    units = raw.encode("utf-16-le", "surrogatepass")
    return units[: limit * 2].decode("utf-16-le", "surrogatepass")


def truncate_chars(text: str, max_chars: int, suffix: str) -> str:
    """At most `max_chars` code points (never half a pair), then `suffix` when it cut."""
    text = join_surrogates(text)
    return f"{text[:max_chars]}{suffix}" if len(text) > max_chars else text


def first_line(message: str) -> str:
    return message.split("\n", 1)[0]


def rpc_error(error: BaseException) -> MercurifiError:
    """Turns any non-SDK failure from the RPC path into a credential-free RPC_ERROR: first line only, URLs reduced to
    hosts. Callers raise the result OUTSIDE their except block, so no __cause__ or __context__ keeps the original
    exception (whose text may embed the RPC URL)."""
    if isinstance(error, MercurifiError):
        return error
    text = str(error) or type(error).__name__
    return MercurifiError(f"The RPC request failed: {redact_urls_in(first_line(text))}", code="RPC_ERROR")


class RedactingFilter(logging.Filter):
    """Replaces URLs in log records with their host. httpx logs request URLs at INFO and httpcore at DEBUG, and a
    provider key usually sits in the URL path. Levels and handlers are never touched."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        redacted = redact_urls_in(message)
        if redacted != message or record.args:
            record.msg = redacted
            record.args = None
        return True


_LOG_ROOTS = ("httpx", "httpcore")


def install_log_redaction() -> None:
    """Adds one RedactingFilter to the httpx and httpcore loggers and their existing children (a logger's filters do
    not run for its children's records). Idempotent."""
    # httpcore creates its child loggers lazily under these names; naming them here attaches the filter first.
    known = ["httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks"]
    names = [n for n in logging.root.manager.loggerDict if n.split(".")[0] in _LOG_ROOTS] + known + list(_LOG_ROOTS)
    for name in names:
        log = logging.getLogger(name)
        if not any(isinstance(f, RedactingFilter) for f in log.filters):
            log.addFilter(RedactingFilter())
