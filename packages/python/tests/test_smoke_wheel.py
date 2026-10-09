"""The wheel smoke test's own logic: network selection and the wheel content gate (scripts/smoke_wheel.py)."""

import base64
import hashlib
import importlib.util
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "smoke_wheel.py"


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("smoke_wheel", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


smoke = load()
V = "1.2.3"
DIST = f"mercurifi-{V}.dist-info"


def row(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def make_wheel(tmp_path: Path, extra: dict[str, bytes] | None = None, unlisted: dict[str, bytes] | None = None, name: str = f"mercurifi-{V}-py3-none-any.whl", meta_version: str = V) -> Path:
    files = {
        "mercurifi/__init__.py": b'__version__ = "1.2.3"\n',
        "mercurifi/abi/x.json": b"[]",
        f"{DIST}/METADATA": f"Metadata-Version: 2.4\nName: mercurifi\nVersion: {meta_version}\n".encode(),
        f"{DIST}/WHEEL": b"Wheel-Version: 1.0\n",
        **(extra or {}),
    }
    record = "\n".join([*(row(p, d) for p, d in files.items()), f"{DIST}/RECORD,,"]) + "\n"
    whl = tmp_path / name
    with zipfile.ZipFile(whl, "w") as z:
        for p, d in {**files, **(unlisted or {})}.items():
            z.writestr(p, d)
        z.writestr(f"{DIST}/RECORD", record)
    return whl


@pytest.mark.parametrize(
    "env,online",
    [
        ({}, False),  # local default: offline from the uv cache
        ({"CI": "true"}, True),  # GitHub Actions: a fresh runner has no cache
        ({"CI": "1"}, True),
        ({"CI": "false"}, False),
        ({"CI": "true", "MERCURIFI_SMOKE_ONLINE": "0"}, False),
        ({"MERCURIFI_SMOKE_ONLINE": "1"}, True),
        ({"MERCURIFI_SMOKE_ONLINE": "true"}, True),
        ({"CI": "", "MERCURIFI_SMOKE_ONLINE": ""}, False),
    ],
)
def test_online_selection(env: dict[str, str], online: bool) -> None:
    assert smoke.online_from_env(env) is online


def test_accepts_a_clean_wheel(tmp_path: Path) -> None:
    assert smoke.check_wheel(make_wheel(tmp_path), V) == []


@pytest.mark.parametrize(
    "path,message",
    [
        ("evil.pth", ".pth"),
        ("mercurifi/evil.pth", ".pth"),
        (f"mercurifi-{V}.data/purelib/evil.py", ".data/"),
        (f"mercurifi-{V}.data/scripts/evil", ".data/"),
        ("evil/__init__.py", "only mercurifi/"),
        ("sitecustomize.py", "only mercurifi/"),
        ("other-1.0.dist-info/METADATA", "only mercurifi/"),
    ],
)
def test_rejects_entries_outside_the_package(tmp_path: Path, path: str, message: str) -> None:
    problems = smoke.check_wheel(make_wheel(tmp_path, extra={path: b"x"}), V)
    assert any(message in p for p in problems), problems


def test_rejects_a_file_missing_from_record(tmp_path: Path) -> None:
    problems = smoke.check_wheel(make_wheel(tmp_path, unlisted={"mercurifi/hidden.py": b"x"}), V)
    assert any("missing from RECORD" in p for p in problems), problems


def test_rejects_a_record_hash_that_does_not_match(tmp_path: Path) -> None:
    whl = make_wheel(tmp_path)
    tampered = tmp_path / "t" / whl.name
    tampered.parent.mkdir()
    with zipfile.ZipFile(whl) as src, zipfile.ZipFile(tampered, "w") as dst:
        for n in src.namelist():
            dst.writestr(n, b"tampered" if n == "mercurifi/__init__.py" else src.read(n))
    assert any("does not match" in p for p in smoke.check_wheel(tampered, V))


def test_rejects_a_wheel_without_record(tmp_path: Path) -> None:
    whl = tmp_path / f"mercurifi-{V}-py3-none-any.whl"
    with zipfile.ZipFile(whl, "w") as z:
        z.writestr("mercurifi/__init__.py", b"")
    assert any("RECORD is missing" in p for p in smoke.check_wheel(whl, V))


def test_rejects_a_version_mismatch(tmp_path: Path) -> None:
    assert any("wheel file is" in p for p in smoke.check_wheel(make_wheel(tmp_path, name="mercurifi-9.9.9-py3-none-any.whl"), V))
    other = tmp_path / "m"
    other.mkdir()
    assert any("METADATA version" in p for p in smoke.check_wheel(make_wheel(other, meta_version="9.9.9"), V))


def test_import_check_asserts_the_pyproject_version() -> None:
    code = smoke.check_import_code("4.5.6")
    assert "mercurifi.__version__ != '4.5.6'" in code


def test_reads_the_real_pyproject_version() -> None:
    from mercurifi import __version__

    assert smoke.project_version(SCRIPT.parent.parent / "pyproject.toml") == __version__
