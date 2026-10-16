"""A fake of the API's sign-in routes for SocialSession tests."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock

from mercurifi.signin import SignInExpect, build_sign_in_message

T0 = datetime(2026, 10, 16, 12, tzinfo=timezone.utc).timestamp()


class FakeSocialApi:
    """The challenge text is built from the (kind, account, signer) the session sends, on the fake's own chain_id,
    as the API does; each sign-in returns `bearer-<n>` for the n-th session. `now` is the fake's clock in epoch
    seconds; `expires_in` is the seconds from the clock at sign-in to the session's expiry."""

    def __init__(
        self,
        *,
        expires_in: float = 3600,
        chain_id: int = 5042002,
        service: str = "launch",
        now: Callable[[], float] = time.time,
    ) -> None:
        self.chain_id, self._service = chain_id, service
        self._now, self._expires_in = now, expires_in
        self._challenges = self._sessions = 0
        self._last: tuple[str, str] = ("agent", "0x" + "0" * 40)
        self.messages: list[str] = []  # every challenge text issued, in order
        self.sign_in_challenge = AsyncMock(side_effect=self.challenge)
        self.sign_in = AsyncMock(side_effect=self.session)
        self.sign_out = AsyncMock(return_value=None)

    async def challenge(self, kind: str, account: str, signer: str) -> dict[str, Any]:
        self._challenges += 1
        self._last = (kind, account)
        nonce = format(self._challenges, "032x")
        t = int(self._now())
        e = SignInExpect(kind, account, signer, self.chain_id, self._service)  # type: ignore[arg-type]
        issued = datetime.fromtimestamp(t, timezone.utc)
        expires = datetime.fromtimestamp(t + 300, timezone.utc)
        self.messages.append(build_sign_in_message(e, nonce, issued, expires))
        return {
            "nonce": nonce,
            "message": self.messages[-1],
            "issuedAt": t,
            "expiresAt": t + 300,
        }

    async def session(self, nonce: str, signature_hex: str) -> dict[str, Any]:
        self._sessions += 1
        return {
            "token": f"bearer-{self._sessions}",
            "kind": self._last[0],
            "account": self._last[1],
            "expiresAt": int(self._now() + self._expires_in),
        }


NOTE: dict[str, Any] = {
    "id": 7,
    "address": "0x" + "00" * 19 + "aa",
    "side": "bullish",
    "holdBps": None,
    "body": "volume picking up",
    "createdAt": 1_790_000_000,
    "replyCount": 0,
    "agreeCount": 0,
    "agreed": False,
    "agent": True,
}


def page(n: int) -> dict[str, Any]:
    return {"notes": [{**NOTE, "id": n}], "nextCursor": None}


class FakeNotesApi(FakeSocialApi):
    """The sign-in fake plus every social route as an AsyncMock, and a stream request (for client tests)."""

    def __init__(self, **kw: Any) -> None:
        super().__init__(**kw)
        self.base_url = "http://127.0.0.1:9"
        self.put_reaction = AsyncMock(return_value=None)
        self.post_note = AsyncMock(side_effect=lambda token, body, b: {**NOTE, "body": body})
        self.post_reply = AsyncMock(
            side_effect=lambda id, body, b: {**NOTE, "id": id + 1, "body": body}
        )
        self.agree = AsyncMock(return_value=None)
        self.report = AsyncMock(return_value=None)
        self.delete_note = AsyncMock(return_value=None)
        self.list_notes = AsyncMock(return_value=page(1))
        self.list_replies = AsyncMock(return_value=page(2))
        self.get_note = AsyncMock(return_value=NOTE)
        self.note_marks = AsyncMock(return_value=[])
        self.get_reactions = AsyncMock(
            return_value={
                "counts": {"bullish": 1},
                "total": 1,
                "holders": 1,
                "mine": None,
                "selected": [],
                "brandLookalike": False,
            }
        )
        self.get_posting = AsyncMock(return_value={"enabled": True, "updatedAt": None})
        self.set_posting = AsyncMock(
            side_effect=lambda account, enabled, b: {"enabled": enabled, "updatedAt": 1}
        )
        self.delete_agent_notes = AsyncMock(return_value={"deleted": 3})
        self.topics: list[list[str]] = []

    def stream_request(self, topics: list[str]) -> tuple[str, dict[str, str]]:
        self.topics.append(list(topics))
        return f"{self.base_url}/v1/stream?topics={','.join(topics)}", {}
