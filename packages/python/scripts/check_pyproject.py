"""Fails when the package gains a runtime dependency beyond the four allowed ones."""
import re
import sys
from pathlib import Path

ALLOWED = {"eth-account", "eth-abi", "eth-utils", "httpx"}
text = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()
block = re.search(r"^dependencies = \[(.*?)\]", text, re.S | re.M)
if block is None:
    sys.exit("pyproject.toml has no dependencies block")
names = {re.split(r"[<>=!~ ]", d.strip().strip('",'))[0] for d in block.group(1).splitlines() if d.strip()}
if names != ALLOWED:
    sys.exit(f"runtime dependencies must be exactly {sorted(ALLOWED)}; found {sorted(names)}")
if re.search(r"^\s*web3", text, re.M):
    sys.exit("web3 is not allowed")
print("pyproject policy ok")
