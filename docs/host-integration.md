# Host Integration

This document covers the host-facing controls a program embedder configures when
evaluating json-fn: the resource-limit knobs and the cooperative
cancellation / wall-clock timeout mechanisms.

These are distinct from the language's own semantics. For what the *language*
guarantees (including the always-on circular-dependency check and the
deterministic, spec-tested fuel / value-size behavior), see
[`docs/language.md`](./language.md). For the normative cost model — exactly what
each node and builtin charges — see [`docs/execution-limits.md`](./execution-limits.md).

## Running a program

A json-fn program is an **object mapping names to expressions** (constants and
function literals). The host runs it by treating that object as the outermost
lexical scope and invoking a named entry point within it. This is the
`callProgram`-style contract, taking:

- **program** — the module object (parsed json-fn JSON);
- **entry** — the name of a top-level function to invoke;
- **args** — the arguments passed to that entry function;
- **base registry** — the stdlib + native builtins, which become the module's
  **parent frame** (per the boundary rule in
  [`docs/language.md`](./language.md#module-scope));
- **limits** — the optional resource-limit knobs described below.

Within the run, top-level constants and functions are visible via `$var` and
`$fn` throughout the module (see [Module Scope](./language.md#module-scope)).

```ts
import { callProgram, createStdlib } from "json-fn";

const result = callProgram(module, "handleCommand", [state, argv], createStdlib());
```

The entry must be a function **defined by the module itself**: `callProgram`
fails fast (rather than falling back to stdlib or to an uncaptured value) if the
name is absent from the module, names a non-function constant, or merely
collides with a stdlib function.

Notes for hosts:

- **Referenced globals evaluate once per run**, on every code path (including
  impure ones that call `log`), because every module function is captured up
  front. Dead globals — those no captured function mentions — never evaluate.
- **Long-lived hosts should build the module scope once and reuse it** rather
  than calling `callProgram` per request, since the capture pass walks the whole
  module on each call. Reuse the captured function table (immutable); do **not**
  reuse per-run state that tracks fuel/depth.

The per-function `callFunction` API remains available for hosts that only need
to invoke a single function against a registry.

## Configuring limits

Limits are optional and supplied by the host at evaluation time; how they are
passed is host-defined (an options object in TypeScript, an `ExecutionLimits`
value in Go / Python / Rust, and so on). When a limit is unset:

- `maxCallDepth` falls back to an implementation-defined default.
- `maxFuel` and `maxValueSize` are unbounded.

### Maximum call depth

`maxCallDepth` bounds recursion depth (direct or mutual). Exceeding it errors:

```
Maximum call depth of 10 exceeded
```

Recursion that stays within the configured depth runs normally. This primarily
guards against host stack overflow.

### Maximum fuel

`maxFuel` bounds the total work a program may perform, catching expensive
computations that are not necessarily deep (e.g. large `map` / `reduce` /
`range` workloads). Fuel is charged at every metered chokepoint — once per AST
node visited, once per function invocation (so higher-order callbacks and
pure-builtin calls all cost fuel), and proportionally to the input/output size
of size-sensitive builtins (`range`, `concat`, `map`, `sort`, string and regex
ops, …). Exceeding the budget errors:

```
Maximum fuel limit of 50 exceeded
```

### Maximum value size

`maxValueSize` bounds the length of any array or string a program produces,
independent of fuel. This stops allocation bombs (e.g. `range(1e9)` or repeated
`concat`) that a CPU budget alone cannot. Exceeding it errors:

```
Maximum value size of 1000 exceeded
```

## Cancellation and timeout

A host may also cancel a run cooperatively and set a wall-clock backstop. Both
are checked at every node and every function invocation (so even a native
higher-order loop over a pure builtin can be interrupted), and neither charges
fuel.

- **Cancellation** aborts with `Execution aborted`. It is wired to each
  language's idiomatic mechanism.
- **Timeout** aborts with `Execution timed out` once the deadline passes.

| Implementation | Cancellation mechanism | Timeout option |
| --- | --- | --- |
| TypeScript | `AbortSignal` | `timeoutMs` |
| Go | `context.Context` | deadline-carrying `context.Context` |
| Python | `threading.Event` | `timeout_ms` |
| Rust | `Arc<AtomicBool>` | `timeout` (`Duration`) |

Unlike fuel and value-size limits, the wall-clock deadline is inherently
non-deterministic, so it is a host-only safety net and is **not** part of the
conformance spec.
