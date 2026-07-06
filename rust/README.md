# jsonfn

A tree-walking interpreter for [json-fn](https://github.com/nickconfer/json-fn) — a pure-JSON expression language. Programs are plain JSON values; the interpreter walks them and produces another JSON value.

This crate is a 1:1 port of the Go reference implementation in [`go/`](../go/) and passes the shared conformance suite under [`spec/cases/`](../spec/cases/).

## Usage

```rust
use jsonfn::{call_function, create_stdlib};
use serde_json::json;

let stdlib = create_stdlib();
let program = json!({
    "$params": ["a", "b"],
    "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
});

let result = call_function(&program, &[json!(2), json!(3)], &stdlib, None).unwrap();
assert_eq!(result, json!(5));
```

See [`docs/language.md`](../docs/language.md) for the full language reference.

## Public API

- `call_function(fn, args, registry, limits)` — main entry point.
- `create_stdlib()` — builds a `FunctionRegistry` containing the ~60 built-in functions (arithmetic, comparison, logic, arrays, strings, objects, higher-order, regex).
- `ExecutionLimits { max_call_depth, max_fuel, max_value_size, cancel, timeout, usage }` — optional limits. `max_fuel` is the total work budget (charged per AST node, per function invocation, and proportionally to size-sensitive builtins); `max_value_size` bounds produced array/string lengths; `cancel` is an `Arc<AtomicBool>` that aborts evaluation once set; `timeout` is a host-only `Duration` wall-clock backstop (aborts with "Execution timed out" once elapsed; non-deterministic, so it is not part of the conformance spec); supply an `Arc<ExecutionUsage>` in `usage` to read back consumed fuel via `usage.fuel()`.
- `FnEntry::Pure { .. }` / `FnEntry::Builtin { .. }` / `FnEntry::Body(..)` — register your own functions.
- `strip_jsonc(&str)` — convert `.jsonc` source (line comments + trailing commas) to strict JSON.

Builtins receive `&mut EvalCtx` and can call back into the interpreter via `ctx.call(fn_decl, &args)`.

## Tests & benchmarks

```bash
cargo test                          # spec conformance + smoke + chess
cargo run --example chess --release # play Fool's Mate end-to-end
cargo bench                         # criterion benches mirroring go/benchmark_test.go
```

## Implementation notes

- **Value type** — `serde_json::Value`. Numbers produced by the interpreter use the integer representation when whole (matching Go's `encoding/json` for `float64`).
- **Scope chain** — singly-linked `Rc<Frame>` with per-frame `evaluated_vars` cache and lazy resolution; supports the same closure semantics as the Go and TypeScript implementations.
- **Function registry** — `Arc<HashMap<String, FnEntry>>`; cloned on demand per frame only when a frame introduces local function declarations.
- **Errors** — single `EvalError(String)` whose `Display` matches Go's error messages so the spec's substring assertions pass unchanged.
- **Path parsing** — a 1024-entry global cache (matches Go) for `parse_path`.
