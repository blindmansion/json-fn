"""Tree-walking interpreter for json-fn.

The :class:`Interpreter` class encapsulates the evaluation state (registry,
limits, depth + fuel counters). Per-frame state (variable bindings,
local function declarations, scoped registry overlay) lives on the call
stack: ``_call_json_function`` builds a ``get_var`` closure and pushes a
scoped registry via try/finally.

The public entry point is :func:`call_function`; users typically obtain a
registry via :func:`jsonfn.create_stdlib` and never instantiate an
:class:`Interpreter` directly.
"""

from __future__ import annotations

import json
import time
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
    ExecutionUsage,
    ExpressionType,
    FunctionRegistry,
    JsonValue,
    _BuiltinEntry,
    _PureEntry,
)

_COMPARISON_OPERATORS = ("$eq", "$neq", "$lt", "$lte", "$gt", "$gte")


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
    interp = Interpreter(registry, limits)
    try:
        return interp.call(fn, list(args) if args else [])
    finally:
        interp.report_usage()


class Interpreter:
    """A single evaluation context.

    Instances are reusable across top-level :meth:`call` invocations as long
    as you don't share them across threads (depth/fuel counters and the
    registry slot are mutated in place).
    """

    __slots__ = (
        "_cancel",
        "_check_interrupt_flag",
        "_check_limits",
        "_deadline",
        "_depth",
        "_fuel",
        "_max_call_depth",
        "_max_fuel",
        "_max_value_size",
        "_track_fuel",
        "_usage",
        "limits",
        "registry",
    )

    def __init__(
        self,
        registry: FunctionRegistry,
        limits: ExecutionLimits | None = None,
    ) -> None:
        self.registry: FunctionRegistry = registry
        self.limits: ExecutionLimits = limits or ExecutionLimits()
        self._depth: int = 0
        self._fuel: int = 0
        # Hoist limits to plain ivars so the per-evaluate hot path can do a
        # single attribute lookup (and short-circuit when nothing is configured).
        self._max_call_depth: int = self.limits.max_call_depth
        self._max_fuel: int | None = self.limits.max_fuel
        self._max_value_size: int | None = self.limits.max_value_size
        self._cancel: Any = self.limits.cancel
        self._usage: ExecutionUsage | None = self.limits.usage
        # Wall-clock backstop: resolve the timeout to an absolute monotonic
        # deadline at construction (call_function builds a fresh interpreter
        # per run, so this coincides with the start of evaluation).
        timeout_ms = self.limits.timeout_ms
        self._deadline: float | None = (
            time.monotonic() + timeout_ms / 1000.0 if timeout_ms is not None else None
        )
        # Cancellation + deadline share one cheap "should I check for an
        # interrupt?" flag so the hot path branches once.
        self._check_interrupt_flag: bool = self._cancel is not None or self._deadline is not None
        # Fuel is metered whenever a budget is set OR a usage sink wants the
        # total. Size limits are enforced independently (see _guard_value_size).
        self._track_fuel: bool = self._max_fuel is not None or self._usage is not None
        self._check_limits: bool = self._track_fuel or self._check_interrupt_flag

    # -- limit metering ------------------------------------------------------

    def _check_interrupt(self) -> None:
        """Cooperative cancellation + wall-clock backstop. Neither charges
        fuel, so anchor fuel counts are unaffected. Called at every node and
        every invocation so native higher-order loops over pure builtins —
        which never re-enter :meth:`_evaluate` — can still be aborted."""
        cancel = self._cancel
        if cancel is not None and cancel.is_set():
            raise LimitExceededError("Execution aborted")
        deadline = self._deadline
        if deadline is not None and time.monotonic() > deadline:
            raise LimitExceededError("Execution timed out")

    def _charge_fuel(self, amount: int) -> None:
        """Decrement the shared fuel budget by ``amount``. No-op when fuel is
        not metered. Raises :class:`LimitExceededError` on exhaustion."""
        if not self._track_fuel:
            return
        self._fuel += amount
        if self._max_fuel is not None and self._fuel > self._max_fuel:
            raise LimitExceededError(f"Maximum fuel limit of {self._max_fuel} exceeded")

    def _guard_value_size(self, size: int) -> None:
        """Enforce ``max_value_size`` for a produced array/string length.
        Always enforced (independent of fuel tracking)."""
        mvs = self._max_value_size
        if mvs is not None and size > mvs:
            raise LimitExceededError(f"Maximum value size of {mvs} exceeded")

    def _account_for_result(self, result: Any) -> None:
        """Charge fuel + enforce the size cap for values produced by pure host
        functions, proportional to any produced array/string length. Keeps
        size-growing pure builtins (concat, flatten, split, join, ...) honest
        without each needing to self-meter."""
        t = type(result)
        if t is str or t is list:
            size = len(result)
            self._guard_value_size(size)
            self._charge_fuel(size)

    def report_usage(self) -> None:
        """Write the consumed fuel into the configured :class:`ExecutionUsage`
        (if any). Called by :func:`call_function` once evaluation finishes."""
        if self._usage is not None:
            self._usage.fuel = self._fuel

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
        # Charge one fuel per invocation. This single charge closes the
        # op-bomb: every HOF callback dispatch and every pure-builtin call now
        # costs fuel, regardless of whether it re-enters _evaluate. The same
        # chokepoint is where we honor cancellation/deadline so native
        # higher-order loops over pure builtins can still be interrupted.
        if self._check_interrupt_flag:
            self._check_interrupt()
        self._charge_fuel(1)
        depth = self._depth + 1
        if depth > self._max_call_depth:
            raise LimitExceededError(f"Maximum call depth of {self._max_call_depth} exceeded")
        self._depth = depth
        try:
            if type(fn) is str:
                entry = self.registry.get(fn)
                if entry is None:
                    raise EvaluationError(f"Function {fn} not found")
                if isinstance(entry, _PureEntry):
                    # Match Go semantics: pure functions silently ignore extra
                    # args beyond their declared arity. Skip the slice when the
                    # arg count already matches (the dominant case).
                    arity = entry.arity
                    call_args = args[:arity] if arity >= 0 and len(args) != arity else args
                    try:
                        result = entry.fn(*call_args)
                    except JsonFnError:
                        raise
                    except Exception as e:
                        raise EvaluationError(f"Error calling external function {fn}: {e}") from e
                    self._account_for_result(result)
                    return result
                if isinstance(entry, _BuiltinEntry):
                    captured_parent = parent_get_var
                    interp = self

                    def _ctx_call(cfn: Any, cargs: list[JsonValue]) -> JsonValue:
                        return interp.call(cfn, cargs, captured_parent)

                    ctx = BuiltinContext(
                        call=_ctx_call,
                        registry=self.registry,
                        charge=self._charge_fuel,
                        guard_size=self._guard_value_size,
                    )
                    return entry.fn(*args, ctx=ctx)
                if isinstance(entry, dict):
                    return self._call_json_function(entry, args, parent_get_var)
                raise EvaluationError(f"Function {fn} has unsupported type {type(entry).__name__}")
            if isinstance(fn, dict) and "$return" in fn:
                return self._call_json_function(fn, args, parent_get_var)
            raise EvaluationError(f"cannot call non-function value of type {type(fn).__name__}")
        finally:
            self._depth = depth - 1

    # -- json function bodies ------------------------------------------------

    def _call_json_function(
        self,
        body: dict[str, Any],
        args: list[JsonValue],
        parent_get_var: Any,
    ) -> JsonValue:
        # 1. Bind $params positionally into the eager-evaluated bindings.
        evaluated_vars: dict[str, JsonValue] = {}
        params = body.get("$params")
        if params is not None and params.__class__ is list:
            n_args = len(args)
            for i, p in enumerate(params):
                if p.__class__ is not str or not p:
                    continue
                if p[:3] == "...":
                    rest_name = p[3:]
                    _validate_param_name(rest_name)
                    evaluated_vars[rest_name] = list(args[i:])
                    break
                _validate_param_name(p)
                evaluated_vars[p] = args[i] if i < n_args else None

        # 2. Determine whether this body has any body-level locals (vars or
        #    sibling-defined function bodies). The hot path — recursive user
        #    functions like `fib` whose body is just $params/$return — has
        #    none, so we use a much cheaper closure for them.
        has_body_locals = False
        local_fn_keys: list[str] | None = None
        for key, val in body.items():
            if key == "$return" or key == "$params":
                continue
            if key == "$comment" and val.__class__ is str:
                continue
            has_body_locals = True
            if val.__class__ is dict and "$return" in val:
                if local_fn_keys is None:
                    local_fn_keys = [key]
                else:
                    local_fn_keys.append(key)

        # ----- Fast path: $params + $return only --------------------------------
        if not has_body_locals:
            if parent_get_var is None:

                def get_var_fast(
                    name: str, _ev: dict[str, JsonValue] = evaluated_vars
                ) -> JsonValue:
                    return _ev.get(name, _MISSING)

                return self._evaluate(body["$return"], get_var_fast)

            def get_var_fast2(
                name: str,
                _ev: dict[str, JsonValue] = evaluated_vars,
                _parent: Any = parent_get_var,
            ) -> JsonValue:
                v = _ev.get(name, _MISSING)
                if v is _MISSING:
                    return _parent(name)
                return v

            return self._evaluate(body["$return"], get_var_fast2)

        # ----- Slow path: body-level locals (lazy + cycle detection) ------------
        scoped_registry: FunctionRegistry | None = None
        if local_fn_keys is not None:
            scoped_registry = dict(self.registry)
            for key in local_fn_keys:
                scoped_registry[key] = body[key]

        resolving: list[str] = []

        def get_var(name: str) -> JsonValue:
            if name in evaluated_vars:
                return evaluated_vars[name]
            if name in resolving:
                cycle_start = resolving.index(name)
                cycle = " -> ".join([*resolving[cycle_start:], name])
                raise CycleError(f"Circular variable dependency detected: {cycle}")
            if name in body and name not in ("$return", "$params"):
                if name == "$comment" and body[name].__class__ is str:
                    if parent_get_var is not None:
                        return parent_get_var(name)
                    return _MISSING
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

        if scoped_registry is not None and local_fn_keys is not None:
            for key in local_fn_keys:
                rewritten = self._replace_vars(body[key], get_var)
                if isinstance(rewritten, dict):
                    scoped_registry[key] = rewritten

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
        # Cancellation + per-node fuel charge (parallels Go's
        # evaluateExpression preamble). Hoisted behind a single flag so the
        # common case of "no limits configured" hits no extra branches.
        if self._check_limits:
            if self._check_interrupt_flag:
                self._check_interrupt()
            if self._track_fuel:
                self._fuel += 1
                if self._max_fuel is not None and self._fuel > self._max_fuel:
                    raise LimitExceededError(f"Maximum fuel limit of {self._max_fuel} exceeded")

        # Inline type-based dispatch. The `_classify` method is still used for
        # validation paths (and in case anyone subclasses), but the hot path
        # avoids it because every cycle counts when an interpreter visits
        # millions of expressions per second.
        t = expr.__class__
        if t is dict:
            # Fast key dispatch: most expressions have a single special key,
            # so a chain of `key in dict` is faster than calling _classify
            # which does a fixed sweep over many keys.
            if "$fn" in expr:
                fn_arr = expr["$fn"]
                if fn_arr.__class__ is list:
                    if _expr_key_count(expr) != 1:
                        raise EvaluationError(
                            _expr_error(expr, "Function calls cannot have other properties.")
                        )
                    head = fn_arr[0]
                    # Hot path: literal-string function name with a stdlib pure
                    # entry. Inline the entire dispatch so we save a Python
                    # call frame per invocation (and most $fn calls in real
                    # programs are exactly this shape: `["add", x, y]`).
                    if head.__class__ is str:
                        entry = self.registry.get(head)
                        if entry is None:
                            raise EvaluationError(f"Function {head} not found")
                        if isinstance(entry, _PureEntry):
                            # Evaluate args FIRST (matches Interpreter.call
                            # semantics: only the dispatch itself counts as a
                            # call-depth increment, not the argument evaluation
                            # — otherwise the counter would balloon past
                            # max_call_depth on recursive expression trees).
                            eval_args = [self._evaluate(a, get_var) for a in fn_arr[1:]]
                            # Per-invocation fuel charge (this inlined path
                            # bypasses Interpreter.call, so it must charge here
                            # to keep the meter honest).
                            self._charge_fuel(1)
                            depth = self._depth + 1
                            if depth > self._max_call_depth:
                                raise LimitExceededError(
                                    f"Maximum call depth of {self._max_call_depth} exceeded"
                                )
                            self._depth = depth
                            try:
                                arity = entry.arity
                                if arity >= 0 and len(eval_args) != arity:
                                    eval_args = eval_args[:arity]
                                try:
                                    result = entry.fn(*eval_args)
                                except JsonFnError:
                                    raise
                                except Exception as e:
                                    raise EvaluationError(
                                        f"Error calling external function {head}: {e}"
                                    ) from e
                                self._account_for_result(result)
                                return result
                            finally:
                                self._depth = depth - 1
                        # Fall through to the general dispatch for builtins
                        # and JSON-body functions (depth tracking + ctx setup
                        # is non-trivial enough to keep in one place).
                        eval_args = [self._evaluate(a, get_var) for a in fn_arr[1:]]
                        return self.call(head, eval_args, parent_get_var=get_var)
                    # Computed callee (e.g. `[{"$var":"f"}, ...]`).
                    fn_decl = self._evaluate(head, get_var)
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
                if not isinstance(fn_arr, (str, dict)):
                    raise EvaluationError(_expr_error(expr, "Unrecognized expression type."))
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(expr, "Function references cannot have other properties.")
                    )
                ref = self._evaluate(fn_arr, get_var)
                if not _is_fn_declaration(ref):
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            f"Evaluated function references must be strings or "
                            f"function bodies. Got {_type_label(ref)}.",
                        )
                    )
                return ref

            if "$var" in expr:
                var_path = expr["$var"]
                if var_path.__class__ is not str:
                    raise EvaluationError(
                        _expr_error(expr, "Variable references must have a string $var property.")
                    )
                if "$get" in expr:
                    if _expr_key_count(expr) > 2:
                        raise EvaluationError(
                            _expr_error(
                                expr, "$var/$get property access cannot have other properties."
                            )
                        )
                    return self._evaluate_property_access(expr, get_var)
                if _expr_key_count(expr) > 1:
                    raise EvaluationError(
                        _expr_error(expr, "Variable references cannot have other properties.")
                    )
                if get_var is None:
                    raise EvaluationError(_expr_error(expr, "getVar is not defined."))
                # Inlined _resolve_var fast path: skip parse_path for plain names.
                if "." not in var_path and "[" not in var_path:
                    value = get_var(var_path)
                    if value is _MISSING:
                        raise EvaluationError(_expr_error(expr, f"Variable {var_path} not found."))
                    return value
                return self._resolve_var(var_path, get_var, expr)

            if "$return" in expr:
                if "$fn" in expr:
                    raise EvaluationError(
                        _expr_error(expr, "Function bodies cannot have other keyword properties.")
                    )
                if "$params" in expr:
                    params = expr["$params"]
                    if not isinstance(params, list) or not all(isinstance(p, str) for p in params):
                        raise EvaluationError(
                            _expr_error(expr, "$params must be an array of strings.")
                        )
                    for p in params:
                        name = p[3:] if p.startswith("...") else p
                        _validate_param_name(name)
                if get_var is None:
                    return expr
                return self._replace_vars(expr, get_var)

            if "$cond" in expr:
                if _expr_key_count(expr) > (2 if "$else" in expr else 1):
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "$cond expressions can only have $cond and optional $else properties.",
                        )
                    )
                pairs = expr["$cond"]
                if not isinstance(pairs, list):
                    raise EvaluationError(
                        _expr_error(expr, "$cond must be an array of [condition, result] pairs.")
                    )
                for pair in pairs:
                    if not isinstance(pair, list) or len(pair) != 2:
                        raise EvaluationError(
                            _expr_error(
                                expr, "Each $cond branch must be a [condition, result] pair."
                            )
                        )
                for pair in pairs:
                    if _truthy(self._evaluate(pair[0], get_var)):
                        return self._evaluate(pair[1], get_var)
                if "$else" in expr:
                    return self._evaluate(expr["$else"], get_var)
                raise EvaluationError(
                    _expr_error(
                        expr,
                        "No $cond branch matched (add $else or a [true, ...] catch-all).",
                    )
                )

            if "$match" in expr or "$cases" in expr:
                has_match = "$match" in expr
                has_cases = "$cases" in expr
                has_else = "$else" in expr
                if not (has_match and has_cases and has_else):
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "$match expressions must have $match, $cases, and $else properties.",
                        )
                    )
                if _expr_key_count(expr) > 3:
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "$match expressions can only have $match, $cases, and $else properties.",
                        )
                    )
                pairs = expr["$cases"]
                if not isinstance(pairs, list):
                    raise EvaluationError(
                        _expr_error(expr, "$cases must be an array of [value, result] pairs.")
                    )
                for pair in pairs:
                    if not isinstance(pair, list) or len(pair) != 2:
                        raise EvaluationError(
                            _expr_error(expr, "Each $match case must be a [value, result] pair.")
                        )
                matched_value = self._evaluate(expr["$match"], get_var)
                _assert_match_scalar(matched_value, expr)
                for pair in pairs:
                    candidate = self._evaluate(pair[0], get_var)
                    _assert_match_scalar(candidate, expr)
                    if _strict_equal(candidate, matched_value):
                        return self._evaluate(pair[1], get_var)
                return self._evaluate(expr["$else"], get_var)

            if "$if" in expr:
                if "$then" not in expr or "$else" not in expr:
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "Conditional expressions must have all three properties: "
                            "$if, $then, $else.",
                        )
                    )
                if _expr_key_count(expr) > 3:
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "Conditional expressions cannot have more than three properties.",
                        )
                    )
                cond = self._evaluate(expr["$if"], get_var)
                branch = expr["$then"] if _truthy(cond) else expr["$else"]
                return self._evaluate(branch, get_var)

            if "$and" in expr:
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(expr, "$and expressions cannot have other properties.")
                    )
                items = expr["$and"]
                if not isinstance(items, list):
                    raise EvaluationError(
                        _expr_error(expr, "$and must be an array of expressions.")
                    )
                result: JsonValue = True
                for sub in items:
                    result = self._evaluate(sub, get_var)
                    if not _truthy(result):
                        return result
                return result

            if "$or" in expr:
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(expr, "$or expressions cannot have other properties.")
                    )
                items = expr["$or"]
                if not isinstance(items, list):
                    raise EvaluationError(_expr_error(expr, "$or must be an array of expressions."))
                result_or: JsonValue = False
                for sub in items:
                    result_or = self._evaluate(sub, get_var)
                    if _truthy(result_or):
                        return result_or
                return result_or

            comparison_operator = _get_comparison_operator(expr)
            if comparison_operator is not None:
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(
                            expr, f"{comparison_operator} expressions cannot have other properties."
                        )
                    )
                operands = expr[comparison_operator]
                if not isinstance(operands, list) or len(operands) != 2:
                    raise EvaluationError(
                        _expr_error(
                            expr, f"{comparison_operator} must be an array of two expressions."
                        )
                    )
                return self._evaluate_comparison(comparison_operator, operands, get_var)

            if "$not" in expr:
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(expr, "$not expressions cannot have other properties.")
                    )
                return not _truthy(self._evaluate(expr["$not"], get_var))

            if "$raw" in expr:
                if _expr_key_count(expr) != 1:
                    raise EvaluationError(
                        _expr_error(expr, "$raw expressions cannot have other properties.")
                    )
                return expr["$raw"]

            if "$get" in expr or "$from" in expr:
                if "$get" not in expr or "$from" not in expr:
                    raise EvaluationError(
                        _expr_error(
                            expr, "Property access expressions must have both $get and $from."
                        )
                    )
                if _expr_key_count(expr) > 2:
                    raise EvaluationError(
                        _expr_error(
                            expr,
                            "Property access expressions cannot have more than two properties.",
                        )
                    )
                return self._evaluate_property_access(expr, get_var)

            # Plain object literal — recursively evaluate values. A
            # string-valued ``$comment`` key is stripped from the output.
            if _has_string_comment(expr):
                return {k: self._evaluate(v, get_var) for k, v in expr.items() if k != "$comment"}
            return {k: self._evaluate(v, get_var) for k, v in expr.items()}

        if t is list:
            return [self._evaluate(item, get_var) for item in expr]

        # Primitives (str, int, float, bool, None) evaluate to themselves.
        # We accept anything else as well; _classify would have raised, but in
        # practice values reaching _evaluate from JSON are always JSON-shaped.
        return expr

    def _evaluate_comparison(
        self,
        operator: str,
        operands: list[Any],
        get_var: Any,
    ) -> bool:
        left = self._evaluate(operands[0], get_var)
        right = self._evaluate(operands[1], get_var)

        if operator == "$eq":
            return _strict_equal(left, right)
        if operator == "$neq":
            return not _strict_equal(left, right)
        if operator == "$lt":
            return left < right  # type: ignore[operator]
        if operator == "$lte":
            return left <= right  # type: ignore[operator]
        if operator == "$gt":
            return left > right  # type: ignore[operator]
        if operator == "$gte":
            return left >= right  # type: ignore[operator]
        raise AssertionError(f"unknown comparison operator: {operator}")

    def _resolve_var(
        self,
        var_path: str,
        get_var: Any,
        expression: Any,
    ) -> JsonValue:
        # Fast path: plain variable name (no path syntax). Avoids the cost of
        # the cached parse_path call entirely.
        if "." not in var_path and "[" not in var_path:
            value = get_var(var_path)
            if value is _MISSING:
                raise EvaluationError(_expr_error(expression, f"Variable {var_path} not found."))
            return value
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
            local_names: set[str] = {
                k
                for k, v in expression.items()
                if k not in ("$return", "$params") and not (k == "$comment" and v.__class__ is str)
            }
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


def _has_string_comment(obj: dict[str, Any]) -> bool:
    """Return True if ``obj`` contains a ``$comment`` key with a string value.

    Such comments are noise: they don't count toward expression-key validation
    and are stripped from plain-object output.
    """
    v = obj.get("$comment")
    return v is not None and v.__class__ is str


def _expr_key_count(obj: dict[str, Any]) -> int:
    """Number of keys for expression-shape validation. A ``$comment`` key with
    a string value does not count.
    """
    n = len(obj)
    if _has_string_comment(obj):
        n -= 1
    return n


def _truthy(v: Any) -> bool:
    """json-fn truthiness: only ``None``, ``False``, ``0``, ``0.0``, and
    ``""`` are falsy. Empty list/dict are TRUTHY (unlike Python's natural
    semantics) — matches JavaScript-style truthiness used by the spec.
    """
    if v is None or v is False:
        return False
    t = type(v)
    if t is bool:
        return v  # only True remains
    if t is int or t is float:
        return v != 0
    if t is str:
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


def _get_comparison_operator(obj: dict[str, Any]) -> str | None:
    for key in obj:
        if key in _COMPARISON_OPERATORS:
            return key
    return None


def _strict_equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        return isinstance(b, (int, float)) and not isinstance(b, bool) and a == b
    if isinstance(a, str):
        return isinstance(b, str) and a == b
    return False


def _is_match_scalar(value: Any) -> bool:
    return value is None or isinstance(value, bool | int | float | str)


def _assert_match_scalar(value: Any, expr: Any) -> None:
    if not _is_match_scalar(value):
        raise EvaluationError(
            _expr_error(expr, "$match values must be null, boolean, number, or string.")
        )


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
    n = _expr_key_count(obj)

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

    if "$cond" in obj:
        if n > (2 if "$else" in obj else 1):
            raise EvaluationError(
                _expr_error(
                    obj, "$cond expressions can only have $cond and optional $else properties."
                )
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

    has_match = "$match" in obj
    has_cases = "$cases" in obj
    has_match_else = "$else" in obj
    if has_match or has_cases:
        if not (has_match and has_cases and has_match_else):
            raise EvaluationError(
                _expr_error(
                    obj, "$match expressions must have $match, $cases, and $else properties."
                )
            )
        if n > 3:
            raise EvaluationError(
                _expr_error(
                    obj, "$match expressions can only have $match, $cases, and $else properties."
                )
            )
        pairs = obj["$cases"]
        if not isinstance(pairs, list):
            raise EvaluationError(
                _expr_error(obj, "$cases must be an array of [value, result] pairs.")
            )
        for pair in pairs:
            if not isinstance(pair, list) or len(pair) != 2:
                raise EvaluationError(
                    _expr_error(obj, "Each $match case must be a [value, result] pair.")
                )
        return ExpressionType.MATCH

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

    comparison_operator = _get_comparison_operator(obj)
    if comparison_operator is not None:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, f"{comparison_operator} expressions cannot have other properties.")
            )
        operands = obj[comparison_operator]
        if not isinstance(operands, list) or len(operands) != 2:
            raise EvaluationError(
                _expr_error(obj, f"{comparison_operator} must be an array of two expressions.")
            )
        return ExpressionType.COMPARISON

    if "$not" in obj:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "$not expressions cannot have other properties.")
            )
        return ExpressionType.NOT

    if "$raw" in obj:
        if n > 1:
            raise EvaluationError(
                _expr_error(obj, "$raw expressions cannot have other properties.")
            )
        return ExpressionType.RAW

    return ExpressionType.OBJECT
