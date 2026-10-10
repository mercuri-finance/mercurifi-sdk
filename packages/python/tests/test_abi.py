import hashlib
import json
from pathlib import Path

ABI_DIR = Path(__file__).resolve().parent.parent / "src" / "mercurifi" / "abi"
ROOT = Path(__file__).resolve().parents[3]


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def test_python_abis_match_the_shared_digest() -> None:
    entries = sorted(
        (p.stem, json.loads(p.read_text()))
        for p in ABI_DIR.glob("*.json")
        if not p.stem.startswith("_")
    )
    payload = "".join(f"{name}\n{canonical(abi)}\n" for name, abi in entries)
    digest = hashlib.sha256(payload.encode()).hexdigest()
    shared = json.loads((ROOT / "fixtures" / "abi-digest.json").read_text())
    assert digest == shared["digest"]
    assert {name for name, _ in entries} == set(shared["names"])
    assert "agentPolicyRegistry" in shared["names"]
    assert len(shared["names"]) == 11
