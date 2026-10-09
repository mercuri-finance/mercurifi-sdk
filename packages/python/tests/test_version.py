import re
from pathlib import Path

import mercurifi


def test_version_matches_pyproject() -> None:
    text = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()
    match = re.search(r'^version = "([^"]+)"', text, re.M)
    assert match is not None
    assert mercurifi.__version__ == match.group(1)
