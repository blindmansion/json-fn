# Execution limits

json-fn defines portable limits for call depth, deterministic fuel, and
produced value size, plus a fixed structural-depth limit. Cancellation,
wall-clock timeout, and total allocation are host-local safety controls.

## Budget scope

One evaluation invocation uses one shared budget. Nested function calls,
higher-order callbacks, and task continuations consume the same fuel and call
depth. A durable suspension ends the invocation; recovery or delivery starts a
new invocation with fresh configured limits.

An omitted `maxFuel` or `maxValueSize` is unlimited. The default call-depth
limit is unspecified; portable deployments set `maxCallDepth` explicitly.

## Measures

A **top-level length** is an array's item count, a string's Unicode
code-point count, or an object's property count. String sizes are measured in
code points throughout the cost model and the limits below. No charge or
limit in this document measures nested structure recursively.

## Fuel

Fuel is a semantic work measure for termination and replay determinism, never
a resource meter. Billing and performance are host territory, like wall-clock
time and cancellation, and fuel and real cost are allowed to diverge.

Fuel is defined by a **static cost function** over the canonical program
combined with a closed vocabulary of **dynamic semantic events**. Consumed
fuel is the sum of the static constants of every region entered plus the
dynamic event charges.

### Static regions

Ingestion of a canonical program computes, by a deterministic normative rule,
one non-negative integer constant for each **straight-line region**: a maximal
program segment containing no function invocation, no branch point, no
parameter-default boundary, and no builtin call. The rule is defined over
post-normalization
canonical JSON, so `parse(print(node))` stability guarantees identical
constants from shorthand or canonical ingestion.

A region's constant counts its nodes: each expression node counts 1, and
static data — including `$raw` payloads — counts one per value node, with
object keys adding nothing. Preserved `$comment` fields in `$raw` data count
as value nodes; stripped literal comments do not. Statically sized
construction charges through its containing region's constant; there is no
separate materialization charge for data whose size is fixed by the program
text. The closure capture record is the named conformance vector for this
rule: its entry set is a static function of the program text, each entry
counts in the region containing the function literal, and closure creation
fires no event.

Bindings are not boundaries. Since `$let` and module bindings evaluate
strictly, a `$let` whose bindings and `$in` contain no invocation, branch
point, parameter-default boundary, or builtin call folds entirely into its
containing region. The only lazy construct in the language is the parameter
default (`$default` on positional and `$fields` slots), and it is the only
boundary evaluation strategy could otherwise leak through.

The static function produces constants, never functions of inputs. A program's
own control flow supplies input-dependence at runtime: a loop charges its
per-iteration constant once per iteration because each iteration enters the
region again.

### Events

Execution charges fuel only at these events:

- **invocation** — entering a function invocation charges 1 and enters the
  callee's entry region;
- **arm selection** — resolving a `$cond`, `$match`, or `$if` branch,
  dispatching a `handle` clause, continuing into a further `$and` or `$or`
  operand, or taking a `$get` `$else` arm on a miss enters the selected arm's
  entry region;
- **default force** — evaluating an omitted parameter's or field's `$default`
  expression when its binding is first read enters the default expression's
  entry region;
- **builtin call** — charges the builtin's metering declaration from the
  signature registry: a base constant plus the top-level lengths of its
  size-metered arguments;
- **value production** — each array or string produced by a builtin or host
  function charges its top-level length;
- **re-entry** — entering a value whose construction was already charged — a
  hydrated continuation or other function value arriving as input and
  applied, or a memoization cache hit — charges 1 for the value itself; its
  descendants were charged when the value was produced, possibly in an
  earlier invocation.

Returning from an invocation or a builtin call enters the continuation
region. The program's entry region is charged when evaluation begins.

Constructed values charge at their creation event: statically sized
construction through the containing region's constant, dynamically sized
products at the value-production event.

Builtin metering declarations are deliberately coarse: top-level lengths
only, floors rather than measurements. Callback costs are not part of a
builtin's declaration; callback invocations charge their own invocation,
region, and builtin events.

### Floors

These floors are axioms, so `maxFuel` remains a hard termination and
allocation bound:

- every invocation event charges at least 1;
- every builtin-call event charges at least 1 plus at-least-proportional
  charges for its size-metered inputs;
- every produced value charges at least its top-level length.

### Determinism

Every event is determined by value semantics: which function was invoked,
which branch was taken, which builtin ran on which sizes. Fuel is additive
over the event multiset and aggregation is order-independent, so the trace —
and therefore fuel — is a pure function of the program, its inputs, and
recorded effect results, on every conforming implementation. Parser metadata,
caching, serialization, and ingestion route do not change it. Bindings are
strict, so no event depends on demand; the one lazy construct, the parameter
default, keeps the property because whether and when a default is first read
is itself determined by values.

Evaluation strategy is outside the observable surface. Memoization,
speculative or parallel evaluation, and
compilation are legal; an implementation's only obligation is the trace. A
cache keyed on callee identity and arguments may replace a transitively pure
computation; the hit charges the recorded consumed fuel of the original
computation plus one re-entry charge.

### Versioning

The complete cost law — the region rule, the event vocabulary, the registry
metering declarations, and the floors — carries a single **cost-model
version**, currently 1. The event vocabulary is closed per version and
extended only by versioned addition. A new event kind attaches only to a new
node kind, so an existing program's cost is invariant under vocabulary
extension. Which node kinds carry each event — the attachment lists above —
is likewise fixed per version, not extended independently. Events are defined
as canonically encodable data.

### Exhaustion

The budget is checked at event points, not per node. Evaluation fails at the
first event whose charge exceeds the remaining budget; work beyond the
failing event is bounded by the containing region's static constant. The
exhaustion event and the consumed-fuel total are deterministic.

Usage reporting may expose consumed fuel without imposing a finite limit and
does not otherwise change evaluation.

## Produced value size

`maxValueSize` bounds the top-level length of each array or string produced
by a builtin or host function.

The limit applies to each produced value independently. It is not a recursive
byte-size limit for an object graph. Size-growing operations may reject a
result before allocating it.

## Total allocation

Fuel bounds work, not retention: a program holding many values in live scope
has resident memory bounded by neither `maxFuel` nor the per-value
`maxValueSize`. Hosts bound total allocation with a host-level budget
alongside the portable limits. Like cancellation and timeout, the
total-allocation bound is a host-local control and is outside portable
evaluation semantics.

## Call depth

`maxCallDepth` bounds nested json-fn function invocations. It does not count
expression nesting.

## Host-local interruption

Cancellation and wall-clock timeout checks occur at event boundaries. A
native higher-order operation remains interruptible when it calls guest
callbacks. A callback-free native operation is not interrupted midway.

Cancellation and timeout are non-deterministic host controls and are outside
portable evaluation semantics.

## Structural depth

Structural depth is a fixed language constant. It is not configurable.

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

Structural-depth failures are deterministic limit failures. Acceptance at
each boundary and the exact first failure beyond it are part of conformance.
