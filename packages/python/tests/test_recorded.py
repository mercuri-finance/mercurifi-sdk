"""The TypeScript integration tier records real Anvil receipts and revert data (fixtures/recorded, RECORD=1); Python
decodes the same files and must reach exactly the values TypeScript recorded. Python never records: one recorder."""

import json
from pathlib import Path

import pytest

from mercurifi.fills import fill_from_receipt
from mercurifi.revert import decode_revert

DIR = Path(__file__).resolve().parents[3] / "fixtures" / "recorded"
FILES = sorted(DIR.glob("*.json"))
EXPECTED_FILES = {
    "fill-buy.json",
    "fill-launch.json",
    "fill-sell.json",
    "fill-sell-high-water.json",
    "revert-launch-limit.json",
    "revert-missing-permission.json",
    "revert-snipe.json",
    "revert-stale.json",
    "revert-trade-too-large.json",
}
REVERTS = [p for p in FILES if p.name.startswith("revert-")]
DECLARING = {"AgentAccount", "AgentPolicyRegistry", "AgentAccountFactory"}


def test_fixtures_exist() -> None:
    assert EXPECTED_FILES <= {p.name for p in FILES}


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_decodes_exactly_as_typescript(path: Path) -> None:
    r = json.loads(path.read_text())
    if r["kind"] == "fill":
        receipt = {
            **r["receipt"],
            "blockNumber": int(r["receipt"]["blockNumber"]),
            "gasUsed": int(r["receipt"]["gasUsed"]),
            "effectiveGasPrice": int(r["receipt"]["effectiveGasPrice"]),
        }
        f = fill_from_receipt(receipt, r["account"], r["launchFactory"])
        launched = (
            None if f.launched is None else {"token": f.launched.token, "curve": f.launched.curve}
        )
        got = {
            "action": f.action,
            "token": f.token,
            "usdcSpent6": str(f.usdc_spent6),
            "usdcReceived6": str(f.usdc_received6),
            "tokenDelta": str(f.token_delta),
            "basisValue6": str(f.basis_value6),
            "launched": launched,
        }
        assert got == r["expected"]
        assert f.tx_hash == r["receipt"]["transactionHash"]
    else:
        assert r["kind"] == "revert"
        d = decode_revert(r["data"])
        assert {"name": d.name, "message": d.message, "source": d.source} == r["expected"]


def test_every_recorded_revert_names_its_declaring_contract() -> None:
    # One call can revert from either agent ABI (plan "Interface dependencies"); the fixture records which one declared it.
    assert REVERTS
    for path in REVERTS:
        assert json.loads(path.read_text())["expected"].get("source") in DECLARING, path.name
