"""Type definitions for json-fn.

Public:
    - JsonValue: alias for any JSON-shaped Python value.
    - ExecutionLimits: knobs for safety (call depth, operations cap, cancel).
    - BuiltinContext: handle passed to higher-order builtins so they can call
      back into the interpreter.
    - FunctionRegistry: alias for the dict of registered functions.

Internal (re-exported for type hints in stdlib.py and evaluate.py):
    - _PureEntry, _BuiltinEntry: tagged entries stored in the registry.
    - ExpressionType: enum used by the evaluator's classify-and-dispatch.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum, auto
from typing import Any

JsonValue = None | bool | int | float | str | list[Any] | dict[str, Any]
"""Any JSON-shaped Python value. Recursive; using Any for the leaves keeps
type-checker happiness without requiring a TypeAlias forward reference."""


@dataclass(slots=True)
class ExecutionUsage:
    """Reports resource consumption of a completed evaluation.

    Pass an instance as :attr:`ExecutionLimits.usage`; after
    :func:`jsonfn.call_function` returns, :attr:`fuel` holds the total fuel
    consumed. On a *rejected* run the count may overshoot ``max_fuel`` because
    size surcharges are charged atomically; completed runs report exact fuel.
    """

    fuel: int = 0


@dataclass(frozen=True, slots=True)
class ExecutionLimits:
    """Safety limits for an evaluation.

    Attributes:
        max_call_depth: Maximum nested function-call depth before the
            interpreter raises :class:`LimitExceededError`. Defaults to 256.
        max_fuel: Total work budget (the metered "fuel" model). Fuel is charged
            per AST node, per function invocation, and proportionally to the
            work done by size-sensitive builtins. ``None`` means unlimited.
        max_value_size: Maximum length of any produced array or string. Bounds
            allocation bombs (``range``/``concat``/``flatten``/string builtins).
            ``None`` means unlimited. Enforced independently of ``max_fuel``.
        cancel: Optional event whose ``is_set()`` is checked at every node and
            every function invocation (so native higher-order loops are
            covered); when set, evaluation aborts with
            :class:`LimitExceededError`. Mirrors Go's ``context.Context``.
        timeout_ms: Host-only wall-clock backstop, in milliseconds. When set,
            evaluation aborts with "Execution timed out" once
            ``time.monotonic()`` passes the deadline (measured from when the
            :class:`Interpreter` is constructed). Checked at the same
            chokepoints as ``cancel``. Deliberately non-deterministic and
            therefore NOT part of the conformance spec — an implementation-level
            safety net only.
        usage: Optional :class:`ExecutionUsage` that, when provided, receives
            the total fuel consumed once evaluation finishes.
    """

    max_call_depth: int = 256
    max_fuel: int | None = None
    max_value_size: int | None = None
    cancel: threading.Event | None = None
    timeout_ms: float | None = None
    usage: ExecutionUsage | None = None


@dataclass(frozen=True, slots=True)
class BuiltinContext:
    """Handed to builtin functions so they can invoke json-fn callbacks.

    A pure function (e.g. ``add``) receives only its arguments. A builtin
    (e.g. ``map``, ``reduce``) additionally receives ``ctx`` as a keyword
    argument so it can call back into the interpreter via ``ctx.call``.

    ``charge`` and ``guard_size`` let a builtin self-meter: ``charge(n)``
    decrements the shared fuel budget by ``n`` (raising when exhausted), and
    ``guard_size(n)`` enforces ``max_value_size`` before allocating a large
    result. Both raise :class:`LimitExceededError` on violation.
    """

    call: Callable[[JsonValue, list[JsonValue]], JsonValue]
    registry: FunctionRegistry
    charge: Callable[[int], None]
    guard_size: Callable[[int], None]


PureFn = Callable[..., JsonValue]
"""Signature for pure stdlib functions: ``def add(a, b) -> JsonValue``."""

BuiltinFn = Callable[..., JsonValue]
"""Signature for higher-order stdlib functions:
``def map(callback, arr, *, ctx: BuiltinContext) -> JsonValue``."""


@dataclass(frozen=True, slots=True)
class _PureEntry:
    """Registry entry for a pure function (no callbacks)."""

    fn: PureFn
    arity: int  # -1 for variadic


@dataclass(frozen=True, slots=True)
class _BuiltinEntry:
    """Registry entry for a builtin that may call back into the interpreter."""

    fn: BuiltinFn
    arity: int  # -1 for variadic


FunctionRegistry = dict[str, "_PureEntry | _BuiltinEntry | dict[str, Any]"]
"""Maps function name -> implementation. Implementations are one of:

    - :class:`_PureEntry` for native pure functions
    - :class:`_BuiltinEntry` for native higher-order functions
    - ``dict`` (a json-fn function body containing ``$return``)

Users typically construct via :func:`jsonfn.create_stdlib` and may then
overlay JSON function bodies directly: ``registry["myFunc"] = body_dict``.
"""


class ExpressionType(Enum):
    """Classification of a json-fn expression by shape. Determined by
    :meth:`Interpreter._classify` and dispatched in :meth:`Interpreter._evaluate`.
    """

    FUNCTION_CALL = auto()
    FUNCTION_REFERENCE = auto()
    VARIABLE_REFERENCE = auto()
    FUNCTION_BODY = auto()
    CONDITIONAL = auto()
    COND = auto()
    MATCH = auto()
    AND = auto()
    OR = auto()
    COMPARISON = auto()
    NOT = auto()
    PROPERTY_ACCESS = auto()
    RAW = auto()
    OBJECT = auto()
    ARRAY = auto()
    STRING = auto()
    NUMBER = auto()
    BOOLEAN = auto()
    NULL = auto()
