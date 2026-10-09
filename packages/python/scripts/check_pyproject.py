"""Fails when the package's runtime dependencies differ from the exact approved specifiers.

Usage: python scripts/check_pyproject.py [path/to/pyproject.toml]
"""
import re
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib  # type: ignore[no-redef]

EXPECTED = {
    "eth-account": ">=0.13.4,<0.14",
    "eth-abi": ">=5.1.0,<6",
    "eth-utils": ">=5.0.0,<6",
    "httpx": ">=0.28.1,<0.29",
}

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "pyproject.toml"
project = tomllib.loads(path.read_text()).get("project", {})
problems: list[str] = []

deps = project.get("dependencies")
if not isinstance(deps, list):
    sys.exit("project.dependencies must be a list")
found: dict[str, str] = {}
for raw in deps:
    m = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$", str(raw))
    if m is None:
        problems.append(f"unparseable dependency: {raw!r}")
        continue
    name = m.group(1).lower().replace("_", "-")
    if name in found:
        problems.append(f"duplicate dependency: {name}")
    found[name] = re.sub(r"\s+", "", m.group(2))
if found != EXPECTED:
    problems.append(f"runtime dependencies must be exactly {EXPECTED}; found {found}")
if "optional-dependencies" in project:
    problems.append("optional-dependencies are not allowed")
if "dependencies" in project.get("dynamic", []):
    problems.append("dependencies must not be dynamic")
if problems:
    sys.exit("\n".join(problems))
print("pyproject policy ok")
