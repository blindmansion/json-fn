# Execution limits

json-fn defines portable limits for call depth, deterministic fuel, produced
value size, structural depth, and evaluation nesting. Cancellation and
wall-clock timeout are host-local safety controls.

## Budget scope

One evaluation invocation uses one shared budget. Nested function calls,
higher-order callbacks, and task continuations consume the same fuel and call
depth. A durable suspension ends the invocation; recovery or delivery starts a
new invocation with fresh configured limits.

An omitted `maxFuel` or `maxValueSize` is unlimited. The default call-depth
limit is unspecified; portable deployments set `maxCallDepth` explicitly.

## Fuel

Fuel is deterministic and additive:

- evaluating an expression node costs 1;
- entering a function invocation costs 1;
- a native builtin charges for input-sized work that does not evaluate
  json-fn expressions;
- each array or string returned by a builtin or host function costs its
  top-level length;
- callback invocations accrue their normal invocation, expression, and builtin
  costs.

Fuel is a virtual cost determined only by the program, its inputs, and recorded
effect results. Parser metadata, caching, serialization, and ingestion route do
not change it.

The expression-node rule has these consequences:

- `$raw` charges one unit for each value node in its payload; object keys do
  not add a charge. The payload remains data and is never evaluated as syntax.
  Fuel follows the value produced, so preserved `$comment` fields count in
  `$raw` data and stripped literal comments do not.
- Re-entering an existing runtime value costs 1 for the value itself. Its
  descendants were charged when the value was produced.
- A cached constant program subtree charges the same complete node count as an
  uncached evaluation.

Native work that requires explicit metering includes numeric aggregation,
collection traversal, structural equality and membership, object construction,
string scanning, sorting comparisons, and regex input.

Evaluation fails as soon as consumed fuel exceeds `maxFuel`. Usage reporting
may expose consumed fuel without imposing a finite limit and does not otherwise
change evaluation.

## Produced value size

`maxValueSize` bounds:

- the top-level item count of each array produced by a builtin or host
  function;
- the Unicode code-point count of each string produced by a builtin or host
  function.

The limit applies to each produced value independently. It is not a recursive
byte-size limit for an object graph. Size-growing operations may reject a
result before allocating it.

## Call depth

`maxCallDepth` bounds nested json-fn function invocations. It does not count
expression nesting.

## Host-local interruption

Cancellation and wall-clock timeout checks occur at expression and invocation
boundaries. A native higher-order operation remains interruptible when it calls
guest callbacks. A callback-free native operation is not interrupted midway.

Cancellation and timeout are non-deterministic host controls and are outside
portable evaluation semantics.

## Fixed structural limits

Two limits are fixed language constants. They are not configurable.

### Structural depth

Every accepted or produced JSON tree has a maximum structural depth of 512.
Scalars have depth 0. An array or object has:

```text
1 + maximum child depth
```

Exceeding the limit fails with:

```text
Maximum structural depth of 512 exceeded
```

The same counting rule applies at:

- ingestion of shorthand, canonical JSON, programs, arguments, schemas,
  contracts, profiles, builtin tables, tasks, and workflow records;
- host boundaries in either direction, including results, clones, and closure
  captures;
- printing and task or workflow-record serialization.

Grouping parentheses count toward source-level shorthand nesting. Boundary
validation occurs before processing begins, so rejected input consumes no
fuel.

### Evaluation nesting

Combined nested expression evaluations and function invocations are limited to
4,096. This dynamic limit accounts for expression depth accumulated across
open call frames.

Exceeding the limit fails with:

```text
Maximum evaluation nesting of 4096 exceeded
```

The counter increments where expression and invocation fuel is charged. Fuel
is charged first, so fuel exhaustion wins when both limits fail at the same
node.

Evaluation nesting differs from `maxCallDepth`: it includes expression nesting
as well as function calls. Sequential callbacks that return before the next
callback starts do not accumulate against it.

Structural-depth and evaluation-nesting failures are deterministic limit
failures. Acceptance at each boundary and the exact first failure beyond it are
part of conformance.
