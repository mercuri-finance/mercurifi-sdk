"""HTTP API client. Advisory only: API keys select a rate tier and never authorise funds (TS api/http.ts).

Paths and bodies follow the Mercurifi API (`/v1/openapi.json`); this is the only Python file that knows them.
Answers are untrusted: shapes are checked, sizes and page counts are bounded, redirects are refused (the key must not
follow one), and nothing here is ever a reason to sign (see build_verify.verify_built_tx).
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
from typing import Any, NoReturn, Protocol, runtime_checkable
from urllib.parse import quote as urlquote

import httpx

from .errors import ApiError, InvalidInputError, MercurifiError
from .networks import is_loopback_url, url_host
from .redact import (
    first_line,
    install_log_redaction,
    neutralize_untrusted,
    pre_bound,
    truncate_chars,
)

#: A response larger than this is refused unread (the largest legitimate answer is a page of actions).
MAX_BODY_BYTES = 4 * 1024 * 1024
#: Items per list answer; the API pages far below this.
MAX_ITEMS = 1_000
MAX_CURSOR = 256
MAX_LIST_PAGES = 10
QUOTE_KINDS = ("curve-buy", "curve-sell", "pool-swap")

_CURSOR = re.compile(r"[A-Za-z0-9_\-.:=~]+")
_DECIMAL = re.compile(r"[0-9]{1,78}")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_HEX = re.compile(r"0x(?:[0-9a-fA-F]{2})*")
_SELECTOR = re.compile(r"0x[0-9a-fA-F]{8}")
_KEY = re.compile(r"[A-Za-z0-9_-]{1,256}")
_API_CODE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_RETRY = re.compile(r"[0-9]{1,9}")  # delta-seconds: digits only
#: RFC 6750 token68: header-safe, so a bearer can never inject a header.
_BEARER = re.compile(r"[A-Za-z0-9\-._~+/]{1,512}=*")
_NONCE = re.compile(r"[A-Za-z0-9]{1,128}")
_SIGNATURE = re.compile(r"0x[0-9a-fA-F]{130}")
_REACTION_KEY = re.compile(r"[a-z_]{1,32}")
_MAX_SAFE = 2**53 - 1  # the TypeScript SDK's integer bound, kept for parity
_MAX_PAGE = 50
#: The API serves at most this many marks per range.
_MAX_MARKS = 2_000
_MARKS_SPAN = 90 * 86_400
_NOTE_MAX = 280
_STRIPPED = ("Cc", "Cf", "Zl", "Zp")


class MercurifiApi(Protocol):
    """The SDK's only view of the HTTP API; HttpApi implements it and tests substitute fakes."""

    base_url: str
    chain_id: int

    async def get_account(self, account: str, *, live: bool = False) -> dict[str, Any]: ...
    async def list_accounts(self, owner: str) -> list[dict[str, Any]]: ...
    async def list_actions(self, account: str, cursor: str | None = None) -> dict[str, Any]: ...
    async def quote(self, kind: str, body: dict[str, Any]) -> dict[str, Any]: ...
    async def build_tx(self, body: dict[str, Any]) -> dict[str, Any]: ...
    async def upload_launch_metadata(
        self, meta: dict[str, Any], image: Any = None
    ) -> dict[str, Any]: ...
    async def get_token(self, token: str) -> dict[str, Any] | None: ...
    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]: ...


@runtime_checkable
class SocialApi(Protocol):
    """Signals and notes, split from MercurifiApi so a 1.0 implementation still type-checks; HttpApi implements both.
    `require_api(social=True)` refuses an API without these methods."""

    # Sign-in sends neither the API key nor a bearer.
    async def sign_in_challenge(self, kind: str, account: str, signer: str) -> dict[str, Any]: ...
    async def sign_in(self, nonce: str, signature_hex: str) -> dict[str, Any]: ...
    async def sign_out(self, bearer: str) -> None: ...

    # Public reads: they send the API key and no bearer, so `agreed` is always false.
    async def list_notes(
        self, token: str, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]: ...
    async def list_replies(
        self, id: int, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]: ...
    async def get_note(self, id: int) -> dict[str, Any]: ...
    async def note_marks(self, token: str, start: int, end: int) -> list[dict[str, Any]]: ...
    async def get_reactions(self, token: str) -> dict[str, Any]: ...

    # Social writes send the bearer and never the API key. Bodies are sent as given: check them with check_body.
    async def put_reaction(
        self, token: str, key: str | None, bearer: str, active: bool | None = None
    ) -> None: ...
    async def post_note(self, token: str, body: str, bearer: str) -> dict[str, Any]: ...
    async def post_reply(self, id: int, body: str, bearer: str) -> dict[str, Any]: ...
    async def agree(self, id: int, active: bool, bearer: str) -> None: ...
    async def report(self, id: int, bearer: str) -> None: ...
    async def delete_note(self, id: int, bearer: str) -> None: ...
    async def get_posting(self, account: str) -> dict[str, Any]: ...
    async def set_posting(self, account: str, enabled: bool, bearer: str) -> dict[str, Any]: ...
    async def delete_agent_notes(self, account: str, bearer: str) -> dict[str, Any]: ...


class _Secret:
    """Holds the API key where repr, str, vars() dumps and pickle cannot reach it."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "'[redacted]'"

    __str__ = __repr__

    def __reduce__(self) -> NoReturn:
        raise TypeError("the API key cannot be pickled")

    def __copy__(self) -> _Secret:
        raise TypeError("the API key cannot be copied")

    def __deepcopy__(self, memo: object) -> _Secret:
        raise TypeError("the API key cannot be copied")


def _bad(path: str, what: str) -> MercurifiError:
    return MercurifiError(
        f"The API answered {path} with something unexpected ({what}); it was ignored.",
        code="API_BAD_RESPONSE",
    )


def clean_text(value: object, limit: int = 200) -> str:
    """Server text is untrusted: no control or format characters, no URLs, bounded."""
    text = value if isinstance(value, str) else ""
    plain = neutralize_untrusted(pre_bound(text, limit)).strip(" \t\r\n")
    return truncate_chars(plain, limit, "...")


def _is_addr(v: object) -> bool:
    return isinstance(v, str) and _ADDRESS.fullmatch(v) is not None


def _address_param(field: str, value: object) -> str:
    if not isinstance(value, str) or _ADDRESS.fullmatch(value) is None:
        raise InvalidInputError(field, f"{field} is not an address")
    return value.lower()


def _cursor_param(cursor: object) -> str:
    if not isinstance(cursor, str) or len(cursor) > MAX_CURSOR or _CURSOR.fullmatch(cursor) is None:
        raise InvalidInputError("cursor", "cursor is not one the API issued")
    return cursor


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_count(v: object) -> bool:
    return _is_int(v) and 0 <= v <= _MAX_SAFE  # type: ignore[operator]


def _page_query(cursor: str | None, limit: int | None) -> str:
    """`?cursor=…&limit=…` from the given fields, checked first."""
    parts: list[str] = []
    if cursor is not None:
        parts.append(f"cursor={urlquote(_cursor_param(cursor), safe='')}")
    if limit is not None:
        if not _is_int(limit) or not 1 <= limit <= _MAX_PAGE:
            raise InvalidInputError("limit", f"limit must be 1 to {_MAX_PAGE}")
        parts.append(f"limit={limit}")
    return f"?{'&'.join(parts)}" if parts else ""


def _note_id(id: object) -> int:
    if not _is_int(id) or not 1 <= id <= _MAX_SAFE:  # type: ignore[operator]
        raise InvalidInputError("id", "id must be a positive integer note id")
    return id  # type: ignore[return-value]


def _bearer_param(bearer: object) -> str:
    """Never echoes the value: a malformed bearer may be a secret with a stray character."""
    if not isinstance(bearer, str) or _BEARER.fullmatch(bearer) is None:
        raise InvalidInputError("bearer", "bearer is not a session token")
    return bearer


def _bool_param(field: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise InvalidInputError(field, f"{field} must be True or False")
    return value


def check_body(body: str) -> str:
    """A note body as the API will store it: control and format characters and line or paragraph separators removed,
    trimmed, 1 to 280 characters (code points). Raises InvalidInputError('body') otherwise. The API also refuses links
    and addresses. A lone surrogate becomes U+FFFD, as the API's JSON decoder makes it."""
    refused = InvalidInputError("body", f"a note body must be 1 to {_NOTE_MAX} characters")
    if not isinstance(body, str):
        raise refused
    clean = "".join(
        "\ufffd" if cat == "Cs" else ch
        for ch, cat in ((ch, unicodedata.category(ch)) for ch in body)
        if cat not in _STRIPPED
    ).strip()
    if not 1 <= len(clean) <= _NOTE_MAX:
        raise refused
    return clean


def _is_side(v: object) -> bool:
    return v in ("bullish", "bearish")


def _is_note(v: object) -> bool:
    return (
        isinstance(v, dict)
        and _is_count(v.get("id"))
        and v["id"] > 0
        and _is_addr(v.get("address"))
        and _is_side(v.get("side"))
        and "holdBps" in v
        and (v["holdBps"] is None or _is_count(v["holdBps"]))
        and isinstance(v.get("body"), str)
        and len(v["body"]) <= _NOTE_MAX
        and _is_count(v.get("createdAt"))
        and ("replyCount" not in v or _is_count(v["replyCount"]))
        and _is_count(v.get("agreeCount"))
        and isinstance(v.get("agreed"), bool)
        and isinstance(v.get("agent"), bool)
    )


def _is_notes_page(v: object) -> bool:
    if not isinstance(v, dict) or not isinstance(v.get("notes"), list) or "nextCursor" not in v:
        return False
    nxt = v["nextCursor"]
    return (
        len(v["notes"]) <= _MAX_PAGE
        and all(_is_note(n) for n in v["notes"])
        and (
            nxt is None
            or (
                isinstance(nxt, str)
                and len(nxt) <= MAX_CURSOR
                and _CURSOR.fullmatch(nxt) is not None
            )
        )
    )


def _is_mark(v: object) -> bool:
    return (
        isinstance(v, dict)
        and _is_count(v.get("id"))
        and v["id"] > 0
        and _is_count(v.get("createdAt"))
        and _is_side(v.get("side"))
        and isinstance(v.get("agent"), bool)
    )


def _is_reactions(v: object) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("counts"), dict)
        and all(_is_count(n) for n in v["counts"].values())
        and _is_count(v.get("total"))
        and _is_count(v.get("holders"))
        and "mine" in v
        and (v["mine"] is None or isinstance(v["mine"], str))
        and isinstance(v.get("selected"), list)
        and all(isinstance(k, str) for k in v["selected"])
        and isinstance(v.get("brandLookalike"), bool)
    )


def _is_posting(v: object) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("enabled"), bool)
        and "updatedAt" in v
        and (v["updatedAt"] is None or _is_count(v["updatedAt"]))
    )


def _no_constant(name: str) -> NoReturn:
    raise ValueError(name)


def _parse_base_url(base_url: object) -> str:
    if not isinstance(base_url, str) or url_host(base_url) is None:
        raise InvalidInputError("api_base_url", "the API base URL is not a valid URL")
    url = httpx.URL(base_url)
    if url.scheme != "https" and not (url.scheme == "http" and is_loopback_url(base_url)):
        raise InvalidInputError(
            "api_base_url", "the API base URL must use https (http is allowed for loopback only)"
        )
    if url.userinfo or "?" in base_url or "#" in base_url:
        raise InvalidInputError(
            "api_base_url", "the API base URL must not carry credentials, a query or a fragment"
        )
    return f"{url.scheme}://{url.netloc.decode('ascii')}{url.path}".rstrip("/")


class HttpApi:
    """httpx-based MercurifiApi. Sends `X-Api-Key` when given; never sends anything that could sign or move funds."""

    def __init__(
        self,
        base_url: str,
        chain_id: int,
        *,
        api_key: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
        on_warning: Any = None,
    ) -> None:
        self.base_url = _parse_base_url(base_url)
        if not _is_int(chain_id) or chain_id < 1:
            raise InvalidInputError("chain_id", "chain_id must be a positive integer")
        self.chain_id = chain_id
        if api_key is not None and (
            not isinstance(api_key, str) or _KEY.fullmatch(api_key) is None
        ):
            raise InvalidInputError(
                "api_key",
                "api_key is malformed: expected 1-256 letters, digits, '_' or '-' (check for a stray newline or space)",
            )
        self._key = None if api_key is None else _Secret(api_key)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not 0 < timeout < math.inf
        ):
            raise InvalidInputError("timeout", "timeout must be a positive number (seconds)")
        self._timeout = float(timeout)
        self._warn = on_warning if callable(on_warning) else None
        install_log_redaction()
        self._http = httpx.AsyncClient(
            transport=transport, timeout=self._timeout, follow_redirects=False, trust_env=False
        )

    def __repr__(self) -> str:
        return f"HttpApi(base_url={self.base_url!r}, chain_id={self.chain_id}, api_key={'None' if self._key is None else '[redacted]'})"

    __str__ = __repr__

    def __reduce__(self) -> NoReturn:
        raise TypeError("HttpApi holds an API key and cannot be pickled")

    def _headers(
        self, extra: dict[str, str] | None = None, *, no_key: bool = False
    ) -> dict[str, str]:
        h = {
            "Accept": "application/json",
            "Accept-Encoding": "identity",
        }  # identity: the body cap then bounds memory
        if self._key is not None and not no_key:
            h["X-Api-Key"] = self._key.reveal()
        h.update(extra or {})
        return h

    async def _exchange(
        self,
        method: str,
        path: str,
        json_body: Any,
        files: Any,
        bearer: str | None = None,
        anonymous: bool = False,
    ) -> tuple[int, httpx.Headers, bytes]:
        # A bearer replaces the API key; sign-in (anonymous) sends neither.
        extra = {} if bearer is None else {"Authorization": f"Bearer {bearer}"}
        headers = self._headers(extra, no_key=bearer is not None or anonymous)
        async with self._http.stream(
            method, f"{self.base_url}{path}", headers=headers, json=json_body, files=files
        ) as response:
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                raise _bad(path, "too large")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise _bad(path, "too large")
                chunks.append(chunk)
            return response.status_code, response.headers, b"".join(chunks)

    async def _send(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        files: Any = None,
        bearer: str | None = None,
        anonymous: bool = False,
    ) -> tuple[Any, httpx.Headers]:
        """`bearer`: a social session's token, sent as Authorization and redacted from errors; the API key is left
        off. `anonymous` (sign-in): neither the API key nor Authorization is sent."""
        failure: tuple[str, str] | None = None
        status, headers, raw = 0, httpx.Headers(), b""
        try:
            status, headers, raw = await asyncio.wait_for(
                self._exchange(method, path, json_body, files, bearer, anonymous), self._timeout
            )
        except MercurifiError:
            raise
        except (asyncio.TimeoutError, httpx.TimeoutException):
            failure = ("timeout", f"timed out after {self._timeout:g} s")
        except Exception as exc:  # transport and anything else: the text may embed the URL, so it is redacted, first line only
            failure = (
                "network",
                f"{type(exc).__name__}: {first_line(self._keyless(str(exc), bearer))}",
            )
        # Raised outside the except block so the original exception (which embeds the URL) is not kept as context.
        if failure is not None:
            raise ApiError(
                0,
                failure[0],
                f"Request to {path} failed: {self._untrusted(failure[1], bearer)}",
                None,
            )
        body: Any = None
        if raw:
            try:
                body = json.loads(raw, parse_constant=_no_constant)
            except (ValueError, RecursionError):
                body = None
        if status < 200 or status >= 300:
            err = body.get("error") if isinstance(body, dict) else None
            # A server (or a proxy in front of it) may echo the request headers: the key is cut from its words first.
            code = err.get("code") if isinstance(err, dict) else None
            if isinstance(code, str) and self._keyless(code, bearer) != code:
                code = None
            said = err.get("message") if isinstance(err, dict) else None
            message = self._untrusted(said, bearer) if isinstance(said, str) else ""
            retry_raw = headers.get("Retry-After", "")
            retry = (
                float(retry_raw) if len(retry_raw) <= 20 and _RETRY.fullmatch(retry_raw) else 0.0
            )
            if 300 <= status < 400:
                raise ApiError(
                    status,
                    "redirect",
                    f"{path} answered with a redirect; redirects are never followed.",
                    None,
                )
            raise ApiError(
                status,
                code if isinstance(code, str) and _API_CODE.fullmatch(code) else "http_error",
                message or f"HTTP {status} from {path}",
                min(retry, 3600.0) if retry > 0 else None,
            )
        return body, headers

    def _keyless(self, text: str, bearer: str | None = None) -> str:
        """Text with every occurrence of the API key and the request's bearer replaced, so no error can carry them."""
        for secret in (None if self._key is None else self._key.reveal(), bearer):
            # An empty needle would splice the marker between every character.
            if secret:
                text = text.replace(secret, "[redacted]")
        return text

    def _untrusted(self, text: str, bearer: str | None = None) -> str:
        """Server or transport text made safe to show: secrets cut, control and format characters removed, then
        secrets cut again (a secret split by a zero-width character is whole once it is removed), and only then
        bounded. The body cap bounds the first, unbounded pass."""
        return clean_text(self._keyless(neutralize_untrusted(self._keyless(text, bearer)), bearer))

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        files: Any = None,
        bearer: str | None = None,
        anonymous: bool = False,
    ) -> Any:
        return (
            await self._send(
                method, path, json_body=json_body, files=files, bearer=bearer, anonymous=anonymous
            )
        )[0]

    async def _page(self, path: str, valid: Any, sent: str | None = None) -> dict[str, Any]:
        """A list endpoint: a JSON array, with the next page's cursor in the Next-Cursor header."""
        body, headers = await self._send("GET", path)
        if not isinstance(body, list):
            raise _bad(path, "not a list")
        if len(body) > MAX_ITEMS:
            raise _bad(path, "too many items")
        if not all(valid(item) for item in body):
            raise _bad(path, "an item has the wrong shape")
        nxt = headers.get("Next-Cursor")
        if nxt is None or nxt == "":
            return {"items": body, "nextCursor": None}
        if len(nxt) > MAX_CURSOR or _CURSOR.fullmatch(nxt) is None:
            raise _bad(path, "bad cursor")
        if nxt == sent:
            raise _bad(path, "the cursor did not advance")
        return {"items": body, "nextCursor": nxt}

    async def get_account(self, account: str, *, live: bool = False) -> dict[str, Any]:
        a = _address_param("account", account)
        path = f"/v1/agent-accounts/{a}{'?live=1' if live is True else ''}"
        body = await self._request("GET", path)
        if (
            not isinstance(body, dict)
            or not _is_addr(body.get("account"))
            or body["account"].lower() != a
        ):
            raise _bad(path, "not the requested account")
        for k in ("owner", "referrer", "factory"):
            if k in body and not _is_addr(body[k]):
                raise _bad(path, f"{k} is not an address")
        return body

    async def list_accounts(self, owner: str) -> list[dict[str, Any]]:
        """Follows Next-Cursor up to MAX_LIST_PAGES pages and warns when the list was cut short."""
        base = f"/v1/agent-accounts?owner={_address_param('owner', owner)}"
        out: list[dict[str, Any]] = []
        cursor: str | None = None

        def valid(v: object) -> bool:
            return (
                isinstance(v, dict)
                and _is_addr(v.get("account"))
                and ("owner" not in v or _is_addr(v["owner"]))
            )

        for _ in range(MAX_LIST_PAGES):
            page = await self._page(
                base if cursor is None else f"{base}&cursor={urlquote(cursor, safe='')}",
                valid,
                cursor,
            )
            out.extend(page["items"])
            if page["nextCursor"] is None:
                return out
            cursor = page["nextCursor"]
        if self._warn is not None:
            self._warn(
                f"The account list was cut off after {MAX_LIST_PAGES} pages; more accounts exist than were returned."
            )
        return out

    async def list_actions(self, account: str, cursor: str | None = None) -> dict[str, Any]:
        q = "" if cursor is None else f"?cursor={urlquote(_cursor_param(cursor), safe='')}"

        def valid(v: object) -> bool:
            return (
                isinstance(v, dict)
                and isinstance(v.get("id"), str)
                and ("token" not in v or _is_addr(v["token"]))
            )

        return await self._page(
            f"/v1/agent-accounts/{_address_param('account', account)}/actions{q}", valid, cursor
        )

    async def quote(self, kind: str, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(kind, str) or kind not in QUOTE_KINDS:
            raise InvalidInputError("kind", "unknown quote kind")
        path = f"/v1/quote/{kind}"
        answer = await self._request("POST", path, json_body=body)
        if not isinstance(answer, dict) or answer.get("advisory") is not True:
            raise _bad(path, "not an advisory quote")
        return answer

    async def build_tx(self, body: dict[str, Any]) -> dict[str, Any]:
        path = "/v1/tx/build"
        r = await self._request("POST", path, json_body=body)
        if (
            not isinstance(r, dict)
            or not _is_int(r.get("chainId"))
            or not _is_addr(r.get("to"))
            or not isinstance(r.get("data"), str)
            or _HEX.fullmatch(r["data"]) is None
            or not isinstance(r.get("value"), str)
            or _DECIMAL.fullmatch(r["value"]) is None
        ):
            raise _bad(path, "not a transaction")
        selector = r.get("selector")
        if "selector" in r and not (isinstance(selector, str) and _SELECTOR.fullmatch(selector)):
            raise _bad(path, "bad selector")
        out: dict[str, Any] = {
            "chainId": r["chainId"],
            "to": r["to"],
            "data": r["data"],
            "value": r["value"],
        }
        if isinstance(r.get("function"), str):
            out["function"] = clean_text(r["function"], 64)
        if "selector" in r:
            out["selector"] = selector
        return out

    async def upload_launch_metadata(
        self, meta: dict[str, Any], image: Any = None
    ) -> dict[str, Any]:
        path = "/v1/uploads/launch-metadata"
        # Always multipart (the API reads a form): plain fields go in as (None, value) parts.
        files: dict[str, Any] = {"metadata": (None, json.dumps(meta))}
        if image is not None:
            if image.content_type not in ("image/png", "image/jpeg"):
                raise InvalidInputError("image", "image must be image/png or image/jpeg")
            default = "image.png" if image.content_type == "image/png" else "image.jpg"
            files["file"] = (image.filename or default, image.data, image.content_type)
        r = await self._request("POST", path, files=files)
        if not isinstance(r, dict) or not isinstance(r.get("metadataURI"), str):
            raise _bad(path, "no metadata URI")
        if "imageStatus" in r and r["imageStatus"] not in ("clean", "review"):
            raise _bad(path, "unknown image status")
        return {"metadataURI": r["metadataURI"], "imageStatus": r.get("imageStatus")}

    async def get_token(self, token: str) -> dict[str, Any] | None:
        t = _address_param("token", token)
        path = f"/v1/tokens/{t}"
        r = await self._request("GET", path)
        if r is None:
            return None
        if not isinstance(r, dict) or not _is_addr(r.get("address")) or r["address"].lower() != t:
            raise _bad(path, "not the requested token")
        return r

    async def sign_in_challenge(self, kind: str, account: str, signer: str) -> dict[str, Any]:
        if kind not in ("agent", "owner"):
            raise InvalidInputError("kind", "kind must be 'agent' or 'owner'")
        body = {
            "kind": kind,
            "account": _address_param("account", account),
            "signer": _address_param("signer", signer),
        }
        path = "/v1/agent-auth/nonce"
        r = await self._request("POST", path, json_body=body, anonymous=True)
        if (
            not isinstance(r, dict)
            or not isinstance(r.get("nonce"), str)
            or _NONCE.fullmatch(r["nonce"]) is None
            or not isinstance(r.get("message"), str)
            or len(r["message"]) > 1_024
            or not _is_count(r.get("issuedAt"))
            or not _is_count(r.get("expiresAt"))
        ):
            raise _bad(path, "not a sign-in challenge")
        return {
            "nonce": r["nonce"],
            "message": r["message"],
            "issuedAt": r["issuedAt"],
            "expiresAt": r["expiresAt"],
        }

    async def sign_in(self, nonce: str, signature_hex: str) -> dict[str, Any]:
        """The answer's `token` is a bearer: never log or serialise it."""
        if not isinstance(nonce, str) or _NONCE.fullmatch(nonce) is None:
            raise InvalidInputError("nonce", "nonce is not one the API issued")
        if not isinstance(signature_hex, str) or _SIGNATURE.fullmatch(signature_hex) is None:
            raise InvalidInputError("signature", "signature must be 65 bytes of hex")
        path = "/v1/agent-auth/session"
        r = await self._request(
            "POST", path, json_body={"nonce": nonce, "signature": signature_hex}, anonymous=True
        )
        if (
            not isinstance(r, dict)
            or not isinstance(r.get("token"), str)
            or _BEARER.fullmatch(r["token"]) is None
            or r.get("kind") not in ("agent", "owner")
            or not _is_addr(r.get("account"))
            or not _is_count(r.get("expiresAt"))
        ):
            raise _bad(path, "not a session")
        return {
            "token": r["token"],
            "kind": r["kind"],
            "account": r["account"],
            "expiresAt": r["expiresAt"],
        }

    async def sign_out(self, bearer: str) -> None:
        await self._request("DELETE", "/v1/agent-auth/session", bearer=_bearer_param(bearer))

    async def list_notes(
        self, token: str, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        path = f"/v1/tokens/{_address_param('token', token)}/notes{_page_query(cursor, limit)}"
        r = await self._request("GET", path)
        if not _is_notes_page(r):
            raise _bad(path, "not a page of notes")
        return r  # type: ignore[no-any-return]

    async def list_replies(
        self, id: int, *, cursor: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        path = f"/v1/notes/{_note_id(id)}/replies{_page_query(cursor, limit)}"
        r = await self._request("GET", path)
        if not _is_notes_page(r):
            raise _bad(path, "not a page of replies")
        return r  # type: ignore[no-any-return]

    async def get_note(self, id: int) -> dict[str, Any]:
        path = f"/v1/notes/{_note_id(id)}"
        r = await self._request("GET", path)
        if not _is_note(r) or r["id"] != id:
            raise _bad(path, "not the requested note")
        return r  # type: ignore[no-any-return]

    async def note_marks(self, token: str, start: int, end: int) -> list[dict[str, Any]]:
        """`start` and `end` are unix seconds, 0 <= start <= end, at most 90 days apart (InvalidInputError otherwise)."""
        if not _is_int(start) or not 0 <= start <= _MAX_SAFE:
            raise InvalidInputError("start", "start must be unix seconds, 0 or more")
        if not _is_int(end) or not start <= end <= _MAX_SAFE:
            raise InvalidInputError("end", "end must be unix seconds, not before start")
        if end - start > _MARKS_SPAN:
            raise InvalidInputError("end", "end must be at most 90 days after start")
        path = f"/v1/tokens/{_address_param('token', token)}/notes/marks?from={start}&to={end}"
        r = await self._request("GET", path)
        if not isinstance(r, list) or len(r) > _MAX_MARKS or not all(_is_mark(m) for m in r):
            raise _bad(path, "not a list of marks")
        return r

    async def get_reactions(self, token: str) -> dict[str, Any]:
        path = f"/v1/tokens/{_address_param('token', token)}/reactions"
        r = await self._request("GET", path)
        if not _is_reactions(r):
            raise _bad(path, "not reactions")
        return r  # type: ignore[no-any-return]

    async def put_reaction(
        self, token: str, key: str | None, bearer: str, active: bool | None = None
    ) -> None:
        """`key=None` clears every reaction; `active=False` clears that one key only."""
        if key is not None and (not isinstance(key, str) or _REACTION_KEY.fullmatch(key) is None):
            raise InvalidInputError("key", "key is not a reaction name")
        if active is not None and (not isinstance(active, bool) or key is None):
            raise InvalidInputError("active", "active must be True or False, with a key")
        path = f"/v1/tokens/{_address_param('token', token)}/reactions"
        body: dict[str, Any] = {"key": key} if active is None else {"key": key, "active": active}
        await self._request("PUT", path, json_body=body, bearer=_bearer_param(bearer))

    async def post_note(self, token: str, body: str, bearer: str) -> dict[str, Any]:
        path = f"/v1/tokens/{_address_param('token', token)}/notes"
        r = await self._request(
            "POST", path, json_body={"body": body}, bearer=_bearer_param(bearer)
        )
        if not _is_note(r):
            raise _bad(path, "not a note")
        return r  # type: ignore[no-any-return]

    async def post_reply(self, id: int, body: str, bearer: str) -> dict[str, Any]:
        path = f"/v1/notes/{_note_id(id)}/replies"
        r = await self._request(
            "POST", path, json_body={"body": body}, bearer=_bearer_param(bearer)
        )
        if not _is_note(r):
            raise _bad(path, "not a reply")
        return r  # type: ignore[no-any-return]

    async def agree(self, id: int, active: bool, bearer: str) -> None:
        body = {"active": _bool_param("active", active)}
        path = f"/v1/notes/{_note_id(id)}/agree"
        await self._request("PUT", path, json_body=body, bearer=_bearer_param(bearer))

    async def report(self, id: int, bearer: str) -> None:
        path = f"/v1/notes/{_note_id(id)}/report"
        await self._request("POST", path, bearer=_bearer_param(bearer))

    async def delete_note(self, id: int, bearer: str) -> None:
        await self._request("DELETE", f"/v1/notes/{_note_id(id)}", bearer=_bearer_param(bearer))

    async def get_posting(self, account: str) -> dict[str, Any]:
        path = f"/v1/agent-accounts/{_address_param('account', account)}/posting"
        r = await self._request("GET", path)
        if not _is_posting(r):
            raise _bad(path, "not a posting switch")
        return r  # type: ignore[no-any-return]

    async def set_posting(self, account: str, enabled: bool, bearer: str) -> dict[str, Any]:
        body = {"enabled": _bool_param("enabled", enabled)}
        path = f"/v1/agent-accounts/{_address_param('account', account)}/posting"
        r = await self._request("PUT", path, json_body=body, bearer=_bearer_param(bearer))
        if not _is_posting(r):
            raise _bad(path, "not a posting switch")
        return r  # type: ignore[no-any-return]

    async def delete_agent_notes(self, account: str, bearer: str) -> dict[str, Any]:
        path = f"/v1/agent-accounts/{_address_param('account', account)}/notes"
        r = await self._request("DELETE", path, bearer=_bearer_param(bearer))
        if not isinstance(r, dict) or not _is_count(r.get("deleted")):
            raise _bad(path, "not a delete count")
        return {"deleted": r["deleted"]}

    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
        """The returned headers contain the API key: pass them to the stream client and never log or serialise them."""
        return (
            f"{self.base_url}/v1/stream?topics={','.join(urlquote(t, safe='') for t in topics)}",
            self._headers(),
        )

    async def aclose(self) -> None:
        await self._http.aclose()
