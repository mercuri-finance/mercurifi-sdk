from __future__ import annotations

from .errors import InvalidInputError
from .rpc import Rpc


async def chain_deadline(rpc: Rpc, max_deadline_seconds: int, wanted: int) -> int:
    """A deadline from the latest block's timestamp, never the local clock."""
    window = min(wanted, max_deadline_seconds)
    if isinstance(window, bool) or not isinstance(window, int) or window < 1:
        raise InvalidInputError("deadline_seconds", "the deadline window must be at least 1 second")
    return await rpc.latest_timestamp() + window
