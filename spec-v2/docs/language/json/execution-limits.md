# Execution limits

The complete cost model and boundary rules are defined in
[Runtime execution limits](../../runtime/execution-limits.md).

## Circular variable dependencies

`$let` and module bindings evaluate eagerly in
[dependency order](expressions.md#dependency-order). If unevaluated bindings
remain and none has all of its dependencies evaluated, the bindings form a
cycle and evaluation fails. Direct self-reference
(`{ "$let": { "x": { "$var": "x" } }, "$in": { "$var": "x" } }`) is the
one-binding case of the same rule.

The error names the cycle through the earliest stalled binding in source
order, with the path in reference order:

```
Circular variable dependency detected: a -> b -> a
```

Cycle detection is always active and is not configurable.

A `$let` is an expression scope, not a function call. Entering one is not an
invocation event and does not increase call depth; the `$let` itself counts in
its containing region's static constant. `$let` is not a region boundary:
binding expressions and `$in` belong to the containing region unless an
invocation, branch, or builtin call inside them starts a new one. Calling a
function-valued binding later has the ordinary invocation costs.

Property access follows the same pattern. A bare `$get` is ordinary
straight-line work: it counts in its containing region's static constant and
fires no event. A `$get` with an `$else` arm is a branch point: the target and
key evaluate in the containing region, and the `$else` arm is its own region,
entered by an arm-selection event on a genuine miss. A hit fires no event and
stays in the containing region. Because a multi-segment path is nested
`$get`s — one node per segment — each segment counts as a node in its region's
static constant.

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
