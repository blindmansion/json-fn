"""Exception hierarchy for json-fn.

All errors raised by the interpreter are subclasses of :class:`JsonFnError`.
Error message strings intentionally mirror the Go reference implementation so
that the shared conformance suite (which uses substring matching on errors)
passes unchanged across implementations.
"""

from __future__ import annotations


class JsonFnError(Exception):
    """Base class for all json-fn errors."""


class EvaluationError(JsonFnError):
    """Raised for generic evaluation failures (bad expressions, type errors,
    missing functions/variables, etc.)."""


class CycleError(EvaluationError):
    """Raised when a circular variable dependency is detected during lazy
    local-variable resolution."""


class PathError(EvaluationError):
    """Raised when a `$var` path string is malformed."""


class LimitExceededError(JsonFnError):
    """Raised when the configured call-depth or operations limit is exceeded,
    or when the cancellation event is set."""
