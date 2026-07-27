# Execution limits

json-fn hosts can bound evaluation with call depth, deterministic fuel, and
produced-value size limits. Hosts may also provide cancellation and a wall-clock
timeout as non-deterministic safety backstops.

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

Raw and cached values refine the expression-node rule:

- a `$raw` wrapper costs 1, but its payload is not evaluated and its descendants
  are not charged;
- re-entering an explicitly raw or already-evaluated runtime value costs 1 for
  the value itself, with no descendant charges; and
- a cached constant program subtree skips repeated interpreter work but charges
  the same complete node count measured by its first evaluation. Reusing a
  program object therefore does not change its constant-subtree fuel cost.

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
