"""Credential-free error text: RPC URLs often carry an API key in the path, so only the host is ever shown."""
from __future__ import annotations

import logging
import re
from urllib.parse import urlsplit

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
        shown = f"[{host}]" if ":" in host else host
        return f"{shown}:{parts.port}" if parts.port is not None else shown
    except ValueError:
        return "invalid URL"


def redact_urls_in(message: str) -> str:
    """Replaces every URL in a message with its host ("invalid URL" for schemes without one)."""
    return _URL_PATTERN.sub(lambda m: redact_url(m.group(0)), message)


def first_line(message: str) -> str:
    return message.split("\n", 1)[0]


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
