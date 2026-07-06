# Host Integration

This document covers the host-facing controls a program embedder configures when
evaluating json-fn: the resource-limit knobs and the cooperative
cancellation / wall-clock timeout mechanisms.

These are distinct from the language's own semantics. For what the *language*
guarantees (including the always-on circular-dependency check and the
deterministic, spec-tested fuel / value-size behavior), see
[`docs/language.md`](./language.md). For the normative cost model — exactly what
each node and builtin charges — see [`docs/execution-limits.md`](./execution-limits.md).

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
