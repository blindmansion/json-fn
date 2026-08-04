# Execution limits

json-fn hosts can bound evaluation with call depth, deterministic fuel, and
produced-value size limits. Hosts may also provide cancellation and a wall-clock
timeout as non-deterministic safety backstops. The language additionally fixes
two non-configurable structural limits (section 4) so that deeply nested data
fails deterministically on every host.

## 1. Shared budget

One evaluation uses one shared limit state. Nested function calls, callbacks
invoked by higher-order builtins, and task continuations all consume the same
fuel budget and call-depth allowance. Suspending and resuming a task does not
reset that state.

An omitted fuel or value-size limit is unlimited. Call depth has an
implementation-defined default when the host does not provide one.

## 2. Fuel model

Fuel is deterministic and additive:

- evaluating an expression node costs 1;
- entering a function invocation costs 1;
- native builtins charge for input-sized work that does not re-enter the
  interpreter;
- every array or string returned by a host function or builtin costs its
  top-level length; and
- callback invocations accrue their ordinary call, expression, and builtin
  costs separately.

Fuel is a **stable virtual cost**: a pure function of the program, its inputs,
and recorded effect results, independent of parser metadata, caches,
serialization, and ingestion route. Quotation, runtime values, and caches
refine the expression-node rule without breaking that property:

- a `$raw` boundary charges the complete static-literal cost of its payload —
  one unit per produced value node (object keys are not separately charged) —
  which is exactly what evaluating the equivalent plain constant literal
  charges. The payload is never interpreted as syntax, and the runtime may
  charge from cached cost metadata instead of walking it. Where quotation and
  literal syntax produce different values (literal `$comment` entries, which
  literals strip and `$raw` preserves), each form charges the node count of
  the value it actually produces;
- re-entering an already-produced runtime value costs 1 for the value itself,
  with no descendant charges — it was accounted for at its original
  boundary; and
- a discovered or preseeded constant program subtree skips repeated
  interpreter work but charges the same complete node count as its first
  evaluation. Losing that metadata (for example through JSON serialization)
  changes host preparation work only — never fuel, results, or errors.

Examples of explicitly metered native work include traversing numeric
aggregates, collection higher-order functions, structural equality and
membership, object construction, string scans, sorting comparisons, and regex
input.

Evaluation fails as soon as accumulated fuel exceeds `maxFuel`.

## 3. Other limits

### 3.1 Produced value size

`maxValueSize` bounds the top-level item count of each array and the Unicode
code-point count of each string produced by a host function or builtin.
Size-growing builtins may check the bound before allocation, and all builtin
return values pass through the shared result accounting chokepoint.

The limit is per produced value, not a recursive byte-size total for an entire
object graph.

### 3.2 Call depth

`maxCallDepth` bounds nested json-fn function invocations. Exceeding it fails
evaluation. The default is host-implementation-specific; supply an explicit
value when identical host behavior matters.

### 3.3 Usage reporting

Hosts may request the consumed fuel count even when they do not impose a finite
fuel limit. Usage reporting does not otherwise change evaluation behavior.

### 3.4 Cancellation and timeout

Cancellation and wall-clock timeout checks run at expression and invocation
chokepoints. Native higher-order loops remain interruptible when they invoke
their callbacks; a single callback-free native operation is not interrupted
mid-call. These checks are host safety mechanisms, not deterministic language
semantics, and are therefore outside conformance expectations.

## 4. Fixed structural limits

Implementations traverse JSON trees recursively (parsing, checking,
evaluating, printing, validating, hydrating). Without a portable bound, the
depth at which a traversal fails would depend on the host's stack size. Two
fixed language constants make those failures deterministic. Neither is
host-configurable, and both fire consistently before any host stack is at
risk.

### 4.1 Structural depth

Every JSON tree an implementation accepts or produces is limited to a
**structural depth of 512**. Depth counts nested container levels along the
deepest path: scalars have depth 0, and an array or object has depth
`1 + max(depth of children)`. Exceeding the limit fails with:

```
Maximum structural depth of 512 exceeded
```

One counting rule is shared by every traversal, so an artifact cannot pass one
phase and fail a later one on depth alone. The limit is enforced:

- at ingestion boundaries — shorthand parsing (source-level nesting,
  including grouping parentheses, counts against the same limit), canonical
  JSON inputs, program bodies and arguments, schema fragments and definition
  tables, environment contracts, effect manifests, deployment profiles,
  builtin tables, and task/workflow-record hydration;
- during evaluation — values crossing the host boundary in either direction,
  including results (guest programs can build values level by level, so
  over-deep runtime-built values are caught when they cross back out), cloned
  values, and closure capture (embedding a captured value that pushes the
  closure past the limit fails the same way); and
- at output boundaries — printing and task/workflow-record serialization.

Boundary checks run before the phase begins, so a rejected input is never
partially processed and no fuel is charged for it.

### 4.2 Evaluation nesting

The structural limit bounds each individual tree, but evaluation nesting
compounds across guest call frames: every call site buried under nested
containers adds its expression depth to the frames already open. A separate
dynamic counter caps combined nested expression evaluations and function
invocations at **4,096**. Exceeding it fails with:

```
Maximum evaluation nesting of 4096 exceeded
```

The counter increments at the same chokepoints that charge fuel; the node's
fuel is charged first, so when the fuel budget and the nesting cap are
exhausted at the same node, the fuel error is reported. Unlike `maxCallDepth`
(which counts only function invocations), evaluation nesting also counts
expression nesting, so deep recursion whose call sites are buried under deep
literals exhausts it sooner than plain recursion. Recursion that is
sequential rather than nested — for example a fold whose callback returns
before the next one starts — does not accumulate against the cap.

Both errors are deterministic limit failures: the durable host classifies
them alongside fuel, call-depth, and value-size exhaustion, and conformance
suites pin acceptance at the limits and the exact errors just past them
(`spec/cases/structural-depth.json`, `spec/parse-cases/structural-depth.json`).

Raising either constant — or removing the structural limit by making every
traversal iterative — is a backwards-compatible change; no accepted program
ever breaks when the bound moves up.
