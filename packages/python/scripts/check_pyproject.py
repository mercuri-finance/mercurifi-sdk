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
data = tomllib.loads(path.read_text())
project = data.get("project", {})
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
build = data.get("build-system", {})
requires = build.get("requires")
if not (
    isinstance(requires, list)
    and len(requires) == 1
    and re.fullmatch(r"hatchling==\d+(\.\d+)*", re.sub(r"\s+", "", str(requires[0])))
):
    problems.append("build-system.requires must be exactly one pinned hatchling==X.Y.Z")
if build.get("build-backend") != "hatchling.build":
    problems.append("build-system.build-backend must be hatchling.build")
for key in ("scripts", "gui-scripts", "entry-points"):
    if key in project:
        problems.append(f"project.{key} is not allowed: the package installs no commands and no plugins")
for key in ("optional-dependencies", "scripts", "gui-scripts", "entry-points"):
    if key in project.get("dynamic", []):
        problems.append(f"project.{key} must not be dynamic")
if "allow-direct-references" in data.get("tool", {}).get("hatch", {}).get("metadata", {}):
    problems.append("tool.hatch.metadata.allow-direct-references is not allowed: dependencies come from the index only")
if problems:
    sys.exit("\n".join(problems))
print("pyproject policy ok")
