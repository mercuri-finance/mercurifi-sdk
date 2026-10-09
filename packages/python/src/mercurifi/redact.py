"""Credential-free error text: RPC URLs often carry an API key in the path, so only the host is ever shown."""
from __future__ import annotations

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
