"""Builds the wheel, installs it into a fresh venv and imports it there, as a consumer would.

Usage: python scripts/smoke_wheel.py
Offline by default: build and runtime dependencies resolve
from the local uv cache only (locked versions); set MERCURIFI_SMOKE_ONLINE=1 on a runner with network access and an empty cache.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
NAMES = ["AsyncClient", "Client", "create_client", "local_key", "generate_agent_key", "decode_revert", "verify_built_tx", "open_stream", "wrap_untrusted"]
CHECK = (
    "import mercurifi, pathlib, sys\n"
    f"missing = [n for n in {NAMES!r} if not callable(getattr(mercurifi, n, None))]\n"
    "if missing:\n"
    "    sys.exit('wheel is missing ' + ', '.join(missing))\n"
    "if 'site-packages' not in pathlib.Path(mercurifi.__file__).parts:\n"
    "    sys.exit('imported from outside the venv: ' + mercurifi.__file__)\n"
    "from mercurifi import abi\n"
    "print('wheel ok', mercurifi.__version__)\n"
)


def run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)  # type: ignore[call-overload]
    if r.returncode != 0:
        sys.exit(f"{' '.join(cmd[:3])} failed:\n{r.stdout}{r.stderr}")
    return r


def main() -> None:
    offline = ["--offline"] if os.environ.get("MERCURIFI_SMOKE_ONLINE") != "1" else []
    with tempfile.TemporaryDirectory(prefix="mercurifi-wheel-") as tmp:
        out = Path(tmp) / "dist"
        run(["uv", "build", "--wheel", *offline, "--out-dir", str(out)], cwd=PKG)
        wheels = sorted(out.glob("mercurifi-*.whl"))
        if len(wheels) != 1:
            sys.exit(f"expected exactly one wheel, found {[w.name for w in wheels]}")
        venv = Path(tmp) / "venv"
        py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        # Runtime dependencies only, at the exact locked versions and hashes, into a throwaway environment (no dev group,
        # no editable project); then the wheel itself without re-resolving. The same interpreter as this script, so an
        # offline cache holds matching wheels.
        env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}
        run(["uv", "sync", "--frozen", "--no-dev", "--no-install-project", "--quiet", *offline, "--python", sys.executable], cwd=PKG, env=env)
        run(["uv", "pip", "install", "--quiet", *offline, "--python", str(py), "--no-deps", str(wheels[0])])
        # -I: no PYTHONPATH, no user site, and the working directory is not put on sys.path.
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("PYTHON", "UV_PROJECT"))}
        print(run([str(py), "-I", "-c", CHECK], cwd=tmp, env=clean).stdout.strip())


if __name__ == "__main__":
    main()
