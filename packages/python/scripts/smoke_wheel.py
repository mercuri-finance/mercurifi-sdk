"""Checks a built wheel's contents, then installs it into a fresh venv and imports it there, as a consumer would.

Usage: python scripts/smoke_wheel.py [WHEEL] [--sdist SDIST]

- With no WHEEL, builds the wheel and sdist from this package (hashed build constraints) and checks both.
- With WHEEL (the release job passes the exact file it uploads), checks that file; with --sdist as well, also checks that
  the sdist rebuilds into a wheel with the same RECORD (paths, sha256 and sizes).

Network: online on CI (CI=true, as GitHub Actions sets it) and offline locally, where build and runtime dependencies come
from the uv cache only. MERCURIFI_SMOKE_ONLINE=1 or 0 overrides either way. Online or not, every dependency is pinned with
hashes (build-constraints.txt, uv.lock).
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
CONSTRAINTS = PKG / "build-constraints.txt"
NAMES = [
    "AsyncClient",
    "Client",
    "create_client",
    "local_key",
    "generate_agent_key",
    "decode_revert",
    "verify_built_tx",
    "open_stream",
    "wrap_untrusted",
]
# The dist-info files the real hatchling wheel holds, and nothing else: no entry_points.txt (console scripts or plugin
# hooks), no signature files, no other metadata a tool could act on. licenses/** carries the LICENSE file.
DIST_INFO_FILES = ("METADATA", "WHEEL", "RECORD")


def online_from_env(env: Mapping[str, str]) -> bool:
    """MERCURIFI_SMOKE_ONLINE wins when set to 1/0; otherwise online exactly when CI is true (a fresh runner has no cache)."""
    flag = env.get("MERCURIFI_SMOKE_ONLINE", "").strip().lower()
    if flag in ("1", "true"):
        return True
    if flag in ("0", "false"):
        return False
    return env.get("CI", "").strip().lower() in ("1", "true")


def project_version(pyproject: Path) -> str:
    text = pyproject.read_text()
    try:
        import tomllib

        return str(tomllib.loads(text)["project"]["version"])
    except (
        ModuleNotFoundError
    ):  # Python 3.10 without tomli: the version line is a plain string in [project]
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
        if m is None:
            sys.exit("no project version in pyproject.toml")
        return m.group(1)


def record_rows(whl: Path) -> list[tuple[str, str, str]]:
    with zipfile.ZipFile(whl) as z:
        name = next((n for n in z.namelist() if re.fullmatch(r"[^/]+\.dist-info/RECORD", n)), None)
        if name is None:
            return []
        return [(r[0], r[1], r[2]) for r in csv.reader(io.StringIO(z.read(name).decode())) if r]


def check_wheel(whl: Path, version: str) -> list[str]:
    """The wheel holds mercurifi/** and its own dist-info only (METADATA, WHEEL, RECORD, licenses/**; so no
    entry_points.txt): no .pth, no *.data/, no other top-level entry, and RECORD
    matches the archive exactly (no unlisted or missing file, no duplicate entry, every sha256 and size correct)."""
    problems: list[str] = []
    expected_name = f"mercurifi-{version}-py3-none-any.whl"
    if whl.name != expected_name:
        problems.append(f"wheel file is {whl.name}, expected {expected_name}")
    dist = f"mercurifi-{version}.dist-info"
    with zipfile.ZipFile(whl) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        if len(names) != len(set(names)):
            problems.append("the wheel has duplicate entries")
        if f"{dist}/RECORD" not in names:
            return [*problems, f"{dist}/RECORD is missing"]
        rows = record_rows(whl)
        listed = [r[0] for r in rows]
        for n in sorted(set(names) | set(listed)):
            parts = n.split("/")
            if n.startswith("/") or "\\" in n or ".." in parts:
                problems.append(f"unsafe path: {n}")
            elif n.endswith(".pth"):
                problems.append(
                    f".pth files run code at interpreter start-up and are not allowed: {n}"
                )
            elif parts[0].endswith(".data"):
                problems.append(
                    f"*.data/ entries install outside the package and are not allowed: {n}"
                )
            elif parts[0] not in ("mercurifi", dist) or len(parts) < 2:
                problems.append(f"only mercurifi/** and {dist}/** are allowed: {n}")
            elif parts[0] == dist and not (
                (len(parts) == 2 and parts[1] in DIST_INFO_FILES)
                or (len(parts) > 2 and parts[1] == "licenses")
            ):
                problems.append(
                    f"{dist}/ may hold only {', '.join(DIST_INFO_FILES)} and licenses/**: {n}"
                )
        unlisted = sorted(set(names) - set(listed))
        missing = sorted(set(listed) - set(names))
        if unlisted:
            problems.append(f"files missing from RECORD: {', '.join(unlisted)}")
        if missing:
            problems.append(f"RECORD lists files not in the wheel: {', '.join(missing)}")
        for path, digest, size in rows:
            if path == f"{dist}/RECORD" or path not in names:
                continue
            data = z.read(path)
            want = (
                "sha256="
                + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            )
            if digest != want or size != str(len(data)):
                problems.append(f"RECORD hash or size does not match {path}")
        if f"{dist}/METADATA" in names:
            meta = z.read(f"{dist}/METADATA").decode()
            m = re.search(r"^Version: (.+)$", meta, re.M)
            if m is None or m.group(1).strip() != version:
                problems.append(
                    f"METADATA version is {m.group(1).strip() if m else 'missing'}, expected {version}"
                )
    return problems


def record_without_self(whl: Path) -> set[tuple[str, str, str]]:
    return {r for r in record_rows(whl) if not r[0].endswith(".dist-info/RECORD")}


def check_import_code(version: str) -> str:
    return (
        "import mercurifi, pathlib, sys\n"
        f"missing = [n for n in {NAMES!r} if not callable(getattr(mercurifi, n, None))]\n"
        "if missing:\n"
        "    sys.exit('wheel is missing ' + ', '.join(missing))\n"
        "if 'site-packages' not in pathlib.Path(mercurifi.__file__).parts:\n"
        "    sys.exit('imported from outside the venv: ' + mercurifi.__file__)\n"
        f"if mercurifi.__version__ != {version!r}:\n"
        f"    sys.exit('mercurifi.__version__ is ' + mercurifi.__version__ + ', pyproject says {version}')\n"
        "from mercurifi import abi\n"
        "print('wheel ok', mercurifi.__version__)\n"
    )


def run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)  # type: ignore[call-overload]
    if r.returncode != 0:
        sys.exit(f"{' '.join(cmd[:3])} failed:\n{r.stdout}{r.stderr}")
    return r


def build(src: Path, out: Path, offline: list[str], only_wheel: bool) -> None:
    # Build-backend dependencies (hatchling and its tree) are pinned with hashes; uv refuses anything else.
    kind = ["--wheel"] if only_wheel else []
    run(
        [
            "uv",
            "build",
            *kind,
            *offline,
            "--build-constraints",
            str(CONSTRAINTS),
            "--require-hashes",
            "--out-dir",
            str(out),
            str(src),
        ],
        cwd=PKG,
    )


def one(paths: list[Path], what: str) -> Path:
    if len(paths) != 1:
        sys.exit(f"expected exactly one {what}, found {[p.name for p in paths]}")
    return paths[0]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "wheel", nargs="?", type=Path, help="the wheel to check (default: build one)"
    )
    parser.add_argument("--sdist", type=Path, help="the sdist to check against the wheel")
    args = parser.parse_args(argv)
    offline = [] if online_from_env(os.environ) else ["--offline"]
    version = project_version(PKG / "pyproject.toml")
    with tempfile.TemporaryDirectory(prefix="mercurifi-wheel-") as tmp:
        if args.wheel is None:
            if args.sdist is not None:
                sys.exit("--sdist needs a wheel")
            out = Path(tmp) / "dist"
            build(PKG, out, offline, only_wheel=False)
            wheel, sdist = (
                one(sorted(out.glob("mercurifi-*.whl")), "wheel"),
                one(sorted(out.glob("mercurifi-*.tar.gz")), "sdist"),
            )
        else:
            wheel, sdist = args.wheel.resolve(), args.sdist.resolve() if args.sdist else None
        problems = check_wheel(wheel, version)
        if problems:
            sys.exit("wheel content check failed:\n" + "\n".join(problems))
        print(f"wheel contents ok ({wheel.name})")
        if sdist is not None:
            # The cheaper sound check: rebuild a wheel from the sdist and require the identical RECORD (every path, sha256
            # and size), so the sdist installs exactly the files that were import-tested below.
            again = Path(tmp) / "from-sdist"
            build(sdist, again, offline, only_wheel=True)
            rebuilt = one(sorted(again.glob("mercurifi-*.whl")), "wheel rebuilt from the sdist")
            if record_without_self(rebuilt) != record_without_self(wheel):
                diff = sorted(record_without_self(rebuilt) ^ record_without_self(wheel))
                sys.exit("the sdist builds a different wheel:\n" + "\n".join(map(str, diff)))
            print(f"sdist ok ({sdist.name} rebuilds the same wheel)")
        else:
            print("sdist not given; skipped the sdist comparison")
        venv = Path(tmp) / "venv"
        py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        # Runtime dependencies only, at the exact locked versions and hashes, into a throwaway environment (no dev group,
        # no editable project); then the wheel itself without re-resolving. The same interpreter as this script, so an
        # offline cache holds matching wheels.
        env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}
        run(
            [
                "uv",
                "sync",
                "--frozen",
                "--no-dev",
                "--no-install-project",
                "--quiet",
                *offline,
                "--python",
                sys.executable,
            ],
            cwd=PKG,
            env=env,
        )
        run(
            [
                "uv",
                "pip",
                "install",
                "--quiet",
                *offline,
                "--python",
                str(py),
                "--no-deps",
                str(wheel),
            ]
        )
        # -I: no PYTHONPATH, no user site, and the working directory is not put on sys.path.
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("PYTHON", "UV_PROJECT"))}
        print(
            run(
                [str(py), "-I", "-c", check_import_code(version)], cwd=tmp, env=clean
            ).stdout.strip()
        )


if __name__ == "__main__":
    main()
