import pickle

import pytest

from mercurifi import errors as E

CASES: list[E.MercurifiError] = [
    E.MercurifiError("m", code="X"),
    E.InvalidInputError("f", "bad"),
    E.NetworkMismatchError("n"),
    E.NotDeployedError("arc"),
    E.NotOwnerError("o"),
    E.GasPriceTooHighError(5, 3),
    E.TxDroppedError("0xab", 30),
    E.ApiError(429, "rate", "slow", 2.5),
    E.BuildMismatchError("to differs"),
    E.StreamError("s", None),
]


@pytest.mark.parametrize("err", CASES, ids=lambda e: type(e).__name__)
def test_pickle_round_trip(err: E.MercurifiError) -> None:
    back = pickle.loads(pickle.dumps(err))
    assert type(back) is type(err)
    assert str(back) == str(err) and back.code == err.code and back.__dict__ == err.__dict__


def test_tx_dropped_seconds_format() -> None:
    assert "after 30 s." in str(E.TxDroppedError("0x1", 30.0))
    assert "after 2.5 s." in str(E.TxDroppedError("0x1", 2.5))
