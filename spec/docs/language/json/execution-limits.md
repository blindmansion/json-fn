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

Evaluating a `$let` consumes the ordinary one unit of expression fuel, as does
each binding expression when it is first forced. Entering a `$let` does not
invoke a function, consume function-invocation fuel, or increase call depth.
Calling a function-valued binding later has the ordinary function-call costs.

## Resource limits

Evaluation may set these limits:

- `maxFuel` bounds deterministic metered work.
- `maxValueSize` bounds each array or string produced by a builtin or host
  function.
- `maxCallDepth` bounds nested function calls.

Omitted fuel and value-size limits are unlimited. The default call-depth limit
is unspecified, so portable deployments set it explicitly.

Two fixed limits always apply:

- JSON structural depth is at most 512.
- Combined expression and invocation nesting during evaluation is at most
  4,096.

Cancellation and wall-clock timeouts are non-deterministic host controls, not
portable evaluation semantics. Deployment limits are declared in a
[deployment profile](../../deployment/deployment-profile.md).
