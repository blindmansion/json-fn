"""Tree-walking interpreter for json-fn.

The :class:`Interpreter` class encapsulates the evaluation state (registry,
limits, depth + operations counters). Per-frame state (variable bindings,
local function declarations, scoped registry overlay) lives on the call
stack: ``_call_json_function`` builds a ``get_var`` closure and pushes a
scoped registry via try/finally.

The public entry point is :func:`call_function`; users typically obtain a
registry via :func:`jsonfn.create_stdlib` and never instantiate an
:class:`Interpreter` directly.
"""

from __future__ import annotations

import json
from typing import Any

from .errors import (
    CycleError,
    EvaluationError,
    JsonFnError,
    LimitExceededError,
)
from .path import parse_path, walk_path
from .types import (
    BuiltinContext,
    ExecutionLimits,
    ExpressionType,
    FunctionRegistry,
    JsonValue,
    _BuiltinEntry,
    _PureEntry,
)


def call_function(
    fn: Any,
    args: list[JsonValue] | tuple[JsonValue, ...] | None,
    registry: FunctionRegistry,
    limits: ExecutionLimits | None = None,
) -> JsonValue:
    """Top-level entry point for evaluating a json-fn program.

    ``fn`` is either a function name (string, looked up in ``registry``) or a
    function body dict (containing ``$return``). ``args`` are bound positionally
    to the body's ``$params``.

    Raises :class:`JsonFnError` on any evaluation failure.
    """
    return Interpreter(registry, limits).call(fn, list(args) if args else [])


class Interpreter:
    """A single evaluation context.

    Instances are reusable across top-level :meth:`call` invocations as long
    as you don't share them across threads (depth/operations counters and the
    registry slot are mutated in place).
    """

    __slots__ = ("_depth", "_operations", "limits", "registry")

    def __init__(
        self,
        registry: FunctionRegistry,
        limits: ExecutionLimits | None = None,
    ) -> None:
        self.registry: FunctionRegistry = registry
        self.limits: ExecutionLimits = limits or ExecutionLimits()
        self._depth: int = 0
        self._operations: int = 0

    # -- public --------------------------------------------------------------

    def call(
        self,
        fn: Any,
        args: list[JsonValue],
        parent_get_var: Any = None,
    ) -> JsonValue:
        """Invoke ``fn`` with ``args``. Increments call-depth counter; raises
        :class:`LimitExceededError` if the configured maximum is exceeded.

        ``parent_get_var`` is the variable resolver of the caller's frame.
        Pure/builtin entries ignore it; JSON-body entries pass it down to
        :meth:`_call_json_function` so inline function bodies inherit the
        evaluation-time scope chain (matching Go and TypeScript).
        """
        self._depth += 1
        if self._depth > self.limits.max_call_depth:
            self._depth -= 1
            raise LimitExceededError(f"Maximum call depth of {self.limits.max_call_depth} exceeded")
        try:
            if isinstance(fn, str):
                entry = self.registry.get(fn)
                if entry is None:
                    raise EvaluationError(f"Function {fn} not found")
                if isinstance(entry, _PureEntry):
                    # Match Go semantics: pure functions silently ignore extra
                    # args beyond their declared arity. This matters when a
                    # pure function (e.g. `add`) is used as a callback to a
                    # builtin (e.g. `reduce`) that supplies more positional
                    # args than the function consumes.
                    call_args = args if entry.arity < 0 else args[: entry.arity]
                    try:
                        return entry.fn(*call_args)
                    except JsonFnError:
                        raise
                    except Exception as e:
                        raise EvaluationError(f"Error calling external function {fn}: {e}") from e
                if isinstance(entry, _BuiltinEntry):
                    captured_parent = parent_get_var
                    interp = self

                    def _ctx_call(cfn: Any, cargs: list[JsonValue]) -> JsonValue:
                        return interp.call(cfn, cargs, captured_parent)

                    ctx = BuiltinContext(call=_ctx_call, registry=self.registry)
                    return entry.fn(*args, ctx=ctx)
                if isinstance(entry, dict):
                    return self._call_json_function(entry, args, parent_get_var)
                raise EvaluationError(f"Function {fn} has unsupported type {type(entry).__name__}")
            if isinstance(fn, dict) and "$return" in fn:
                return self._call_json_function(fn, args, parent_get_var)
            raise EvaluationError(f"cannot call non-function value of type {type(fn).__name__}")
        finally:
            self._depth -= 1

    # -- json function bodies ------------------------------------------------

    def _call_json_function(
        self,
        body: dict[str, Any],
        args: list[JsonValue],
        parent_get_var: Any,
    ) -> JsonValue:
        # 1. Discover sibling-defined function bodies (locals whose value is
        #    itself a function body). These get registered into a scoped
        #    registry overlay so they can be called by name from within
        #    $return — including recursively and mutually.
        local_fn_keys: list[str] = []
        for key, val in body.items():
            if key in ("$return", "$params"):
                continue
            if isinstance(val, dict) and "$return" in val:
                local_fn_keys.append(key)

        scoped_registry: FunctionRegistry | None = None
        if local_fn_keys:
            scoped_registry = dict(self.registry)
            for key in local_fn_keys:
                scoped_registry[key] = body[key]

        # 2. Bind $params positionally into the eager-evaluated bindings.
        evaluated_vars: dict[str, JsonValue] = {}
        params = body.get("$params")
        if isinstance(params, list):
            for i, p in enumerate(params):
                if not isinstance(p, str) or not p:
                    continue
                if p.startswith("..."):
                    rest_name = p[3:]
                    _validate_param_name(rest_name)
                    evaluated_vars[rest_name] = list(args[i:])
                    break
                _validate_param_name(p)
                evaluated_vars[p] = args[i] if i < len(args) else None

        # 3. Build the per-frame get_var closure. Locals are evaluated lazily
        #    on first access and cached. We detect cycles by maintaining a
        #    list of names currently being resolved.
        resolving: list[str] = []

        def get_var(name: str) -> JsonValue:
            if name in evaluated_vars:
                return evaluated_vars[name]
            if name in resolving:
                cycle_start = resolving.index(name)
                cycle = " -> ".join([*resolving[cycle_start:], name])
                raise CycleError(f"Circular variable dependency detected: {cycle}")
            if name in body and name not in ("$return", "$params"):
                resolving.append(name)
                try:
                    if scoped_registry is not None:
                        prev = self.registry
                        self.registry = scoped_registry
                        try:
                            value = self._evaluate(body[name], get_var)
                        finally:
                            self.registry = prev
                    else:
                        value = self._evaluate(body[name], get_var)
                finally:
                    resolving.pop()
                evaluated_vars[name] = value
                return value
            if parent_get_var is not None:
                return parent_get_var(name)
            return _MISSING

        # 4. For local-function bodies, substitute outer variables now so the
        #    callable form captures its lexical scope (matching closure
        #    semantics). The scoped registry's entry is replaced with the
        #    rewritten body.
        if scoped_registry is not None:
            for key in local_fn_keys:
                rewritten = self._replace_vars(body[key], get_var)
                if isinstance(rewritten, dict):
                    scoped_registry[key] = rewritten

        # 5. Evaluate $return under the (possibly scoped) registry.
        if scoped_registry is not None:
            prev = self.registry
            self.registry = scoped_registry
            try:
                return self._evaluate(body["$return"], get_var)
            finally:
                self.registry = prev
        return self._evaluate(body["$return"], get_var)

    # -- evaluation ----------------------------------------------------------

    def _evaluate(self, expr: Any, get_var: Any) -> JsonValue:
        # Cancellation + operations cap (parallels Go's evaluateExpression
        # preamble). Counted per expression visit, not per call.
        if self.limits.cancel is not None and self.limits.cancel.is_set():
            raise LimitExceededError("Execution aborted")
        if self.limits.max_operations is not None:
            self._operations += 1
            if self._operations > self.limits.max_operations:
                raise LimitExceededError(
                    f"Maximum operations limit of {self.limits.max_operations} exceeded"
                )

        kind = self._classify(expr)

        match kind:
            case (
                ExpressionType.STRING
                | ExpressionType.NUMBER
                | ExpressionType.BOOLEAN
                | ExpressionType.NULL
            ):
                return expr

            case ExpressionType.ARRAY:
                return [self._evaluate(item, get_var) for item in expr]

            case ExpressionType.OBJECT:
                return {k: self._evaluate(v, get_var) for k, v in expr.items()}

            case ExpressionType.LITERAL:
                return expr["$literal"]

            case ExpressionType.FUNCTION_CALL:
                fn_arr = expr["$fn"]
                fn_decl = self._evaluate(fn_arr[0], get_var)
                if not _is_fn_declaration(fn_decl):
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            f"Evaluated function references must be strings or "
                            f"function bodies. Got {_type_label(fn_decl)}.",
                        )
                    )
                eval_args = [self._evaluate(a, get_var) for a in fn_arr[1:]]
                return self.call(fn_decl, eval_args, parent_get_var=get_var)

            case ExpressionType.FUNCTION_REFERENCE:
                ref = self._evaluate(expr["$fn"], get_var)
                if not _is_fn_declaration(ref):
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            f"Evaluated function references must be strings or "
                            f"function bodies. Got {_type_label(ref)}.",
                        )
                    )
                return ref

            case ExpressionType.VARIABLE_REFERENCE:
                if get_var is None:
                    raise EvaluationError(_expr_error(expr, "getVar is not defined."))
                return self._resolve_var(expr["$var"], get_var, expr)

            case ExpressionType.FUNCTION_BODY:
                if get_var is None:
                    return expr
                return self._replace_vars(expr, get_var)

            case ExpressionType.CONDITIONAL:
                cond = self._evaluate(expr["$if"], get_var)
                branch = expr["$then"] if _truthy(cond) else expr["$else"]
                return self._evaluate(branch, get_var)

            case ExpressionType.COND:
                for pair in expr["$cond"]:
                    if _truthy(self._evaluate(pair[0], get_var)):
                        return self._evaluate(pair[1], get_var)
                raise EvaluationError(
                    _expr_error(
                        expr,
                        "No $cond branch matched (add a [true, ...] catch-all).",
                    )
                )

            case ExpressionType.AND:
                result: JsonValue = True
                for sub in expr["$and"]:
                    result = self._evaluate(sub, get_var)
                    if not _truthy(result):
                        return result
                return result

            case ExpressionType.OR:
                result_or: JsonValue = False
                for sub in expr["$or"]:
                    result_or = self._evaluate(sub, get_var)
                    if _truthy(result_or):
                        return result_or
                return result_or

            case ExpressionType.PROPERTY_ACCESS:
                return self._evaluate_property_access(expr, get_var)

        # Unreachable in well-formed input; _classify raises on bad shapes.
        raise EvaluationError(_expr_error(expr, "Unrecognized expression type."))

    def _resolve_var(
        self,
        var_path: str,
        get_var: Any,
        expression: Any,
    ) -> JsonValue:
        variable, segments = parse_path(var_path)
        value = get_var(variable)
        if value is _MISSING:
            raise EvaluationError(_expr_error(expression, f"Variable {variable} not found."))
        if segments:
            return walk_path(value, segments)
        return value

    def _evaluate_property_access(
        self,
        expr: dict[str, Any],
        get_var: Any,
    ) -> JsonValue:
        evaluated_key = self._evaluate(expr["$get"], get_var)

        if "$var" in expr:
            if get_var is None:
                raise EvaluationError(_expr_error(expr, "getVar is not defined."))
            target = self._resolve_var(expr["$var"], get_var, expr)
        else:
            target = self._evaluate(expr["$from"], get_var)

        if target is None:
            raise EvaluationError(
                "Invalid $get target: expected object, array, or string, got null"
            )

        # String target: only numeric keys make sense.
        if isinstance(target, str):
            if isinstance(evaluated_key, bool) or not isinstance(evaluated_key, int):
                raise EvaluationError(
                    "Invalid $get key for string: expected number, got " + json.dumps(evaluated_key)
                )
            idx = evaluated_key
            if 0 <= idx < len(target):
                return target[idx]
            return None

        if isinstance(target, (dict, list)):
            return _property_lookup(target, evaluated_key)

        raise EvaluationError(
            "Invalid $get target: expected object, array, or string, got " + json.dumps(target)
        )

    # -- closure substitution ------------------------------------------------

    def _replace_vars(self, expression: Any, get_var: Any) -> JsonValue:
        """Substitute ``$var`` references with their values from ``get_var``,
        masking out any names shadowed by inner ``$params``/locals.

        Used when a function body appears in expression position (i.e. is
        returned as a value) so outer-scope variables are baked in and the
        result is a self-contained, callable body.
        """
        if isinstance(expression, list):
            return [self._replace_vars(item, get_var) for item in expression]
        if not isinstance(expression, dict):
            return expression

        # $var with optional $get
        if "$var" in expression and isinstance(expression["$var"], str):
            return self._replace_var_node(expression, get_var)

        # Function body: mask shadowed names before recursing into children.
        if "$return" in expression:
            local_names: set[str] = {k for k in expression if k not in ("$return", "$params")}
            params = expression.get("$params")
            if isinstance(params, list):
                for p in params:
                    if isinstance(p, str):
                        local_names.add(p[3:] if p.startswith("...") else p)
            if local_names:

                def masked(name: str, _outer: Any = get_var) -> JsonValue:
                    if name in local_names:
                        return _MISSING
                    return _outer(name)

                inner_get_var: Any = masked
            else:
                inner_get_var = get_var
            return {k: self._replace_vars(v, inner_get_var) for k, v in expression.items()}

        return {k: self._replace_vars(v, get_var) for k, v in expression.items()}

    def _replace_var_node(
        self,
        expression: dict[str, Any],
        get_var: Any,
    ) -> JsonValue:
        var_name = expression["$var"]
        variable, segments = parse_path(var_name)

        if "$get" in expression:
            value = get_var(variable)
            replaced_key = self._replace_vars(expression["$get"], get_var)
            if value is not _MISSING:
                if segments:
                    path_key: Any = segments[0] if len(segments) == 1 else list(segments)
                    return {
                        "$get": replaced_key,
                        "$from": {"$get": path_key, "$from": value},
                    }
                return {"$get": replaced_key, "$from": value}
            return {"$var": var_name, "$get": replaced_key}

        value = get_var(variable)
        if value is _MISSING:
            return expression
        if segments:
            path_key2: Any = segments[0] if len(segments) == 1 else list(segments)
            return {"$get": path_key2, "$from": value}
        return value

    # -- expression classification ------------------------------------------

    def _classify(self, expr: Any) -> ExpressionType:
        """Determine the json-fn expression type by shape. Validates structural
        invariants (matching key counts, required-key presence) and raises
        :class:`EvaluationError` with spec-aligned messages on malformed input.
        """
        if expr is None:
            return ExpressionType.NULL
        if isinstance(expr, bool):
            return ExpressionType.BOOLEAN
        if isinstance(expr, (int, float)):
            return ExpressionType.NUMBER
        if isinstance(expr, str):
            return ExpressionType.STRING
        if isinstance(expr, list):
            return ExpressionType.ARRAY
        if isinstance(expr, dict):
            return _classify_object(expr)
        raise EvaluationError(_expr_error(expr, "Unrecognized expression type."))


# --- module-level helpers -----------------------------------------------------


_MISSING: Any = object()
"""Sentinel for "variable not found" — distinct from a legitimate ``None``
value, which is a perfectly valid JSON value."""


def _truthy(v: Any) -> bool:
    """json-fn truthiness: only ``None``, ``False``, ``0``, ``0.0``, and
    ``""`` are falsy. Empty list/dict are TRUTHY (unlike Python's natural
    semantics) — matches JavaScript-style truthiness used by the spec.
    """
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v != ""
    return True


def _is_fn_declaration(value: Any) -> bool:
    """A function declaration is a name (string) or a body dict (with
    ``$return``)."""
    if isinstance(value, str):
        return True
    if isinstance(value, dict):
        return "$return" in value
    return False


def _validate_param_name(name: str) -> None:
    if "." in name or "[" in name:
        raise EvaluationError(
            f'Parameter name "{name}" must not contain "." or "[". Use simple identifiers.'
        )


def _expr_error(expr: Any, message: str) -> str:
    """Format a "bad expression" error message (pretty JSON of the expression
    plus a human message) — matches Go's ``exprError`` format.
    """
    try:
        rendered = json.dumps(expr, indent=2, default=str)
    except (TypeError, ValueError):
        rendered = repr(expr)
    return f"Invalid JSON expression: {rendered}. {message}"


def _type_label(value: Any) -> str:
    """Human-readable type name for error messages."""
    if value is None:
        return "<nil>"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float64"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "[]any"
    if isinstance(value, dict):
        return "map[string]any"
    return type(value).__name__


def _property_lookup(target: Any, key: Any) -> JsonValue:
    """Apply a single key (string/int) or path (list of segments) to a
    container target. Returns ``None`` for missing keys / out-of-range indices,
    raises for bad key types — matching Go's ``propertyLookup``.
    """
    if isinstance(key, bool):
        raise EvaluationError(
            "Invalid $get key: expected string, number, or array of "
            "strings/numbers, got " + json.dumps(key)
        )
    if isinstance(key, str):
        if isinstance(target, dict):
            return target.get(key)
        return None
    if isinstance(key, int):
        if isinstance(target, list) and 0 <= key < len(target):
            return target[key]
        return None
    if isinstance(key, float):
        if isinstance(target, list):
            idx = int(key)
            if 0 <= idx < len(target):
                return target[idx]
        return None
    if isinstance(key, list):
        current: Any = target
        for seg in key:
            if current is None:
                return None
            if isinstance(seg, str):
                if isinstance(current, dict):
                    current = current.get(seg)
                    if current is None:
                        return None
                else:
                    return None
            elif isinstance(seg, (int, float)) and not isinstance(seg, bool):
                idx2 = int(seg)
                if isinstance(current, list):
                    if 0 <= idx2 < len(current):
                        current = current[idx2]
                    else:
                        return None
                else:
                    return None
            else:
                raise EvaluationError("Invalid $get path segment: " + json.dumps(seg))
        return current
    raise EvaluationError(
        "Invalid $get key: expected string, number, or array of "
        "strings/numbers, got " + json.dumps(key)
    )


# --- object expression classification ----------------------------------------


def _classify_object(obj: dict[str, Any]) -> ExpressionType:
    """Given a non-empty dict, classify it. Validates structural rules
    (sole-key constraints, presence/absence of co-required keys) with error
    messages that match the Go reference so the conformance suite passes.
    """
    n = len(obj)

    if "$var" in obj:
        if not isinstance(obj["$var"], str):
            raise EvaluationError(
                _expr_error(obj, "Variable references must have a string $var property.")
            )
        if "$get" in obj:
            if n > 2:
                raise EvaluationError(
                    _expr_error(obj, "$var/$get property access cannot have other properties.")
                )
            return ExpressionType.PROPERTY_ACCESS
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "Variable references cannot have other properties.")
            )
        return ExpressionType.VARIABLE_REFERENCE

    has_get = "$get" in obj
    has_from = "$from" in obj
    if has_get or has_from:
        if not (has_get and has_from):
            raise EvaluationError(
                _expr_error(obj, "Property access expressions must have both $get and $from.")
            )
        if n > 2:
            raise EvaluationError(
                _expr_error(
                    obj, "Property access expressions cannot have more than two properties."
                )
            )
        return ExpressionType.PROPERTY_ACCESS

    if "$return" in obj:
        if "$fn" in obj:
            raise EvaluationError(
                _expr_error(obj, "Function bodies cannot have other keyword properties.")
            )
        if "$params" in obj:
            params = obj["$params"]
            if not isinstance(params, list) or not all(isinstance(p, str) for p in params):
                raise EvaluationError(_expr_error(obj, "$params must be an array of strings."))
            for p in params:
                name = p[3:] if p.startswith("...") else p
                _validate_param_name(name)
        return ExpressionType.FUNCTION_BODY

    if "$fn" in obj:
        fn_val = obj["$fn"]
        if isinstance(fn_val, list):
            if n > 1:
                raise EvaluationError(
                    _expr_error(obj, "Function calls cannot have other properties.")
                )
            return ExpressionType.FUNCTION_CALL
        if isinstance(fn_val, (str, dict)):
            if n > 1:
                raise EvaluationError(
                    _expr_error(obj, "Function references cannot have other properties.")
                )
            return ExpressionType.FUNCTION_REFERENCE

    has_if = "$if" in obj
    has_then = "$then" in obj
    has_else = "$else" in obj
    if has_if or has_then or has_else:
        if not (has_if and has_then and has_else):
            raise EvaluationError(
                _expr_error(
                    obj,
                    "Conditional expressions must have all three properties: $if, $then, $else.",
                )
            )
        if n > 3:
            raise EvaluationError(
                _expr_error(obj, "Conditional expressions cannot have more than three properties.")
            )
        return ExpressionType.CONDITIONAL

    if "$cond" in obj:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "$cond expressions cannot have other properties.")
            )
        pairs = obj["$cond"]
        if not isinstance(pairs, list):
            raise EvaluationError(
                _expr_error(obj, "$cond must be an array of [condition, result] pairs.")
            )
        for pair in pairs:
            if not isinstance(pair, list) or len(pair) != 2:
                raise EvaluationError(
                    _expr_error(obj, "Each $cond branch must be a [condition, result] pair.")
                )
        return ExpressionType.COND

    if "$and" in obj:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "$and expressions cannot have other properties.")
            )
        if not isinstance(obj["$and"], list):
            raise EvaluationError(_expr_error(obj, "$and must be an array of expressions."))
        return ExpressionType.AND

    if "$or" in obj:
        if n > 1:
            raise EvaluationError(_expr_error(obj, "$or expressions cannot have other properties."))
        if not isinstance(obj["$or"], list):
            raise EvaluationError(_expr_error(obj, "$or must be an array of expressions."))
        return ExpressionType.OR

    if "$literal" in obj:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "$literal expressions cannot have other properties.")
            )
        return ExpressionType.LITERAL

    return ExpressionType.OBJECT
