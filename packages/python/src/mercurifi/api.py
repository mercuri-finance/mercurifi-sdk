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
from typing import Any, NoReturn, Protocol
from urllib.parse import quote as urlquote

import httpx

from .errors import ApiError, InvalidInputError, MercurifiError
from .networks import is_loopback_url, url_host
from .redact import first_line, install_log_redaction, neutralize_untrusted, pre_bound, truncate_chars

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
_API_CODE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_RETRY = re.compile(r"[0-9]+(?:\.[0-9]+)?")


class MercurifiApi(Protocol):
    """The SDK's only view of the HTTP API; HttpApi implements it and tests substitute fakes."""

    base_url: str
    chain_id: int

    async def get_account(self, account: str, *, live: bool = False) -> dict[str, Any]: ...
    async def list_accounts(self, owner: str) -> list[dict[str, Any]]: ...
    async def list_actions(self, account: str, cursor: str | None = None) -> dict[str, Any]: ...
    async def quote(self, kind: str, body: dict[str, Any]) -> dict[str, Any]: ...
    async def build_tx(self, body: dict[str, Any]) -> dict[str, Any]: ...
    async def upload_launch_metadata(self, meta: dict[str, Any], image: Any = None) -> dict[str, Any]: ...
    async def get_token(self, token: str) -> dict[str, Any] | None: ...
    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]: ...


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
    return MercurifiError(f"The API answered {path} with something unexpected ({what}); it was ignored.", code="API_BAD_RESPONSE")


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


def _no_constant(name: str) -> NoReturn:
    raise ValueError(name)


def _parse_base_url(base_url: object) -> str:
    if not isinstance(base_url, str) or url_host(base_url) is None:
        raise InvalidInputError("api_base_url", "the API base URL is not a valid URL")
    url = httpx.URL(base_url)
    if url.scheme != "https" and not (url.scheme == "http" and is_loopback_url(base_url)):
        raise InvalidInputError("api_base_url", "the API base URL must use https (http is allowed for loopback only)")
    if url.userinfo or "?" in base_url or "#" in base_url:
        raise InvalidInputError("api_base_url", "the API base URL must not carry credentials, a query or a fragment")
    return f"{url.scheme}://{url.netloc.decode('ascii')}{url.path}".rstrip("/")


class HttpApi:
    """httpx-based MercurifiApi. Sends `X-Api-Key` when given; never sends anything that could sign or move funds."""

    def __init__(
        self, base_url: str, chain_id: int, *, api_key: str | None = None, transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0, on_warning: Any = None,
    ) -> None:
        self.base_url = _parse_base_url(base_url)
        if not _is_int(chain_id) or chain_id < 1:
            raise InvalidInputError("chain_id", "chain_id must be a positive integer")
        self.chain_id = chain_id
        if api_key is not None and (not isinstance(api_key, str) or api_key.strip(" \t\r\n") == ""):
            raise InvalidInputError("api_key", "api_key is empty")
        self._key = None if api_key is None else _Secret(api_key)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout < math.inf:
            raise InvalidInputError("timeout", "timeout must be a positive number (seconds)")
        self._timeout = float(timeout)
        self._warn = on_warning if callable(on_warning) else None
        install_log_redaction()
        self._http = httpx.AsyncClient(transport=transport, timeout=self._timeout, follow_redirects=False)

    def __repr__(self) -> str:
        return f"HttpApi(base_url={self.base_url!r}, chain_id={self.chain_id}, api_key={'None' if self._key is None else '[redacted]'})"

    __str__ = __repr__

    def __reduce__(self) -> NoReturn:
        raise TypeError("HttpApi holds an API key and cannot be pickled")

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self._key is not None:
            h["X-Api-Key"] = self._key.reveal()
        h.update(extra or {})
        return h

    async def _exchange(self, method: str, path: str, json_body: Any, files: Any) -> tuple[int, httpx.Headers, bytes]:
        async with self._http.stream(method, f"{self.base_url}{path}", headers=self._headers(), json=json_body, files=files) as response:
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

    async def _send(self, method: str, path: str, *, json_body: Any = None, files: Any = None) -> tuple[Any, httpx.Headers]:
        failure: tuple[str, str] | None = None
        status, headers, raw = 0, httpx.Headers(), b""
        try:
            status, headers, raw = await asyncio.wait_for(self._exchange(method, path, json_body, files), self._timeout)
        except MercurifiError:
            raise
        except (asyncio.TimeoutError, httpx.TimeoutException):
            failure = ("timeout", f"timed out after {self._timeout:g} s")
        except Exception as exc:  # transport and anything else: the text may embed the URL, so it is redacted, first line only
            failure = ("network", f"{type(exc).__name__}: {first_line(str(exc))}")
        # Raised outside the except block so the original exception (which embeds the URL) is not kept as context.
        if failure is not None:
            raise ApiError(0, failure[0], f"Request to {path} failed: {clean_text(failure[1])}", None)
        body: Any = None
        if raw:
            try:
                body = json.loads(raw, parse_constant=_no_constant)
            except (ValueError, RecursionError):
                body = None
        if status < 200 or status >= 300:
            err = body.get("error") if isinstance(body, dict) else None
            code = err.get("code") if isinstance(err, dict) else None
            message = clean_text(err.get("message")) if isinstance(err, dict) else ""
            retry_raw = headers.get("Retry-After", "")
            retry = float(retry_raw) if len(retry_raw) <= 20 and _RETRY.fullmatch(retry_raw) else 0.0
            if 300 <= status < 400:
                raise ApiError(status, "redirect", f"{path} answered with a redirect; redirects are never followed.", None)
            raise ApiError(
                status, code if isinstance(code, str) and _API_CODE.fullmatch(code) else "http_error",
                message or f"HTTP {status} from {path}", min(retry, 3600.0) if retry > 0 else None,
            )
        return body, headers

    async def _request(self, method: str, path: str, *, json_body: Any = None, files: Any = None) -> Any:
        return (await self._send(method, path, json_body=json_body, files=files))[0]

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
        if not isinstance(body, dict) or not _is_addr(body.get("account")) or body["account"].lower() != a:
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
            return isinstance(v, dict) and _is_addr(v.get("account")) and ("owner" not in v or _is_addr(v["owner"]))

        for _ in range(MAX_LIST_PAGES):
            page = await self._page(base if cursor is None else f"{base}&cursor={urlquote(cursor, safe='')}", valid, cursor)
            out.extend(page["items"])
            if page["nextCursor"] is None:
                return out
            cursor = page["nextCursor"]
        if self._warn is not None:
            self._warn(f"The account list was cut off after {MAX_LIST_PAGES} pages; more accounts exist than were returned.")
        return out

    async def list_actions(self, account: str, cursor: str | None = None) -> dict[str, Any]:
        q = "" if cursor is None else f"?cursor={urlquote(_cursor_param(cursor), safe='')}"

        def valid(v: object) -> bool:
            return isinstance(v, dict) and isinstance(v.get("id"), str) and ("token" not in v or _is_addr(v["token"]))

        return await self._page(f"/v1/agent-accounts/{_address_param('account', account)}/actions{q}", valid, cursor)

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
            not isinstance(r, dict) or not _is_int(r.get("chainId")) or not _is_addr(r.get("to"))
            or not isinstance(r.get("data"), str) or _HEX.fullmatch(r["data"]) is None
            or not isinstance(r.get("value"), str) or _DECIMAL.fullmatch(r["value"]) is None
        ):
            raise _bad(path, "not a transaction")
        selector = r.get("selector")
        if "selector" in r and not (isinstance(selector, str) and _SELECTOR.fullmatch(selector)):
            raise _bad(path, "bad selector")
        out: dict[str, Any] = {"chainId": r["chainId"], "to": r["to"], "data": r["data"], "value": r["value"]}
        if isinstance(r.get("function"), str):
            out["function"] = clean_text(r["function"], 64)
        if "selector" in r:
            out["selector"] = selector
        return out

    async def upload_launch_metadata(self, meta: dict[str, Any], image: Any = None) -> dict[str, Any]:
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

    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
        """The returned headers contain the API key: pass them to the stream client and never log or serialise them."""
        return f"{self.base_url}/v1/stream?topics={','.join(urlquote(t, safe='') for t in topics)}", self._headers()

    async def aclose(self) -> None:
        await self._http.aclose()

