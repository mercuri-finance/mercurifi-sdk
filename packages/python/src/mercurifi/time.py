from __future__ import annotations

from .errors import InvalidInputError
from .rpc import Rpc


async def chain_deadline(rpc: Rpc, max_deadline_seconds: int, wanted: int) -> int:
    """A deadline from the latest block's timestamp, never the local clock."""
    for field, value in (("max_deadline_seconds", max_deadline_seconds), ("deadline_seconds", wanted)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise InvalidInputError(field, f"{field} must be an integer of at least 1 second")
    window = min(wanted, max_deadline_seconds)
    return await rpc.latest_timestamp() + window
