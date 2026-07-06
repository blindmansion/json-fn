# json-fn (Python)

A tree-walking interpreter for [json-fn](https://github.com/nickconfer/json-fn) — a pure-JSON expression language. Programs are plain JSON values; the interpreter walks them and produces another JSON value.

This package implements the same language as the Go reference and passes the shared conformance suite under [`spec/cases/`](../spec/cases/).

## Install

```bash
pip install json-fn
# or, with uv
uv add json-fn
```

The distribution name is `json-fn`; the import name is `jsonfn`.

## Usage

```python
from jsonfn import call_function, create_stdlib

stdlib = create_stdlib()
program = {
    "$params": ["a", "b"],
    "$return": {"$fn": ["add", {"$var": "a"}, {"$var": "b"}]},
}

assert call_function(program, [2, 3], stdlib) == 5
```

See [`docs/language.md`](../docs/language.md) for the full language reference.

## Public API

- `call_function(fn, args, registry, limits=None)` — main entry point.
- `create_stdlib()` — builds a `FunctionRegistry` containing the ~60 built-in functions (arithmetic, comparison, logic, arrays, strings, objects, higher-order, regex).
- `ExecutionLimits(max_call_depth, max_fuel, max_value_size, cancel, timeout_ms, usage)` — optional limits. `max_fuel` bounds total metered work (per node, per call, and proportional to size-sensitive builtins); `max_value_size` caps produced array/string length; `cancel` is a `threading.Event` that, when set, aborts evaluation; `timeout_ms` is a host-only wall-clock backstop (aborts with "Execution timed out" once the deadline passes; non-deterministic, so it is not part of the conformance spec); `usage` is an optional `ExecutionUsage` that receives the consumed fuel once evaluation finishes.
- `Interpreter(registry, limits)` — re-usable interpreter object if you want to invoke `call()` multiple times against a shared scope (single-threaded use only).
- `strip_jsonc(src)` — convert `.jsonc` source (line comments + trailing commas) to strict JSON.
- `JsonFnError` — base exception. Subclasses: `EvaluationError`, `CycleError`, `PathError`, `LimitExceededError`.

### Registering custom Python functions

Use the same decorator helper that the stdlib uses:

```python
from jsonfn import BuiltinContext, call_function, create_stdlib
from jsonfn.stdlib import _Registry

r = _Registry()

@r.pure("greet", arity=1)
def _(name: str) -> str:
    return f"hello, {name}!"

@r.builtin("twice", arity=2)
def _(callback, value, *, ctx: BuiltinContext):
    once = ctx.call(callback, [value])
    return ctx.call(callback, [once])

registry = {**create_stdlib(), **r.build()}
```

Pure functions receive their arguments unpacked. Builtins additionally take `ctx: BuiltinContext`, whose `ctx.call(callback, [...])` invokes a json-fn callback in the current scope.

## Tests & benchmarks

```bash
uv run pytest                       # spec conformance + smoke + chess
uv run pytest benches/ \
    --benchmark-enable --benchmark-only   # micro-benchmarks
```

The benchmarks mirror `go/benchmark_test.go` so cross-implementation comparisons are apples-to-apples. Deep-arithmetic benchmarks bump `sys.setrecursionlimit` to accommodate Python's small default; this does not relax the interpreter's own `max_call_depth` safety limit.

## Implementation notes

- **Value type** — native Python (`None | bool | int | float | str | list | dict`). Numbers preserve Python's `int`/`float` distinction; the spec runner treats them as interchangeable when comparing expected vs. actual values.
- **Scope chain** — per-frame closure (`get_var`) with lazy local-variable evaluation and cycle detection. Function-body locals are scanned and added to a per-frame registry overlay so they can be called by name (and recursively) from within `$return`.
- **Function registry** — plain `dict[str, _PureEntry | _BuiltinEntry | dict]`. Frames that introduce local function declarations build a copy-on-write overlay; the overlay is restored via `try`/`finally` when the frame returns.
- **Errors** — `JsonFnError` hierarchy. Error message strings match the Go reference so the spec's substring assertions pass unchanged.
- **Path parsing** — `functools.lru_cache(maxsize=1024)` for `parse_path`, matching Go.
- **Match-based dispatch** — the evaluator uses `match` over a small `ExpressionType` enum produced by an explicit classifier (`_classify`) that validates structural invariants up front.
- **Truthiness** — only `None`, `False`, `0`, and `""` are falsy. Empty list/dict are truthy (matching the spec, not Python's natural `bool()` semantics).
