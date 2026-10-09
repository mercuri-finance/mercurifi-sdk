import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_pyproject.py"
GOOD = '"eth-account>=0.13.4,<0.14", "eth-abi>=5.1.0,<6", "eth-utils>=5.0.0,<6", "httpx>=0.28.1,<0.29"'


BUILD = '[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n'


def run(tmp_path: Path, deps: str, extra: str = "", project_extra: str = "", build: str = BUILD) -> subprocess.CompletedProcess[str]:
    f = tmp_path / "pyproject.toml"
    f.write_text(f'{build}\n[project]\nname = "x"\nversion = "1"\n{project_extra}\ndependencies = [{deps}]\n{extra}\n')
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


@pytest.mark.parametrize(
    "build",
    [
        "",
        '[build-system]\nrequires = ["hatchling>=1.27"]\nbuild-backend = "hatchling.build"\n',
        '[build-system]\nrequires = ["hatchling==1.27.0", "evil==1.0"]\nbuild-backend = "hatchling.build"\n',
        '[build-system]\nrequires = ["setuptools==75.0.0"]\nbuild-backend = "setuptools.build_meta"\n',
        '[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "evil.backend"\n',
    ],
)
def test_rejects_an_unpinned_or_foreign_build_system(tmp_path: Path, build: str) -> None:
    r = run(tmp_path, GOOD, build=build)
    assert r.returncode != 0
    assert "build-system" in r.stderr


@pytest.mark.parametrize(
    "table",
    ['[project.scripts]\nx = "m:f"', '[project.gui-scripts]\nx = "m:f"', '[project.entry-points."x.plugins"]\ny = "m:f"'],
)
def test_rejects_console_scripts_and_entry_points(tmp_path: Path, table: str) -> None:
    r = run(tmp_path, GOOD, extra=table)
    assert r.returncode != 0
    assert "not allowed" in r.stderr


def test_rejects_dynamic_entry_points(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD, project_extra='dynamic = ["scripts"]').returncode != 0


def test_rejects_direct_references(tmp_path: Path) -> None:
    r = run(tmp_path, GOOD, extra="[tool.hatch.metadata]\nallow-direct-references = true")
    assert r.returncode != 0
    assert "allow-direct-references" in r.stderr


def test_declares_tomli_for_python_310() -> None:
    if sys.version_info >= (3, 11):
        import tomllib
    else:  # Python 3.10
        import tomli as tomllib
    data = tomllib.loads((SCRIPT.parent.parent / "pyproject.toml").read_text())
    assert 'tomli==2.2.1; python_version < "3.11"' in data["dependency-groups"]["dev"]


@pytest.mark.parametrize(
    "table",
    [
        # Build hooks run arbitrary code at build time and can add files to the wheel.
        '[tool.hatch.build.hooks.custom]\npath = "hook.py"',
        '[tool.hatch.build.targets.wheel.hooks.custom]\npath = "hook.py"',
        '[tool.hatch.build.targets.sdist.hooks.vcs]\nversion-file = "v.py"',
        '[tool.hatch.metadata.hooks.custom]\npath = "meta.py"',
        # force-include and shared-data put files outside mercurifi/ (shared-data lands under *.data/ and is installed anywhere).
        '[tool.hatch.build.force-include]\n"../secret" = "mercurifi/secret"',
        '[tool.hatch.build.targets.wheel.force-include]\n"x.pth" = "x.pth"',
        '[tool.hatch.build.targets.sdist.force-include]\n"x" = "x"',
        '[tool.hatch.build.shared-data]\n"x" = "share/x"',
        '[tool.hatch.build.targets.wheel.shared-data]\n"x" = "share/x"',
        '[tool.hatch.build.targets.wheel.shared-scripts]\n"x" = "x"',
        # Per-target build dependencies would bypass the hashed build constraints.
        '[tool.hatch.build.targets.wheel]\ndependencies = ["evil==1.0"]',
    ],
)
def test_rejects_build_hooks_force_include_and_shared_data(tmp_path: Path, table: str) -> None:
    r = run(tmp_path, GOOD, extra=table)
    assert r.returncode != 0
    assert "not allowed" in r.stderr


def test_rejects_a_hatch_toml_next_to_the_pyproject(tmp_path: Path) -> None:
    (tmp_path / "hatch.toml").write_text('[build.hooks.custom]\npath = "hook.py"\n')
    r = run(tmp_path, GOOD)
    assert r.returncode != 0
    assert "hatch.toml" in r.stderr


def test_accepts_the_plain_wheel_packages_setting(tmp_path: Path) -> None:
    assert run(tmp_path, GOOD, extra='[tool.hatch.build.targets.wheel]\npackages = ["src/x"]').returncode == 0


# Two crafted pyproject files that once slipped past an earlier version of the gate.
def test_rejects_backend_path(tmp_path: Path) -> None:
    r = run(tmp_path, GOOD, build=BUILD + 'backend-path = ["shim"]\n')
    assert r.returncode != 0 and "backend-path" in r.stderr


def test_rejects_a_dynamic_version_from_code(tmp_path: Path) -> None:
    f = tmp_path / "pyproject.toml"
    f.write_text(f'{BUILD}\n[project]\nname = "x"\ndynamic = ["version"]\ndependencies = [{GOOD}]\n\n[tool.hatch.version]\nsource = "code"\npath = "evil.py"\n')
    r = subprocess.run([sys.executable, str(SCRIPT), str(f)], capture_output=True, text=True)
    assert r.returncode != 0
    assert "project.version must not be dynamic" in r.stderr
    assert "tool.hatch.version is not allowed" in r.stderr


def test_rejects_tool_hatch_version_alone(tmp_path: Path) -> None:
    r = run(tmp_path, GOOD, extra='[tool.hatch.version]\npath = "src/x/__init__.py"')
    assert r.returncode != 0 and "tool.hatch.version" in r.stderr


@pytest.mark.parametrize("case", ["bp1", "bp2"])
def test_rejects_the_review_files(tmp_path: Path, case: str) -> None:
    real = (SCRIPT.parent.parent / "pyproject.toml").read_text()
    if case == "bp1":
        text = real.replace('build-backend = "hatchling.build"\n', 'build-backend = "hatchling.build"\nbackend-path = ["shim"]\n', 1)
    else:
        text = real.replace('version = "', 'dynamic = ["version"]\n_old_version = "', 1) + '\n[tool.hatch.version]\nsource = "code"\npath = "evil.py"\n'
    assert text != real
    f = tmp_path / "pyproject.toml"
    f.write_text(text)
    assert subprocess.run([sys.executable, str(SCRIPT), str(f)], capture_output=True).returncode != 0
