"""json-fn: a tree-walking interpreter for a pure-JSON expression language.

Quick start:

    >>> from jsonfn import call_function, create_stdlib
    >>> stdlib = create_stdlib()
    >>> body = {
    ...     "$params": ["a", "b"],
    ...     "$return": {"$fn": ["add", {"$var": "a"}, {"$var": "b"}]},
    ... }
    >>> call_function(body, [2, 3], stdlib)
    5

See ``docs/language.md`` in the repository for the full language reference.
"""

from __future__ import annotations

from .errors import (
    CycleError,
    EvaluationError,
    JsonFnError,
    LimitExceededError,
    PathError,
)
from .evaluate import Interpreter, call_function
from .jsonc import strip_jsonc
from .stdlib import create_stdlib
from .types import (
    BuiltinContext,
    BuiltinFn,
    ExecutionLimits,
    FunctionRegistry,
    JsonValue,
    PureFn,
)

__all__ = [
    "BuiltinContext",
    "BuiltinFn",
    "CycleError",
    "EvaluationError",
    "ExecutionLimits",
    "FunctionRegistry",
    "Interpreter",
    "JsonFnError",
    "JsonValue",
    "LimitExceededError",
    "PathError",
    "PureFn",
    "call_function",
    "create_stdlib",
    "strip_jsonc",
]
