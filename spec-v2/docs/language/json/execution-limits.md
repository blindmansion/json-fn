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

Boolean-condition validation is likewise not an event. The check that an
evaluated condition or operand is a boolean
([boolean positions](expressions.md#boolean-positions)) is a constant-time
kind check like `$get`'s key-validity check — straight-line work folded into
the branch node's existing count in its region's static constant, not the
`$as` validator's schema walk. The arm-selection events attached to
`$cond`/`$match`/`$if` arms, further `$and`/`$or` operands, `$get` `$else`
arms, and `handle` clauses are unchanged: a program whose conditions and
operands are booleans consumes identical fuel with and without the
validation.

Closure creation follows the same pattern: it is not an event. The
[capture record](closures.md) is statically sized construction — its entry
set is a static function of the program text — so each record entry counts
one node in the region containing the function-literal node. Captured values
are shared, not copied; each was already charged where it was produced.
Open-body entries are static program text whose nodes charge as every
function body's do. A closure created inside a loop charges its record entries
once per iteration, because each iteration re-enters the region. Applying a
function value has the ordinary invocation costs; applying a **hydrated**
function value — one arriving as input, such as a resumed continuation —
charges re-entry (1), its record's cost having been paid at the original
creation. Fuel does not cross suspensions.

## Typing is free

Inline type annotations — `$type` on parameter descriptors and `$returns` on
function bodies — contribute **zero** to region constants: like object keys,
and unlike data literals, they are static syntax that never produces a value.
Typing a function cannot change its fuel; one program, annotated and bare,
consumes identical fuel. The `$type` of a
[`$as` expression](expressions.md#checked-type-ascription--as-type) is
different: a declared runtime position whose validation cost is unchanged and
out of scope here.

The lowered projections of an
[object-pattern parameter](functions.md#object-pattern-parameters) charge as
what they are: `$let` and `$get` nodes in their region's static constant. An
optional or defaulted field is a branch point whose `$else` arm is its own
region, entered by an arm-selection event on a genuine miss — the
property-access rule above, verbatim. The default-force event attaches only
to the positional `$default`, the language's one lazy construct; a supplied
or absent pattern field never fires it.

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
