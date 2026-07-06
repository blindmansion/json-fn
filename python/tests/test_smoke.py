"""Smoke tests covering the public Python API.

The conformance suite (test_spec.py) verifies language semantics; this file
verifies the integration shape that Python users actually touch — the
``call_function`` entry point, registering custom Python functions via the
``_Registry`` decorator, closures, and JSONC parsing.
"""

from __future__ import annotations

import pytest

from jsonfn import (
    BuiltinContext,
    EvaluationError,
    ExecutionLimits,
    JsonFnError,
    LimitExceededError,
    call_function,
    create_stdlib,
    strip_jsonc,
)
from jsonfn.stdlib import _Registry


def test_constant_return() -> None:
    body = {"$return": 42}
    assert call_function(body, [], create_stdlib()) == 42


def test_basic_call_with_params() -> None:
    body = {
        "$params": ["a", "b"],
        "$return": {"$fn": ["add", {"$var": "a"}, {"$var": "b"}]},
    }
    assert call_function(body, [2, 3], create_stdlib()) == 5


def test_log_returns_value_without_printing_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    body = {
        "$return": {
            "$fn": [
                "log",
                {"answer": 42, "ok": True},
                "debug",
            ]
        }
    }
    assert call_function(body, [], create_stdlib()) == {"answer": 42, "ok": True}
    assert capsys.readouterr().out == ""


def test_log_calls_configured_logger() -> None:
    calls: list[tuple[object, ...]] = []
    body = {
        "$return": {
            "$fn": [
                "log",
                {"answer": 42, "ok": True},
                "debug",
            ]
        }
    }

    assert call_function(body, [], create_stdlib(logger=lambda *args: calls.append(args))) == {
        "answer": 42,
        "ok": True,
    }
    assert calls == [({"answer": 42, "ok": True}, "debug")]


def test_higher_order_map_filter_reduce() -> None:
    body = {
        "$return": {
            "$fn": [
                "reduce",
                {"$fn": "add"},
                0,
                {
                    "$fn": [
                        "map",
                        {
                            "$params": ["x"],
                            "$return": {"$fn": ["mul", {"$var": "x"}, {"$var": "x"}]},
                        },
                        {
                            "$fn": [
                                "filter",
                                {
                                    "$params": ["x"],
                                    "$return": {"$fn": ["gt", {"$var": "x"}, 2]},
                                },
                                [1, 2, 3, 4, 5],
                            ]
                        },
                    ]
                },
            ]
        }
    }
    assert call_function(body, [], create_stdlib()) == 50  # 9 + 16 + 25


def test_closure_capture_via_returned_function() -> None:
    """Returning an inner function body should bake outer params in via
    replace_vars so the result is a self-contained, callable body."""
    make_adder = {
        "$params": ["x"],
        "$return": {
            "$params": ["y"],
            "$return": {"$fn": ["add", {"$var": "x"}, {"$var": "y"}]},
        },
    }
    add_5 = call_function(make_adder, [5], create_stdlib())
    assert isinstance(add_5, dict)
    assert call_function(add_5, [3], create_stdlib()) == 8


def test_custom_pure_function_via_decorator() -> None:
    """Custom Python functions can be registered via the same decorator
    helper used internally for the stdlib."""
    r = _Registry()

    @r.pure("greet", arity=1)
    def _(name: str) -> str:
        return f"hello, {name}!"

    registry = {**create_stdlib(), **r.build()}
    body = {"$return": {"$fn": ["greet", "world"]}}
    assert call_function(body, [], registry) == "hello, world!"


def test_custom_builtin_function_with_callback() -> None:
    """Custom builtins receive a BuiltinContext for invoking json-fn callbacks."""
    r = _Registry()

    @r.builtin("twice", arity=2)
    def _(callback, value, *, ctx: BuiltinContext):
        # Apply ``callback`` to ``value`` two times, threading the result.
        once = ctx.call(callback, [value])
        return ctx.call(callback, [once])

    registry = {**create_stdlib(), **r.build()}
    body = {
        "$return": {
            "$fn": [
                "twice",
                {"$params": ["n"], "$return": {"$fn": ["mul", {"$var": "n"}, 3]}},
                4,
            ]
        }
    }
    assert call_function(body, [], registry) == 36  # 4 * 3 * 3


def test_call_depth_limit_raises() -> None:
    body = {"$return": {"$fn": ["loop"]}}
    registry = {
        **create_stdlib(),
        "loop": {"$return": {"$fn": ["loop"]}},
    }
    with pytest.raises(LimitExceededError, match="Maximum call depth"):
        call_function(body, [], registry, ExecutionLimits(max_call_depth=10))


def test_fuel_limit_raises() -> None:
    body = {
        "$return": {"$fn": ["map", {"$params": ["x"], "$return": {"$var": "x"}}, list(range(100))]}
    }
    with pytest.raises(LimitExceededError, match="Maximum fuel"):
        call_function(body, [], create_stdlib(), ExecutionLimits(max_fuel=20))


def test_evaluation_error_is_jsonfn_error() -> None:
    """All interpreter errors share the JsonFnError ancestor so callers can
    catch one type."""
    body = {"$return": {"$fn": ["add", "not", "numbers"]}}
    with pytest.raises(JsonFnError):
        call_function(body, [], create_stdlib())
    # And specifically the subtype:
    with pytest.raises(EvaluationError):
        call_function(body, [], create_stdlib())


def test_strip_jsonc_handles_comments_and_trailing_commas() -> None:
    src = """{
        "a": 1, // a comment
        "b": [
            1,
            2, // trailing comma below ok
        ],
    }"""
    cleaned = strip_jsonc(src)
    import json

    parsed = json.loads(cleaned)
    assert parsed == {"a": 1, "b": [1, 2]}


def test_strip_jsonc_preserves_url_inside_string() -> None:
    """The // sequence inside a JSON string must NOT be treated as a comment."""
    src = '{"url": "https://example.com/path"}'
    assert strip_jsonc(src) == src
