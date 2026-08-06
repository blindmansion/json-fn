# Execution limits

The complete cost model and boundary rules are defined in
[Runtime execution limits](../../runtime/execution-limits.md).

## Circular variable dependencies

Lazy `$let` and module bindings are resolved on demand. If resolving a binding
requires resolving itself, either directly
(`{ "$let": { "x": { "$var": "x" } }, "$in": { "$var": "x" } }`) or through a
cycle such as `a → b → a`, evaluation fails. The error identifies the first
cycle reached:

```
Circular variable dependency detected: a -> b -> a
```

The error reports the first cycle reached, even if that cycle does not begin
with the first binding resolved. Cycle detection is always active and is not
configurable.

A `$let` is an expression scope, not a function call. Entering one is not an
invocation event and does not increase call depth; the `$let` itself counts in
its containing region's static constant. Each binding expression is its own
region, entered by the binding-force event when the binding is first demanded.
Calling a function-valued binding later has the ordinary invocation costs.

## Resource limits

Evaluation may set these limits:

- `maxFuel` bounds deterministic metered work. Fuel bounds work, not
  retention.
- `maxValueSize` bounds the top-level length of each array or string produced
  by a builtin or host function. It is a per-value bound; hosts bound total
  allocation with a host-level budget alongside it.
- `maxCallDepth` bounds nested function calls.

Omitted fuel and value-size limits are unlimited. The default call-depth limit
is unspecified, so portable deployments set it explicitly.

One fixed limit always applies: JSON structural depth is at most 512.

Cancellation, wall-clock timeouts, and the total-allocation bound are
non-deterministic host controls, not portable evaluation semantics. Deployment
limits are declared in a
[deployment profile](../../deployment/deployment-profile.md).
