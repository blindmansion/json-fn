# Execution Limits

## Circular Variable Dependencies

Lazy `$let` and module bindings form dependency graphs resolved on demand. If
resolving a binding requires resolving itself—directly
(`{ "$let": { "x": { "$var": "x" } }, "$in": { "$var": "x" } }`) or through a
cycle (`a → b → a`)—evaluation errors instead of looping. The cycle is
reported in the message, e.g.:

```
Circular variable dependency detected: a -> b -> a
```

This detection is part of the language: it is always on, needs no configuration, and is enforced by every implementation. It reports the first cycle reached, even when the cycle does not start at the first variable.

Evaluating a `$let` consumes the ordinary one unit of expression fuel, as does
each binding expression when it is first forced. Entering a `$let` does not
invoke a function, consume function-invocation fuel, or increase call depth.
Calling a function-valued binding later has the ordinary function-call costs.

## Host-configured resource limits

Beyond the always-on circular check, hosts may cap the resources a program
consumes. Fuel accounting is deterministic and specified for conformance;
produced-value size has a portable definition. When explicitly configured:

- **Fuel** (`maxFuel`) bounds total metered work; exceeding it errors with `Maximum fuel limit of N exceeded`.
- **Value size** (`maxValueSize`) bounds the length of any array or string a program produces; exceeding it errors with `Maximum value size of N exceeded`.

A third cap, **call depth** (`maxCallDepth`), guards recursion against host stack overflow and uses an implementation-defined default when unset. Hosts may additionally cancel a run cooperatively or impose a wall-clock timeout; those are host-only safety nets and, being non-deterministic, are **not** part of the conformance spec.

Two further limits are fixed language constants rather than host
configuration: every JSON tree is bounded by a **structural depth** of 512
nested container levels (erroring with `Maximum structural depth of 512
exceeded` at every parsing, checking, evaluation, printing, validation, and
hydration boundary), and combined expression-plus-invocation nesting during
evaluation is bounded at 4,096 (erroring with `Maximum evaluation nesting of
4096 exceeded`). See
[Execution limits § Fixed structural limits](../../runtime/execution-limits.md#fixed-structural-limits).

Portable deployment limits are supplied through a
[deployment profile](../../deployment/deployment-profile.md); host entry and runtime-adapter boundaries
are described by the [environment contract](../../deployment/environment-contract.md), with
persistent behavior in [Durable task hosting](../../runtime/durable-host.md). For
the normative cost model, see [Execution limits](../../runtime/execution-limits.md). The
TypeScript CLI's `eval` command accepts `--max-call-depth`, `--max-fuel`, and
`--max-value-size` to set these limits for an individual run.

