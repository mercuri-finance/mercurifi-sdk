import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_pyproject.py"
GOOD = '"eth-account>=0.13.4,<0.14", "eth-abi>=5.1.0,<6", "eth-utils>=5.0.0,<6", "httpx>=0.28.1,<0.29"'


def run(tmp_path: Path, deps: str, extra: str = "", project_extra: str = "") -> subprocess.CompletedProcess[str]:
    f = tmp_path / "pyproject.toml"
    f.write_text(f'[project]\nname = "x"\nversion = "1"\n{project_extra}\ndependencies = [{deps}]\n{extra}\n')
    return subprocess.run([sys.executable, str(SCRIPT), str(f)], capture_output=True, text=True)


def test_accepts_good(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD).returncode == 0


def test_accepts_real_pyproject() -> None:
    assert subprocess.run([sys.executable, str(SCRIPT)], capture_output=True).returncode == 0


def test_rejects_extra_package_on_one_line(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD + ', "evil-pkg"').returncode != 0
    assert run(tmp_path, GOOD.replace('"httpx>=0.28.1,<0.29"', '"httpx>=0.28.1,<0.29", "evil-pkg"')).returncode != 0


@pytest.mark.parametrize("old,new", [("<0.29", "<1"), (">=0.28.1,<0.29", ""), ("eth-abi>=5.1.0", "eth-abi>=1.0.0")])
def test_rejects_widened_specifiers(tmp_path: Path, old: str, new: str) -> None:
    assert run(tmp_path, GOOD.replace(old, new, 1)).returncode != 0


def test_rejects_optional_dependencies(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD, extra='[project.optional-dependencies]\nx = ["web3"]').returncode != 0


def test_rejects_dynamic_dependencies(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD, project_extra='dynamic = ["dependencies"]').returncode != 0
