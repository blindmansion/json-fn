"""Conformance suite runner.

Loads every JSON file under ``spec/cases/`` (relative to the repo root) and
parametrizes one pytest case per ``cases[]`` entry. A case has either:

  - ``"expected": <value>``: evaluator must return a value that compares
    equal under :func:`_json_equal` (which treats ``int``/``float`` as
    interchangeable for spec parity).
  - ``"error": "<substring>"``: evaluation must raise
    :class:`jsonfn.JsonFnError` whose message contains the substring.

Optional per-case fields:

  - ``"functions"``: extra function bodies merged into the stdlib registry.
  - ``"limits"``: ``{"maxCallDepth": N, "maxFuel": N, "maxValueSize": N}``.
  - ``"expectedFuel"``: exact fuel the run must consume (anchor cases).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from jsonfn import (
    ExecutionLimits,
    ExecutionUsage,
    JsonFnError,
    call_function,
    create_stdlib,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SPEC_DIR = REPO_ROOT / "spec" / "cases"


def _is_number(v: Any) -> bool:
    """True for ints/floats but not bools (which are ints in Python)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _json_equal(a: Any, b: Any) -> bool:
    """Spec equality — int/float interchangeable, structural for containers."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b, strict=False))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    return False


def _load_cases() -> list[tuple[str, dict[str, Any]]]:
    """Discover all spec cases, returning ``[(test_id, case_dict)]``.

    Suite-level ``functions`` are merged into each case's local ``functions``
    (case-level entries take precedence) so that tests behave the same as
    other implementations' runners.
    """
    if not SPEC_DIR.is_dir():
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(SPEC_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            suite = json.load(f)
        suite_name = path.stem
        suite_fns = suite.get("functions", {})
        for case in suite.get("cases", []):
            merged: dict[str, Any] = {**suite_fns, **case.get("functions", {})}
            enriched = {**case, "functions": merged} if merged else case
            test_id = f"{suite_name}::{case['description']}"
            out.append((test_id, enriched))
    return out


_CASES = _load_cases()


@pytest.mark.parametrize(
    ("case",),
    [pytest.param(c, id=tid) for tid, c in _CASES],
)
def test_spec_case(case: dict[str, Any]) -> None:
    registry = create_stdlib()
    if "functions" in case:
        for name, body in case["functions"].items():
            registry[name] = body

    expects_fuel = "expectedFuel" in case
    usage = ExecutionUsage() if expects_fuel else None

    kwargs: dict[str, Any] = {}
    if "limits" in case:
        spec_limits = case["limits"]
        if "maxCallDepth" in spec_limits:
            kwargs["max_call_depth"] = spec_limits["maxCallDepth"]
        if "maxFuel" in spec_limits:
            kwargs["max_fuel"] = spec_limits["maxFuel"]
        if "maxValueSize" in spec_limits:
            kwargs["max_value_size"] = spec_limits["maxValueSize"]
    if usage is not None:
        kwargs["usage"] = usage
    limits = ExecutionLimits(**kwargs) if kwargs else None

    body = case["body"]
    args = case.get("args", [])

    if "error" in case:
        with pytest.raises(JsonFnError) as exc_info:
            call_function(body, args, registry, limits)
        assert case["error"] in str(exc_info.value), (
            f"Expected error containing {case['error']!r}, got {exc_info.value!r}"
        )
        return

    result = call_function(body, args, registry, limits)
    expected = case.get("expected")
    assert _json_equal(result, expected), f"Expected {expected!r}, got {result!r}"

    if usage is not None:
        assert usage.fuel == case["expectedFuel"], (
            f"Expected {case['expectedFuel']} fuel, consumed {usage.fuel}"
        )


def test_spec_cases_were_discovered() -> None:
    """Sanity check: confirm we actually loaded cases (catches a misconfigured
    repo layout that would otherwise produce zero parametrized tests)."""
    assert len(_CASES) > 50, f"Too few spec cases discovered: {len(_CASES)}"
