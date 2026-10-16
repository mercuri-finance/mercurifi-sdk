import json
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from mercurifi.errors import SignInRefusedError
from mercurifi.signin import SignInExpect, build_sign_in_message, check_sign_in_message

VECTORS: list[dict[str, Any]] = json.loads(
    (Path(__file__).parents[3] / "fixtures/vectors/agentsignin.json").read_text()
)


def _expect(v: dict[str, Any]) -> SignInExpect:
    return SignInExpect(v["kind"], v["account"], v["signer"], v["chainId"], v["service"])


def _at(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _refused(v: dict[str, Any], message: str, now: float) -> SignInRefusedError:
    with pytest.raises(SignInRefusedError) as err:
        check_sign_in_message(_expect(v), v["nonce"], message, now)
    return err.value


def test_matches_the_shared_vectors() -> None:
    for v in VECTORS:
        built = build_sign_in_message(_expect(v), v["nonce"], _at(v["issued"]), _at(v["expires"]))
        assert built == v["message"]


def test_accepts_the_server_text_and_a_clock_up_to_two_minutes_off() -> None:
    v = VECTORS[0]
    e, issued = _expect(v), _at(v["issued"]).timestamp()
    check_sign_in_message(e, v["nonce"], v["message"], issued)
    check_sign_in_message(e, v["nonce"], v["message"], issued + 90)
    check_sign_in_message(e, v["nonce"], v["message"], issued - 90)


def test_refuses_text_it_did_not_build_and_a_clock_far_off() -> None:
    v = VECTORS[0]
    issued = _at(v["issued"]).timestamp()
    m = v["message"]
    for message in [
        m.replace("launch", "trade"),
        m + "\nTransfer: everything",
        m.rsplit("\n", 1)[0],
        m.replace(v["nonce"], "f" * 32),
    ]:
        assert _refused(v, message, issued).reason == "text"
    far = _refused(v, m, issued + 600)
    assert far.reason == "clock"
    assert "Issued is more than two minutes" in far.message


def test_refuses_a_nonce_field_that_differs_from_the_nonce() -> None:
    v = VECTORS[0]
    with pytest.raises(SignInRefusedError) as err:
        check_sign_in_message(_expect(v), "f" * 32, v["message"], _at(v["issued"]).timestamp())
    assert err.value.reason == "text"
    with pytest.raises(SignInRefusedError) as bad:
        check_sign_in_message(_expect(v), "nope", v["message"], _at(v["issued"]).timestamp())
    assert bad.value.reason == "text"


def test_names_which_bound_of_the_window_failed() -> None:
    v = VECTORS[0]
    issued = _at(v["issued"]).timestamp()
    m = v["message"]
    long = _refused(v, m.replace("12:05:00Z", "13:00:00Z"), issued)
    assert long.reason == "window"
    assert "longer than five minutes" in long.message
    for end in ("12:00:00Z", "11:59:00Z"):
        short = _refused(v, m.replace("12:05:00Z", end), issued)
        assert short.reason == "window"
        assert "too short or not positive" in short.message
    stale = _refused(v, m, issued + 5 * 60 + 130)
    assert stale.reason == "clock"
    assert "Issued is more than two minutes" in stale.message


def test_accepts_a_short_window_when_the_local_clock_runs_90_s_fast() -> None:
    v = VECTORS[0]
    short = v["message"].replace("12:05:00Z", "12:00:30Z")
    check_sign_in_message(_expect(v), v["nonce"], short, _at(v["issued"]).timestamp() + 90)


def test_refuses_an_expired_sign_in_by_more_than_the_skew() -> None:
    v = VECTORS[0]
    short = v["message"].replace("12:05:00Z", "12:00:30Z")
    # Issued is within skew of now, so only the Expires bound can fail: it cannot with a 30 s window,
    # hence the clock check on Issued is what refuses a stale text.
    err = _refused(v, short, _at(v["issued"]).timestamp() + 200)
    assert err.reason == "clock"


def test_refuses_a_time_that_looks_right_but_is_not_a_real_date() -> None:
    v = VECTORS[0]
    bad = v["message"].replace("2026-10-16T12:00:00Z", "2026-13-01T00:00:00Z")
    assert _refused(v, bad, _at(v["issued"]).timestamp()).reason == "text"


def test_the_error_survives_pickling() -> None:
    err = pickle.loads(pickle.dumps(SignInRefusedError("clock", "x")))
    assert (err.reason, err.code, str(err)) == ("clock", "SIGN_IN_REFUSED", "x")
