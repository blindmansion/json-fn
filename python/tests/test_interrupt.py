"""Cooperative cancellation and the host-only wall-clock backstop.

Neither the cancel event nor the timeout is part of the conformance spec
(the deadline is non-deterministic); they are implementation-level safety
nets, so they live here rather than in the shared spec suite.
"""

from __future__ import annotations

import threading

import pytest

from jsonfn import (
    ExecutionLimits,
    LimitExceededError,
    call_function,
    create_stdlib,
)

FIB = {
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


def _fib_registry():
    reg = create_stdlib()
    reg["fib"] = FIB
    return reg


def test_set_cancel_event_aborts() -> None:
    event = threading.Event()
    event.set()
    body = {"$return": {"$fn": ["fib", 30]}}
    with pytest.raises(LimitExceededError, match="Execution aborted"):
        call_function(body, [], _fib_registry(), ExecutionLimits(cancel=event))


def test_unset_cancel_event_does_not_interfere() -> None:
    event = threading.Event()
    body = {"$return": {"$fn": ["add", 1, 2]}}
    assert call_function(body, [], create_stdlib(), ExecutionLimits(cancel=event)) == 3


def test_zero_timeout_times_out() -> None:
    body = {"$return": {"$fn": ["fib", 30]}}
    with pytest.raises(LimitExceededError, match="Execution timed out"):
        call_function(body, [], _fib_registry(), ExecutionLimits(timeout_ms=0))


def test_generous_timeout_does_not_interfere() -> None:
    body = {"$return": {"$fn": ["add", 1, 2]}}
    assert call_function(body, [], create_stdlib(), ExecutionLimits(timeout_ms=60_000)) == 3


def test_timeout_interrupts_higher_order_loop() -> None:
    # map("neg", range(N)) dispatches each callback through the invoke
    # chokepoint without re-entering _evaluate; checking there lets the
    # deadline interrupt this native loop.
    body = {"$return": {"$fn": ["map", "neg", {"$fn": ["range", 2_000_000]}]}}
    with pytest.raises(LimitExceededError, match="Execution timed out"):
        call_function(body, [], create_stdlib(), ExecutionLimits(timeout_ms=0))
