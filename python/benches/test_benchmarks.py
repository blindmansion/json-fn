"""Performance benchmarks (run via ``pytest-benchmark``).

Mirrors ``go/benchmark_test.go`` so cross-implementation comparisons are
apples-to-apples. Run with::

    uv run pytest benches/ --benchmark-only

These tests are skipped during normal ``pytest`` runs because they live
outside the default ``tests/`` collection root configured in
``pyproject.toml``. To run only a single benchmark, use::

    uv run pytest benches/test_benchmarks.py::test_deep_arithmetic[100]
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from jsonfn import call_function, create_stdlib

# Deep-arithmetic benchmarks at depth >= 1000 require more than Python's
# default recursion limit. Each level of nested expression contributes
# several Python frames (`_evaluate` + `call` + a couple of helpers), so
# pad generously. This does NOT relax the interpreter's own
# `max_call_depth` safety limit (which is per-function-invocation, not
# per-evaluation-frame, and so doesn't trip here).
sys.setrecursionlimit(50_000)


def _make_deep_add(depth: int) -> dict[str, Any]:
    """``((((0 + 1) + 1) + 1) ...)`` to ``depth`` levels — stresses the
    expression evaluator and recursion machinery."""
    expr: Any = 0
    for _ in range(depth):
        expr = {"$fn": ["add", expr, 1]}
    return {"$return": expr}


@pytest.mark.parametrize("depth", [100, 500, 1000, 5000], ids=str)
def test_deep_arithmetic(benchmark: Any, depth: int) -> None:
    program = _make_deep_add(depth)
    stdlib = create_stdlib()
    benchmark(call_function, program, [], stdlib)


_MAP_PROGRAM = {
    "$params": ["arr"],
    "$return": {
        "$fn": [
            "map",
            {
                "$params": ["x"],
                "$return": {"$fn": ["add", {"$var": "x"}, 1]},
            },
            {"$var": "arr"},
        ]
    },
}


@pytest.mark.parametrize("size", [100, 1000, 5000, 10000], ids=str)
def test_map_over_array(benchmark: Any, size: int) -> None:
    arr = list(range(size))
    stdlib = create_stdlib()
    benchmark(call_function, _MAP_PROGRAM, [arr], stdlib)


_NESTED_MAP_PROGRAM = {
    "$params": ["grid"],
    "$return": {
        "$fn": [
            "map",
            {
                "$params": ["row"],
                "$return": {
                    "$fn": [
                        "map",
                        {
                            "$params": ["x"],
                            "$return": {"$fn": ["add", {"$var": "x"}, 1]},
                        },
                        {"$var": "row"},
                    ]
                },
            },
            {"$var": "grid"},
        ]
    },
}


@pytest.mark.parametrize("size", [10, 50, 100], ids=lambda s: f"{s}x{s}")
def test_nested_map(benchmark: Any, size: int) -> None:
    grid = [list(range(size)) for _ in range(size)]
    stdlib = create_stdlib()
    benchmark(call_function, _NESTED_MAP_PROGRAM, [grid], stdlib)


_REDUCE_PROGRAM = {
    "$params": ["arr"],
    "$return": {
        "$fn": [
            "reduce",
            {
                "$params": ["acc", "item"],
                "$return": {"$fn": ["add", {"$var": "acc"}, {"$var": "item"}]},
            },
            0,
            {"$var": "arr"},
        ]
    },
}


@pytest.mark.parametrize("size", [100, 1000, 5000, 10000], ids=str)
def test_reduce_sum(benchmark: Any, size: int) -> None:
    arr = list(range(size))
    stdlib = create_stdlib()
    benchmark(call_function, _REDUCE_PROGRAM, [arr], stdlib)


def _make_fibonacci_stdlib() -> dict[str, Any]:
    stdlib = create_stdlib()
    stdlib["fib"] = {
        "$params": ["n"],
        "$return": {
            "$if": {"$fn": ["lte", {"$var": "n"}, 1]},
            "$then": {"$var": "n"},
            "$else": {
                "$fn": [
                    "add",
                    {"$fn": ["fib", {"$fn": ["sub", {"$var": "n"}, 1]}]},
                    {"$fn": ["fib", {"$fn": ["sub", {"$var": "n"}, 2]}]},
                ]
            },
        },
    }
    return stdlib


@pytest.mark.parametrize("n", [10, 15, 20], ids=str)
def test_fibonacci(benchmark: Any, n: int) -> None:
    stdlib = _make_fibonacci_stdlib()
    program = {"$return": {"$fn": ["fib", n]}}
    benchmark(call_function, program, [], stdlib)
