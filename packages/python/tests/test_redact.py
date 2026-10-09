"""The shared sanitiser against the shared vectors (fixtures/vectors/safeview.json, written for the TypeScript SDK)."""
import json
import time
import unicodedata
from pathlib import Path
from typing import Any

import pytest

from mercurifi.redact import join_surrogates, neutralize_untrusted, pre_bound, truncate_chars

V: dict[str, Any] = json.loads((Path(__file__).parents[3] / "fixtures" / "vectors" / "safeview.json").read_text("utf-8"))


def _text(field: str, raw: str, max_chars: int = 280) -> str:
    """The wrapUntrusted pipeline for a non-link field (the full wrapper arrives with the safe view)."""
    neutral = neutralize_untrusted(unicodedata.normalize("NFKC", pre_bound(raw, max_chars))).strip()
    return truncate_chars(neutral.replace("<<", "‹‹").replace(">>", "››").strip(), max_chars, "…")


@pytest.mark.parametrize("vector", [v for v in V["wrap"] if not v["field"].startswith("link.")], ids=lambda v: repr(v["raw"][:20]))
def test_wrap_vectors_neutralise_identically(vector: dict[str, str]) -> None:
    assert _text(vector["field"], vector["raw"]) == vector["text"]


def test_truncate_and_bound_vectors() -> None:
    t = V["truncate"]
    assert _text(t["field"], t["raw"], t["max"]) == t["text"]
    b = V["bound"]
    big = b["char"] * b["count"]
    start = time.perf_counter()
    assert _text(b["field"], big, b["max"]) == b["text"]
    assert time.perf_counter() - start < 0.5
    assert len(pre_bound(big, b["max"])) == b["max"] * b["preBound"]["mult"] + b["preBound"]["margin"]


def test_truncation_never_splits_a_pair() -> None:
    assert _text("name", "\U0001f600\U0001f600\U0001f600", 2) == "\U0001f600\U0001f600…"


def test_pre_bound_counts_utf16_units_like_typescript() -> None:
    assert len(pre_bound("\U0001f600" * 2000, 10)) == (10 * 4 + 256) // 2  # two UTF-16 units per emoji
    assert neutralize_untrusted(pre_bound("\U0001f600" * 2000, 10)).count("\U0001f600") == (10 * 4 + 256) // 2


def test_joins_split_surrogate_pairs_and_drops_lone_ones() -> None:
    assert join_surrogates("😀") == "\U0001f600"
    assert neutralize_untrusted("a😀b\ud800c\udc00d") == "a\U0001f600bcd"


def test_scheme_free_words_and_marks_are_left_alone() -> None:
    assert neutralize_untrusted("metadata: fine") == "metadata: fine"
    assert neutralize_untrusted("x:https://k@h/KEY") == "x:h"
    assert neutralize_untrusted("1️⃣ #️") == "1️⃣ #️"
