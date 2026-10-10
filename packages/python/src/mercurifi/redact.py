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
    r"(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:[\\/]{2}|(?<![A-Za-z0-9])(?:data|javascript):)[^\s\"'<>)]*",
    re.IGNORECASE,
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
    (0xA9, 0xA9),
    (0xAE, 0xAE),
    (0x203C, 0x203C),
    (0x2049, 0x2049),
    (0x2122, 0x2122),
    (0x2139, 0x2139),
    (0x2194, 0x2199),
    (0x21A9, 0x21AA),
    (0x231A, 0x231B),
    (0x2328, 0x2328),
    (0x23CF, 0x23CF),
    (0x23E9, 0x23F3),
    (0x23F8, 0x23FA),
    (0x24C2, 0x24C2),
    (0x25AA, 0x25AB),
    (0x25B6, 0x25B6),
    (0x25C0, 0x25C0),
    (0x25FB, 0x25FE),
    (0x2600, 0x2604),
    (0x260E, 0x260E),
    (0x2611, 0x2611),
    (0x2614, 0x2615),
    (0x2618, 0x2618),
    (0x261D, 0x261D),
    (0x2620, 0x2620),
    (0x2622, 0x2623),
    (0x2626, 0x2626),
    (0x262A, 0x262A),
    (0x262E, 0x262F),
    (0x2638, 0x263A),
    (0x2640, 0x2640),
    (0x2642, 0x2642),
    (0x2648, 0x2653),
    (0x265F, 0x2660),
    (0x2663, 0x2663),
    (0x2665, 0x2666),
    (0x2668, 0x2668),
    (0x267B, 0x267B),
    (0x267E, 0x267F),
    (0x2692, 0x2697),
    (0x2699, 0x2699),
    (0x269B, 0x269C),
    (0x26A0, 0x26A1),
    (0x26A7, 0x26A7),
    (0x26AA, 0x26AB),
    (0x26B0, 0x26B1),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26C8, 0x26C8),
    (0x26CE, 0x26CF),
    (0x26D1, 0x26D1),
    (0x26D3, 0x26D4),
    (0x26E9, 0x26EA),
    (0x26F0, 0x26F5),
    (0x26F7, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2702, 0x2702),
    (0x2705, 0x2705),
    (0x2708, 0x270D),
    (0x270F, 0x270F),
    (0x2712, 0x2712),
    (0x2714, 0x2714),
    (0x2716, 0x2716),
    (0x271D, 0x271D),
    (0x2721, 0x2721),
    (0x2728, 0x2728),
    (0x2733, 0x2734),
    (0x2744, 0x2744),
    (0x2747, 0x2747),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2763, 0x2764),
    (0x2795, 0x2797),
    (0x27A1, 0x27A1),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2934, 0x2935),
    (0x2B05, 0x2B07),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x3030, 0x3030),
    (0x303D, 0x303D),
    (0x3297, 0x3297),
    (0x3299, 0x3299),
    (0x1F004, 0x1F004),
    (0x1F02C, 0x1F02F),
    (0x1F094, 0x1F09F),
    (0x1F0AF, 0x1F0B0),
    (0x1F0C0, 0x1F0C0),
    (0x1F0CF, 0x1F0D0),
    (0x1F0F6, 0x1F0FF),
    (0x1F170, 0x1F171),
    (0x1F17E, 0x1F17F),
    (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A),
    (0x1F1AE, 0x1F1E5),
    (0x1F201, 0x1F20F),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F23A),
    (0x1F23C, 0x1F23F),
    (0x1F249, 0x1F25F),
    (0x1F266, 0x1F321),
    (0x1F324, 0x1F393),
    (0x1F396, 0x1F397),
    (0x1F399, 0x1F39B),
    (0x1F39E, 0x1F3F0),
    (0x1F3F3, 0x1F3F5),
    (0x1F3F7, 0x1F3FA),
    (0x1F400, 0x1F4FD),
    (0x1F4FF, 0x1F53D),
    (0x1F549, 0x1F54E),
    (0x1F550, 0x1F567),
    (0x1F56F, 0x1F570),
    (0x1F573, 0x1F57A),
    (0x1F587, 0x1F587),
    (0x1F58A, 0x1F58D),
    (0x1F590, 0x1F590),
    (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A5),
    (0x1F5A8, 0x1F5A8),
    (0x1F5B1, 0x1F5B2),
    (0x1F5BC, 0x1F5BC),
    (0x1F5C2, 0x1F5C4),
    (0x1F5D1, 0x1F5D3),
    (0x1F5DC, 0x1F5DE),
    (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3),
    (0x1F5E8, 0x1F5E8),
    (0x1F5EF, 0x1F5EF),
    (0x1F5F3, 0x1F5F3),
    (0x1F5FA, 0x1F64F),
    (0x1F680, 0x1F6C5),
    (0x1F6CB, 0x1F6D2),
    (0x1F6D5, 0x1F6E5),
    (0x1F6E9, 0x1F6E9),
    (0x1F6EB, 0x1F6F0),
    (0x1F6F3, 0x1F6FF),
    (0x1F7DA, 0x1F7FF),
    (0x1F80C, 0x1F80F),
    (0x1F848, 0x1F84F),
    (0x1F85A, 0x1F85F),
    (0x1F888, 0x1F88F),
    (0x1F8AE, 0x1F8AF),
    (0x1F8BC, 0x1F8BF),
    (0x1F8C2, 0x1F8CF),
    (0x1F8D9, 0x1F8FF),
    (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945),
    (0x1F947, 0x1F9FF),
    (0x1FA58, 0x1FA5F),
    (0x1FA6E, 0x1FAFF),
    (0x1FC00, 0x1FFFD),
)


def _class_of(ranges: tuple[tuple[int, int], ...]) -> str:
    return "".join(f"\\U{a:08x}-\\U{b:08x}" for a, b in ranges)


# Blank "letters": Hangul fillers, Braille blank, combining grapheme joiner, variation selectors 17-256, and variation
# selectors 1-16 unless they follow a pictograph, digit, # or * (where they keep their emoji or keycap meaning). The
# lookbehind sees the text as it was before this pass, as in the TypeScript regular expression.
_BLANKS = re.compile(f"[͏ᅟᅠ⠀ㅤﾠ]|[\U000e0100-\U000e01ef]|(?<![{_class_of(_EXT_PICTOGRAPHIC)}#*0-9])[︀-️]")
_SURROGATES = re.compile("[\ud800-\udfff]")
_JS_SPACE = " \t\n\v\f\r\xa0                　﻿"
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
    return MercurifiError(
        f"The RPC request failed: {redact_urls_in(first_line(text))}", code="RPC_ERROR"
    )


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
    known = [
        "httpcore.connection",
        "httpcore.http11",
        "httpcore.http2",
        "httpcore.proxy",
        "httpcore.socks",
    ]
    names = (
        [n for n in logging.root.manager.loggerDict if n.split(".")[0] in _LOG_ROOTS]
        + known
        + list(_LOG_ROOTS)
    )
    for name in names:
        log = logging.getLogger(name)
        if not any(isinstance(f, RedactingFilter) for f in log.filters):
            log.addFilter(RedactingFilter())
