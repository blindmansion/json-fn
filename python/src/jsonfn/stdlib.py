"""json-fn standard library.

~60 functions across arithmetic, comparison, logic, type checks/coercion,
arrays, strings, objects, regex, higher-order, and introspection categories.
See ``docs/language.md`` in the repo for the full reference.

Functions are registered via :class:`_Registry`'s decorator API. Pure functions
receive their arguments unpacked (``def add(a, b)``); builtins additionally
receive ``ctx: BuiltinContext`` as a keyword (``def map(callback, arr, *, ctx)``)
so they can invoke json-fn callbacks via ``ctx.call(callback, [...])``.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from functools import cmp_to_key
from typing import Any, TypeGuard

from .errors import EvaluationError
from .types import (
    BuiltinContext,
    BuiltinFn,
    FunctionRegistry,
    JsonValue,
    PureFn,
    _BuiltinEntry,
    _PureEntry,
)


class _Registry:
    """Builder for a :data:`FunctionRegistry`. Use as decorators:

    r = _Registry()
    @r.pure("add", arity=2)
    def _(a, b): return a + b
    """

    __slots__ = ("_fns",)

    def __init__(self) -> None:
        self._fns: FunctionRegistry = {}

    def pure(self, name: str, *, arity: int):
        def decorator(fn: PureFn) -> PureFn:
            self._fns[name] = _PureEntry(fn=fn, arity=arity)
            return fn

        return decorator

    def builtin(self, name: str, *, arity: int):
        def decorator(fn: BuiltinFn) -> BuiltinFn:
            self._fns[name] = _BuiltinEntry(fn=fn, arity=arity)
            return fn

        return decorator

    def build(self) -> FunctionRegistry:
        return dict(self._fns)


# --- helpers shared across stdlib functions ---------------------------------


def _truthy(v: Any) -> bool:
    """json-fn truthiness — only ``None``/``False``/``0``/``""`` are falsy."""
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v != ""
    return True


def _is_number(v: object) -> TypeGuard[int | float]:
    """True for ints and floats but explicitly NOT bools (which are ints in
    Python). Mirrors Go's ``float64`` discrimination. Acts as a ``TypeGuard``
    so callers can use the value as a number after the check.

    Uses ``type(v) is X`` rather than ``isinstance`` for speed: this is on the
    hot path of every arithmetic/comparison call. ``type() is int`` already
    excludes ``bool`` (since ``type(True) is bool``, not ``int``).
    """
    t = type(v)
    return t is int or t is float


def _as_number(v: Any, fn_name: str) -> int | float:
    t = type(v)
    if t is int or t is float:
        return v
    raise EvaluationError(f"{fn_name}: argument must be a number")


def _two_numbers(a: Any, b: Any, fn_name: str) -> tuple[int | float, int | float]:
    ta = type(a)
    tb = type(b)
    if (ta is int or ta is float) and (tb is int or tb is float):
        return a, b
    raise EvaluationError(f"{fn_name}: arguments must be numbers")


def _strict_equal(a: Any, b: Any) -> bool:
    """Strict scalar equality for JSON values. Containers are not equal."""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return False


def _json_equal(a: Any, b: Any) -> bool:
    """Structural JSON equality. Distinguishes bool from int and compares
    arrays/objects recursively.
    """
    if a is None or b is None:
        return a is None and b is None
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


def _json_less(a: Any, b: Any) -> bool:
    """Comparison used by ``sortBy`` to order keys. Numbers and strings
    compare normally; mixed/incomparable types fall back to ``False``
    (matches Go's ``jsonLess``)."""
    if _is_number(a) and _is_number(b):
        return a < b
    if isinstance(a, str) and isinstance(b, str):
        return a < b
    return False


def _json_dump(v: Any) -> str:
    """JSON-serialize ``v`` for inclusion in error messages and ``str``
    coercion. Falls back to ``repr`` for non-JSON values."""
    try:
        return json.dumps(v, separators=(",", ":"))
    except (TypeError, ValueError):
        return repr(v)


_MISSING = object()


# --- regex helpers ----------------------------------------------------------

_INLINE_FLAGS_RE = re.compile(r"^\(\?([imsu]*)\)")
_NAMED_GROUP_RE = re.compile(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>")


def _compile_pattern(pattern: str, fn_name: str) -> re.Pattern[str]:
    """Translate a json-fn pattern into a compiled Python ``re.Pattern``.

    Translations applied:
      - Optional leading ``(?flags)`` prefix → ``re.IGNORECASE`` etc.
        (``u`` is silently accepted; Python is always Unicode-aware.)
      - ``(?<name>...)`` (Go/Perl syntax) → ``(?P<name>...)`` (Python).
    """
    flags = 0
    source = pattern
    m = _INLINE_FLAGS_RE.match(pattern)
    if m:
        for ch in m.group(1):
            if ch == "i":
                flags |= re.IGNORECASE
            elif ch == "m":
                flags |= re.MULTILINE
            elif ch == "s":
                flags |= re.DOTALL
        source = pattern[m.end() :]
    source = _NAMED_GROUP_RE.sub(r"(?P<\1>", source)
    try:
        return re.compile(source, flags)
    except re.error as e:
        raise EvaluationError(f"{fn_name}: invalid pattern {pattern!r}: {e}") from e


def _build_match_result(m: re.Match[str]) -> dict[str, Any]:
    """Convert a Python ``re.Match`` into the spec's match-object shape:
    ``{match, index, groups, named}`` where ``groups`` lists positional captures
    (``None`` for unmatched optional groups) and ``named`` is the named-group
    dict (``{}`` if there are none)."""
    groups: list[JsonValue] = list(m.groups(default=None))
    named = {k: (v if v is not None else None) for k, v in (m.groupdict() or {}).items()}
    return {
        "match": m.group(0),
        "index": m.start(),
        "groups": groups,
        "named": named,
    }


_REPLACEMENT_TOKEN_RE = re.compile(r"\$(\$|\d+)")


def _translate_replacement(replacement: str) -> str:
    """Translate the spec's ``$N`` group-reference syntax (Go/JS style) into
    Python's ``\\g<N>`` form. Also escapes any literal backslashes so they
    round-trip, and treats ``$$`` as a literal ``$``."""
    # Escape backslashes first so they aren't interpreted by re.sub.
    escaped = replacement.replace("\\", "\\\\")

    def _sub(m: re.Match[str]) -> str:
        token = m.group(1)
        if token == "$":
            return "$"
        return f"\\g<{token}>"

    return _REPLACEMENT_TOKEN_RE.sub(_sub, escaped)


# --- introspection helper (used by `arity` builtin) -------------------------


def _arity_of(fn: Any, registry: FunctionRegistry) -> int:
    """Compute the arity of a function (name or body), or -1 if unknown.
    For function bodies with a rest parameter, excludes the rest.
    Mirrors Go's ``GetArity``."""
    if isinstance(fn, dict) and "$return" in fn:
        params = fn.get("$params") or []
        if not params:
            return 0
        last = params[-1]
        if isinstance(last, str) and last.startswith("..."):
            return len(params) - 1
        return len(params)
    if isinstance(fn, str):
        entry = registry.get(fn)
        if entry is None:
            return -1
        if isinstance(entry, (_PureEntry, _BuiltinEntry)):
            return entry.arity
        if isinstance(entry, dict):
            return _arity_of(entry, registry)
    return -1


# === stdlib construction =====================================================


LogFn = Callable[..., None]


def create_stdlib(logger: LogFn | None = None) -> FunctionRegistry:
    """Build the standard-library :data:`FunctionRegistry`."""
    r = _Registry()

    # --- arithmetic ---------------------------------------------------------

    @r.pure("add", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "add")
        return x + y

    @r.pure("sub", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "sub")
        return x - y

    @r.pure("mul", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "mul")
        return x * y

    @r.pure("div", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "div")
        if y == 0:
            raise EvaluationError("div: division by zero")
        # True division — preserves Go's float64 semantics.
        result = x / y
        # Coerce a clean integer result back to int to match JSON-natural form.
        if isinstance(result, float) and result.is_integer():
            return int(result)
        return result

    @r.pure("mod", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "mod")
        # Use math.fmod for parity with Go's math.Mod (truncated division).
        if isinstance(x, int) and isinstance(y, int):
            # Python's % matches sign-of-divisor; Go's math.Mod matches
            # sign-of-dividend. Use math.fmod for cross-language parity.
            result = math.fmod(x, y)
            if result.is_integer():
                return int(result)
            return result
        return math.fmod(x, y)

    @r.pure("abs", arity=1)
    def _(a: Any) -> JsonValue:
        return abs(_as_number(a, "abs"))

    @r.pure("neg", arity=1)
    def _(a: Any) -> JsonValue:
        return -_as_number(a, "neg")

    @r.pure("floor", arity=1)
    def _(a: Any) -> JsonValue:
        return math.floor(_as_number(a, "floor"))

    @r.pure("ceil", arity=1)
    def _(a: Any) -> JsonValue:
        return math.ceil(_as_number(a, "ceil"))

    @r.pure("round", arity=1)
    def _(a: Any) -> JsonValue:
        n = _as_number(a, "round")
        # math.floor(x + 0.5) gives "round half up" semantics that matches
        # Go's math.Round; Python's built-in round() uses banker's rounding.
        if n >= 0:
            return math.floor(n + 0.5)
        return -math.floor(-n + 0.5)

    @r.pure("max", arity=1)
    def _(arr: Any) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("max: argument must be an array")
        if not arr:
            return -math.inf
        for v in arr:
            if not _is_number(v):
                raise EvaluationError("max: array element is not a number")
        return max(arr)

    @r.pure("min", arity=1)
    def _(arr: Any) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("min: argument must be an array")
        if not arr:
            return math.inf
        for v in arr:
            if not _is_number(v):
                raise EvaluationError("min: array element is not a number")
        return min(arr)

    # --- comparison ---------------------------------------------------------

    @r.pure("eq", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        return _strict_equal(a, b)

    @r.pure("neq", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        return not _strict_equal(a, b)

    @r.pure("jsonEq", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        return _json_equal(a, b)

    @r.pure("jsonNeq", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        return not _json_equal(a, b)

    @r.pure("gt", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "gt")
        return x > y

    @r.pure("gte", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "gte")
        return x >= y

    @r.pure("lt", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "lt")
        return x < y

    @r.pure("lte", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        x, y = _two_numbers(a, b, "lte")
        return x <= y

    # --- logic --------------------------------------------------------------

    @r.pure("not", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, bool):
            raise EvaluationError("not: argument must be a boolean")
        return not a

    @r.pure("and", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        if not (isinstance(a, bool) and isinstance(b, bool)):
            raise EvaluationError("and: arguments must be booleans")
        return a and b

    @r.pure("or", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        if not (isinstance(a, bool) and isinstance(b, bool)):
            raise EvaluationError("or: arguments must be booleans")
        return a or b

    # --- type predicates ---------------------------------------------------

    @r.pure("isNull", arity=1)
    def _(a: Any) -> JsonValue:
        return a is None

    @r.pure("isBool", arity=1)
    def _(a: Any) -> JsonValue:
        return isinstance(a, bool)

    @r.pure("isNumber", arity=1)
    def _(a: Any) -> JsonValue:
        return _is_number(a)

    @r.pure("isString", arity=1)
    def _(a: Any) -> JsonValue:
        return isinstance(a, str)

    @r.pure("isArray", arity=1)
    def _(a: Any) -> JsonValue:
        return isinstance(a, list)

    @r.pure("isObject", arity=1)
    def _(a: Any) -> JsonValue:
        return isinstance(a, dict)

    # --- coercion ----------------------------------------------------------

    @r.pure("str", arity=1)
    def _(a: Any) -> JsonValue:
        if isinstance(a, str):
            return a
        return _json_dump(a)

    @r.pure("num", arity=1)
    def _(a: Any) -> JsonValue:
        if a is None:
            return 0
        if isinstance(a, bool):
            return 1 if a else 0
        if _is_number(a):
            return a
        if isinstance(a, str):
            try:
                if "." in a or "e" in a or "E" in a:
                    return float(a)
                return int(a)
            except ValueError as e:
                raise EvaluationError(f"num: cannot parse {a!r} as number") from e
        raise EvaluationError(f"num: cannot convert {type(a).__name__} to number")

    # --- arrays ------------------------------------------------------------

    @r.pure("length", arity=1)
    def _(a: Any) -> JsonValue:
        if isinstance(a, (list, str)):
            return len(a)
        raise EvaluationError("length: argument must be an array or string")

    @r.pure("head", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, list):
            raise EvaluationError("head: argument must be an array")
        return a[0] if a else None

    @r.pure("last", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, list):
            raise EvaluationError("last: argument must be an array")
        return a[-1] if a else None

    @r.pure("tail", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, list):
            raise EvaluationError("tail: argument must be an array")
        return list(a[1:])

    @r.pure("concat", arity=-1)
    def _(*arrays: Any) -> JsonValue:
        result: list[JsonValue] = []
        for a in arrays:
            if not isinstance(a, list):
                raise EvaluationError("concat: all arguments must be arrays")
            result.extend(a)
        return result

    @r.builtin("range", arity=1)
    def _(n: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not _is_number(n):
            raise EvaluationError("range: argument must be a number")
        length = int(n)
        if length < 0:
            length = 0
        # Guard and charge before allocating so an oversized range is rejected
        # immediately rather than after building the array.
        ctx.guard_size(length)
        ctx.charge(length)
        return list(range(length))

    @r.pure("slice", arity=-1)
    def _(*args: Any) -> JsonValue:
        if len(args) < 2:
            raise EvaluationError("slice: requires at least (target, start)")
        target, start = args[0], args[1]
        if not _is_number(start):
            raise EvaluationError("slice: start must be a number")
        s = int(start)
        end_arg = args[2] if len(args) > 2 else None
        if isinstance(target, list):
            if s < 0:
                s = len(target) + s
            if s < 0:
                s = 0
            if end_arg is not None:
                if not _is_number(end_arg):
                    raise EvaluationError("slice: end must be a number")
                e = int(end_arg)
                if e < 0:
                    e = len(target) + e
                if e > len(target):
                    e = len(target)
                if s > e:
                    return []
                return list(target[s:e])
            if s >= len(target):
                return []
            return list(target[s:])
        if isinstance(target, str):
            if s < 0:
                s = len(target) + s
            if s < 0:
                s = 0
            if end_arg is not None:
                if not _is_number(end_arg):
                    raise EvaluationError("slice: end must be a number")
                e = int(end_arg)
                if e < 0:
                    e = len(target) + e
                if e > len(target):
                    e = len(target)
                if s > e:
                    return ""
                return target[s:e]
            if s >= len(target):
                return ""
            return target[s:]
        raise EvaluationError("slice: first argument must be an array or string")

    @r.pure("reverse", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, list):
            raise EvaluationError("reverse: argument must be an array")
        return list(reversed(a))

    @r.pure("includes", arity=2)
    def _(target: Any, value: Any) -> JsonValue:
        if isinstance(target, list):
            return any(_strict_equal(item, value) for item in target)
        if isinstance(target, str):
            if not isinstance(value, str):
                return False
            return value in target
        raise EvaluationError("includes: first argument must be an array or string")

    @r.pure("indexOf", arity=2)
    def _(target: Any, value: Any) -> JsonValue:
        if isinstance(target, list):
            for i, item in enumerate(target):
                if _strict_equal(item, value):
                    return i
            return -1
        if isinstance(target, str):
            if not isinstance(value, str):
                return -1
            return target.find(value)
        raise EvaluationError("indexOf: first argument must be an array or string")

    @r.pure("flatten", arity=1)
    def _(a: Any) -> JsonValue:
        if not isinstance(a, list):
            raise EvaluationError("flatten: argument must be an array")
        result: list[JsonValue] = []
        for item in a:
            if isinstance(item, list):
                result.extend(item)
            else:
                result.append(item)
        return result

    @r.pure("setAt", arity=3)
    def _(arr: Any, idx: Any, value: Any) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("setAt: first argument must be an array")
        if not _is_number(idx):
            raise EvaluationError("setAt: second argument must be a number")
        i = int(idx)
        if i < 0 or i >= len(arr):
            raise EvaluationError(f"setAt: index {i} out of bounds for array of length {len(arr)}")
        result = list(arr)
        result[i] = value
        return result

    # --- strings ----------------------------------------------------------

    @r.pure("upper", arity=1)
    def _(s: Any) -> JsonValue:
        if not isinstance(s, str):
            raise EvaluationError("upper: argument must be a string")
        return s.upper()

    @r.pure("lower", arity=1)
    def _(s: Any) -> JsonValue:
        if not isinstance(s, str):
            raise EvaluationError("lower: argument must be a string")
        return s.lower()

    @r.pure("trim", arity=1)
    def _(s: Any) -> JsonValue:
        if not isinstance(s, str):
            raise EvaluationError("trim: argument must be a string")
        return s.strip()

    @r.pure("strcat", arity=-1)
    def _(*parts: Any) -> JsonValue:
        if not all(isinstance(p, str) for p in parts):
            raise EvaluationError("strcat: arguments must be strings")
        return "".join(parts)

    @r.pure("split", arity=2)
    def _(s: Any, sep: Any) -> JsonValue:
        if not (isinstance(s, str) and isinstance(sep, str)):
            raise EvaluationError("split: arguments must be strings")
        # Python's "".split("") raises; matching Go's "" -> ["", ...] would be
        # weird. The spec doesn't exercise this so default to Python behavior.
        if sep == "":
            return list(s)
        return s.split(sep)

    @r.pure("join", arity=2)
    def _(arr: Any, sep: Any) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("join: first argument must be an array")
        if not isinstance(sep, str):
            raise EvaluationError("join: second argument must be a string")
        parts = [v if isinstance(v, str) else _json_dump(v) for v in arr]
        return sep.join(parts)

    # --- objects ---------------------------------------------------------

    @r.pure("keys", arity=1)
    def _(obj: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("keys: argument must be an object")
        # Sort for cross-language determinism (matches Go).
        return sorted(obj.keys())

    @r.pure("values", arity=1)
    def _(obj: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("values: argument must be an object")
        return [obj[k] for k in sorted(obj.keys())]

    @r.pure("entries", arity=1)
    def _(obj: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("entries: argument must be an object")
        return [[k, obj[k]] for k in sorted(obj.keys())]

    @r.pure("fromEntries", arity=1)
    def _(pairs: Any) -> JsonValue:
        if not isinstance(pairs, list):
            raise EvaluationError("fromEntries: argument must be an array")
        result: dict[str, JsonValue] = {}
        for pair in pairs:
            if not isinstance(pair, list) or len(pair) < 2:
                raise EvaluationError("fromEntries: each entry must be a [key, value] pair")
            key = pair[0]
            if not isinstance(key, str):
                raise EvaluationError("fromEntries: keys must be strings")
            result[key] = pair[1]
        return result

    @r.pure("merge", arity=2)
    def _(a: Any, b: Any) -> JsonValue:
        if not (isinstance(a, dict) and isinstance(b, dict)):
            raise EvaluationError("merge: arguments must be objects")
        return {**a, **b}

    @r.pure("hasKey", arity=2)
    def _(obj: Any, key: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("hasKey: first argument must be an object")
        if not isinstance(key, str):
            raise EvaluationError("hasKey: second argument must be a string")
        return key in obj

    @r.pure("pick", arity=2)
    def _(obj: Any, keys: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("pick: first argument must be an object")
        if not isinstance(keys, list):
            raise EvaluationError("pick: second argument must be an array")
        return {k: obj[k] for k in keys if isinstance(k, str) and k in obj}

    @r.pure("omit", arity=2)
    def _(obj: Any, keys: Any) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("omit: first argument must be an object")
        if not isinstance(keys, list):
            raise EvaluationError("omit: second argument must be an array")
        excl = {k for k in keys if isinstance(k, str)}
        return {k: v for k, v in obj.items() if k not in excl}

    # --- regex (pure) ------------------------------------------------------

    @r.pure("reTest", arity=2)
    def _(pattern: Any, s: Any) -> JsonValue:
        if not (isinstance(pattern, str) and isinstance(s, str)):
            raise EvaluationError("reTest: arguments must be strings")
        return _compile_pattern(pattern, "reTest").search(s) is not None

    @r.pure("reMatch", arity=2)
    def _(pattern: Any, s: Any) -> JsonValue:
        if not (isinstance(pattern, str) and isinstance(s, str)):
            raise EvaluationError("reMatch: arguments must be strings")
        m = _compile_pattern(pattern, "reMatch").search(s)
        if m is None:
            return None
        return _build_match_result(m)

    @r.pure("reMatchAll", arity=2)
    def _(pattern: Any, s: Any) -> JsonValue:
        if not (isinstance(pattern, str) and isinstance(s, str)):
            raise EvaluationError("reMatchAll: arguments must be strings")
        return [_build_match_result(m) for m in _compile_pattern(pattern, "reMatchAll").finditer(s)]

    @r.pure("reReplace", arity=3)
    def _(pattern: Any, replacement: Any, s: Any) -> JsonValue:
        if not (isinstance(pattern, str) and isinstance(replacement, str) and isinstance(s, str)):
            raise EvaluationError("reReplace: arguments must be strings")
        return _compile_pattern(pattern, "reReplace").sub(_translate_replacement(replacement), s)

    @r.pure("reSplit", arity=2)
    def _(pattern: Any, s: Any) -> JsonValue:
        if not (isinstance(pattern, str) and isinstance(s, str)):
            raise EvaluationError("reSplit: arguments must be strings")
        return _compile_pattern(pattern, "reSplit").split(s)

    # --- higher-order builtins --------------------------------------------

    @r.builtin("map", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("map: second argument must be an array")
        ctx.charge(len(arr))
        return [ctx.call(callback, [item, i]) for i, item in enumerate(arr)]

    @r.builtin("filter", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("filter: second argument must be an array")
        ctx.charge(len(arr))
        return [item for i, item in enumerate(arr) if _truthy(ctx.call(callback, [item, i]))]

    @r.builtin("reduce", arity=3)
    def _(callback: Any, init: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("reduce: third argument must be an array")
        ctx.charge(len(arr))
        acc = init
        for i, item in enumerate(arr):
            acc = ctx.call(callback, [acc, item, i])
        return acc

    @r.builtin("find", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("find: second argument must be an array")
        ctx.charge(len(arr))
        for i, item in enumerate(arr):
            if _truthy(ctx.call(callback, [item, i])):
                return item
        return None

    @r.builtin("findIndex", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("findIndex: second argument must be an array")
        ctx.charge(len(arr))
        for i, item in enumerate(arr):
            if _truthy(ctx.call(callback, [item, i])):
                return i
        return -1

    @r.builtin("some", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("some: second argument must be an array")
        ctx.charge(len(arr))
        return any(_truthy(ctx.call(callback, [item, i])) for i, item in enumerate(arr))

    @r.builtin("every", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("every: second argument must be an array")
        ctx.charge(len(arr))
        return all(_truthy(ctx.call(callback, [item, i])) for i, item in enumerate(arr))

    @r.builtin("sort", arity=2)
    def _(comparator: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("sort: second argument must be an array")
        ctx.charge(len(arr))

        def cmp(a: Any, b: Any) -> int:
            v = ctx.call(comparator, [a, b])
            if not _is_number(v):
                return 0
            if v < 0:
                return -1
            if v > 0:
                return 1
            return 0

        return sorted(arr, key=cmp_to_key(cmp))

    @r.builtin("sortBy", arity=2)
    def _(key_fn: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("sortBy: second argument must be an array")
        ctx.charge(len(arr))
        decorated = [(ctx.call(key_fn, [item, i]), i, item) for i, item in enumerate(arr)]

        # `i` in the tuple gives us a stable tiebreaker; the comparator uses
        # _json_less for cross-type ordering parity with Go.
        def cmp(a: tuple[Any, int, Any], b: tuple[Any, int, Any]) -> int:
            if _json_less(a[0], b[0]):
                return -1
            if _json_less(b[0], a[0]):
                return 1
            return (a[1] > b[1]) - (a[1] < b[1])

        decorated.sort(key=cmp_to_key(cmp))
        return [item for _k, _i, item in decorated]

    @r.builtin("flatMap", arity=2)
    def _(callback: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("flatMap: second argument must be an array")
        ctx.charge(len(arr))
        result: list[JsonValue] = []
        for i, item in enumerate(arr):
            mapped = ctx.call(callback, [item, i])
            if isinstance(mapped, list):
                result.extend(mapped)
            else:
                result.append(mapped)
        ctx.guard_size(len(result))
        return result

    @r.builtin("groupBy", arity=2)
    def _(key_fn: Any, arr: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(arr, list):
            raise EvaluationError("groupBy: second argument must be an array")
        ctx.charge(len(arr))
        groups: dict[str, list[JsonValue]] = {}
        for i, item in enumerate(arr):
            key = ctx.call(key_fn, [item, i])
            if isinstance(key, str):
                k = key
            elif _is_number(key):
                # Match Go's strconv.FormatFloat(..., 'f', -1, 64) — shortest
                # representation that round-trips.
                k = _format_number_key(key)
            else:
                raise EvaluationError(
                    f"groupBy: key function must return a string or number, "
                    f"got {type(key).__name__}"
                )
            groups.setdefault(k, []).append(item)
        return groups

    @r.builtin("mapValues", arity=2)
    def _(callback: Any, obj: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(obj, dict):
            raise EvaluationError("mapValues: second argument must be an object")
        ctx.charge(len(obj))
        return {k: ctx.call(callback, [v, k]) for k, v in obj.items()}

    @r.builtin("apply", arity=2)
    def _(fn: Any, args_array: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(args_array, list):
            raise EvaluationError("apply: second argument must be an array")
        return ctx.call(fn, list(args_array))

    @r.builtin("pipe", arity=2)
    def _(fns: Any, init: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(fns, list):
            raise EvaluationError("pipe: first argument must be an array of functions")
        ctx.charge(len(fns))
        value = init
        for fn in fns:
            value = ctx.call(fn, [value])
        return value

    @r.builtin("reReplaceWith", arity=3)
    def _(pattern: Any, callback: Any, s: Any, *, ctx: BuiltinContext) -> JsonValue:
        if not isinstance(pattern, str):
            raise EvaluationError("reReplaceWith: first argument must be a pattern string")
        if not isinstance(s, str):
            raise EvaluationError("reReplaceWith: third argument must be a string")
        ctx.charge(len(s))
        compiled = _compile_pattern(pattern, "reReplaceWith")

        def _replace(m: re.Match[str]) -> str:
            replacement = ctx.call(callback, [_build_match_result(m)])
            return replacement if isinstance(replacement, str) else _json_dump(replacement)

        return compiled.sub(_replace, s)

    # --- introspection -----------------------------------------------------

    @r.builtin("arity", arity=1)
    def _(fn: Any, *, ctx: BuiltinContext) -> JsonValue:
        a = _arity_of(fn, ctx.registry)
        return None if a < 0 else a

    # --- debugging ---------------------------------------------------------

    @r.pure("log", arity=2)
    def _(value: Any, label: Any = _MISSING) -> JsonValue:
        if logger is not None:
            if label is not _MISSING:
                logger(value, label)
            else:
                logger(value)
        return value

    return r.build()


def _format_number_key(n: int | float) -> str:
    """Shortest decimal representation suitable as a dict key — used by
    ``groupBy`` to match Go's behavior across implementations."""
    if isinstance(n, int):
        return str(n)
    if n.is_integer():
        return str(int(n))
    return repr(n)
