from __future__ import annotations

from .errors import GasPriceTooHighError, InvalidInputError

MIN_MAX_FEE_PER_GAS = (
    20_000_000_000  # Arc drops transactions under 20 gwei without a receipt (spec Q6)
)
# A buy that completes a curve graduates inline and needs >= 1M gas left at graduation (spec Q19, §4.11). Through the
# account the contracts measure >= ~1.3M call gas (contracts AgentGas.t.sol); the SDK keeps 1.8M as its floor for margin.
GRADUATION_GAS_LIMIT = 1_800_000
# Default ceiling on the priority fee the SDK will pay: a node quoting a runaway tip cannot drain the account's gas.
MAX_PRIORITY_FEE_PER_GAS = 100_000_000_000
_MARGIN_PERCENT = 120


def fees_with_floor(base_fee: int, priority: int, cap: int | None = None) -> tuple[int, int]:
    """(max_fee, max_priority): headroom for one base-fee doubling, never under Arc's floor, priority never above max.

    Raises GasPriceTooHighError when base_fee + priority exceeds `cap`, InvalidInputError when `cap` is under 20 gwei.
    """
    max_fee = max(base_fee * 2 + priority, MIN_MAX_FEE_PER_GAS)
    prio = min(priority, max_fee)
    if cap is not None:
        if cap < MIN_MAX_FEE_PER_GAS:
            raise InvalidInputError(
                "max_fee_per_gas_cap", "max_fee_per_gas_cap is below the Arc floor of 20 gwei"
            )
        required = base_fee + prio
        if required > cap:
            raise GasPriceTooHighError(required, cap)
        max_fee = min(max_fee, cap)
        prio = min(prio, max_fee)
    return max_fee, prio


def gas_limit_for(estimate: int, may_graduate: bool) -> int:
    """Estimate plus 20%; a buy that may complete the curve gets at least GRADUATION_GAS_LIMIT."""
    with_margin = estimate * _MARGIN_PERCENT // 100
    return max(with_margin, GRADUATION_GAS_LIMIT) if may_graduate else with_margin
