# Plan: the event-trace cost model

Status: **proposed.** Redefines the cost model in
`docs/runtime/execution-limits.md`, resolves
[`later/simplification-proposals.md`](later/simplification-proposals.md)
Proposal 8 by redefinition rather than by choosing between its two options,
and supersedes the companion metering-profiles proposal
([`metering-profiles.md`](metering-profiles.md)), which is retained as the
documented fallback. There is no backwards-compatibility constraint; this
lands as one breaking change to fuel semantics, coordinated with
[`strict-reads.md`](strict-reads.md) and the laziness decision from
Proposal 3 in a single release.

Keep fuel deterministic across implementations, but change what fuel _is_:
from a per-node account of the act of tree-walking to a **static cost
function over the canonical program** combined with a **closed vocabulary of
dynamic semantic events**. Static analysis at ingestion assigns one constant
to each straight-line region; execution charges those constants at event
points — invocation, branch-arm selection, builtin calls with size-metered
inputs, value production. Fuel is the sum of coefficients over the event
trace. Because the event trace is fully determined by value semantics, any
implementation that computes the right values charges the right fuel by
construction, regardless of evaluation strategy.

## Motivation

### What fuel is for

Against the actual threat and execution model, fuel has four jobs:

1. **A hard DoS bound** on agent-written code within one invocation. This
   needs determinism, monotone accrual, and completeness floors — never
   per-node exactness.
2. **Replay stability.** Recompute-from-basis requires that a recomputing
   invocation exhaust at the same point as the original. Per
   `docs/runtime/execution-limits.md`, a suspension ends the invocation and
   recovery starts a new one with fresh configured limits, so this is a
   _within-deployment_ property; remaining budget never crosses a
   suspension.
3. **Audit-time cost visibility** for the operator reviewing a program
   before embedding it.
4. **Billing and quotas** — host territory, like wall-clock and
   cancellation, and out of scope for portable semantics.

None of the four requires two engines to agree on the price of a `sort`.
The remaining reason to want cross-implementation exactness is ecosystem
coherence — one cost law, the way there is one canonical encoding — and
that is worth keeping **if it is cheap**. Under per-node accounting it is
not cheap: Proposal 8 priced it as "effectively the entire evaluator
becomes conformance-testable cost model," and that price falls on the
optimizing compiler (only faithful-cost compilation is legal), on
memoization and parallel forcing (value-invisible but fuel-visible, hence
forbidden), on the lazy-refs plan (its hardest blocker is specifying
virtual charges for hydration and cache warmth), and on kernel size (cost
rules must be replicated in every evaluator — the drift-and-freeze dynamic
the simplification review warns about).

### Why redefinition beats weakening

The metering-profiles fallback keeps the current definition and weakens the
guarantee to per-profile scope. That works, but it spends ecosystem
coherence to buy implementation freedom. This plan observes that the
definition, not the guarantee, is the expensive part: once cost is defined
over the program and the semantic trace instead of over the evaluator's
steps, the strong guarantee becomes nearly free, and the profile ecosystem
— with its fragmentation risk — is unnecessary. The codebase is already
part-way there: Phase 2 landed static-literal `$raw` fuel and
`expression-metadata.ts` (`rememberStaticCost`/`getStaticCost`) as an
optimization. This plan promotes that optimization into the definition and
makes the observable semantics the thing the optimization was
approximating.

## Design

### Change 1: the canonical static cost function

Ingestion of a canonical program computes, by a normative and deterministic
rule, one non-negative integer cost for each **straight-line region**: a
maximal program segment containing no invocation, no branch point, no lazy
boundary, and no builtin call. The rule is defined over canonical JSON
(post-normalization, so `parse(print(node))` stability guarantees identical
costs from shorthand or canonical ingestion) and is closed under the same
discipline as canonical hashing: every implementation derives identical
constants from identical programs.

The static function performs no symbolic reasoning. It never produces a
cost _function of inputs_; it produces constants. The program's own control
flow supplies the input-dependence at runtime: a loop charges its
per-iteration constant once per iteration because each iteration emits the
events, not because analysis derived `n·c`. This keeps the static phase
total, exact, and trivially decidable — cheap enough to be law.

### Change 2: the dynamic event vocabulary

Execution charges fuel only at these events:

- **invocation** — entering a function invocation charges the invocation
  constant plus the callee's entry-region constant;
- **arm selection** — resolving a `$cond`/`$match`/`$if` branch charges the
  selected arm's region constant;
- **binding force** — forcing a lazy binding charges its region constant
  (see Change 4 for whether this event survives);
- **builtin call** — charges the builtin's table entry: a base constant
  plus declared size functions over its inputs, measured on top-level
  lengths only;
- **value production** — each array or string produced by a builtin or host
  function charges its top-level length;
- **`$raw` / re-entry** — static data charges its value-node count at its
  containing region's charge point; re-entering an existing runtime value
  charges 1.

The vocabulary is closed. Fuel is additive over the event multiset, and
aggregation is order-independent: two executions producing the same event
multiset consume identical fuel. Every event listed above is determined by
value semantics (which branch was taken, which builtin ran on which sizes),
so the trace — and therefore fuel — is a pure function of the program, its
inputs, and recorded effect results, on **every** conforming
implementation. Strong cross-implementation determinism is retained, and
evaluation strategy exits the observable surface.

Completeness floors are kept as axioms so `maxFuel` remains a hard
termination and allocation bound: every invocation event charges at least
1, every builtin event at least 1 plus at-least-proportional size charges,
every produced value at least its top-level length.

### Change 3: exhaustion at event granularity

The budget is checked at event points, not per node. Evaluation fails at
the first **event** whose charge exceeds the remaining budget; overshoot
within a region is bounded by that region's static constant. This is a
deliberate coarsening of the observable exhaustion point, spent to buy:
charge batching, trivial compiled instrumentation (constants injected at
basic-block boundaries, the Wasm/EVM pattern, at single-digit-percent
overhead), and freedom from mid-region bookkeeping. The exhaustion event
and consumed-fuel total remain deterministic. Host-local cancellation and
timeout checks move to event boundaries as well, which subsumes the current
expression/invocation-boundary rule.

### Change 4: decide laziness first; this plan leans strict

Demand is the last channel through which evaluation strategy leaks into
the trace: with lazy `$let`, _which_ binding-force events occur depends on
demand order, so speculative or parallel forcing of not-yet-demanded
bindings remains illegal even under this model. Proposal 3's post-review
note observes the pre-consumer decision window "is being spent"; this plan
is the forcing function to spend it deliberately, and takes the position
that `$let` and module bindings become **strict** (evaluated when bound,
still order-independent by dependency, cycles still errors), while lazy
parameter defaults are retained (they are already the documented
exception). Consequences: the binding-force event is deleted; the trace is
fully determined by values alone; speculative and parallel evaluation
become unconditionally legal; the unforced-binding error-suppression rule
and its conformance cases are deleted with it.

If review keeps laziness instead, the plan still stands: the binding-force
event stays, demand order remains part of the trace, and speculation is
forbidden — coherent, with smaller wins. The choice must be explicit in the
same release either way, because the event vocabulary is normative.

### Change 5: one versioned cost law, no profile namespace

The builtin cost table is folded into the **signature registry**
(`spec/builtins/builtins.json`): each builtin's entry gains a metering
declaration — base constant and size functions over declared parameters —
validated by the registry schema. The registry is already the shared,
versioned, cross-implementation artifact; cost rides the vehicle that
exists.

The complete cost law — static-function rule, event vocabulary, registry
metering, floors — carries a single **cost-model version**. The deployment
identity hash from
[`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md)
includes it (subsumed by the engine/stdlib semantic version component it
already hashes). Evolution is by version bump, detected and policy-gated by
the pinning driver exactly like any other world change. The open profile
namespace from the fallback proposal is rejected: it solved version skew,
which pinning already solves, at the price of ecosystem fragmentation.

### Change 6: cache laws

Because consumed fuel is now a pure function of a computation's inputs, two
rules are written into the spec rather than left as blockers:

- **Memoization.** A cache keyed on `(callee identity, args)` may replace a
  transitively pure computation. A hit charges the _recorded_ consumed fuel
  of the original computation plus one re-entry charge. Semantically exact;
  no virtual-cost schedule required.
- **Deferred hydration.** Blob metadata in the content-addressed store
  records the value's top-level sizes and value-node count. Charges that
  depend on those measures (value production, `$raw`-style data charges,
  re-entry) are computable from metadata without hydration, so a lazy-ref
  runtime charges inline-equivalent fuel by reading headers, not values.

These two sentences discharge the two hardest cost blockers in
[`content-addressing/lazy-refs-and-cas-runtime.md`](content-addressing/lazy-refs-and-cas-runtime.md).

### Change 7: symbolic bounds are tooling, not semantics

An optional analysis (`check --cost`) may derive symbolic bounds over input
sizes for audit-time admission control and budget sizing. Bounds are
RAML-style over-approximations, may fail on data-dependent recursion, and
never replace the exact meter: charging a bound would move the exhaustion
event. The analysis consumes the same registry metering declarations, so it
stays consistent with the law by construction.

## What this supersedes

- **Proposal 8** — resolved: determinism stays strong across
  implementations, but over a definition whose conformance surface is a
  static function plus a closed event vocabulary, vector-testable like
  hashing, rather than the whole evaluator.
- **[`metering-profiles.md`](metering-profiles.md)** — superseded; retained
  as the fallback if the static cost function proves harder to canonicalize
  than expected, and its Tier-1 axioms (determinism, additivity, floors,
  deterministic exhaustion, reporting) are absorbed here unchanged.
- The faithful-cost constraint on compiling implementations — an optimizer
  may fold, inline, and eliminate freely; its obligation is the event trace
  and injected constants, both preserved by any value-correct compilation.
- The lazy-refs plan's virtual-charge and cache-warmth blockers (Change 6)
  and its fuel-portability blocker generally.

## Coordination

One breaking release, while there are zero external consumers, containing:

1. this cost redefinition;
2. the [`strict-reads.md`](strict-reads.md) node redesign (already forces
   fuel-case churn; its coordination note shrinks to "regenerate cost
   vectors");
3. the Proposal 3 laziness decision (Change 4).

All three touch the trace; landing them together produces one semantic
break and one conformance-suite migration instead of three.

## Implementation steps

1. Specify the static cost function and event vocabulary in a rewritten
   `docs/runtime/execution-limits.md`; define the region rule over the
   post-normalization canonical form.
2. Extend `spec/builtins/builtins.schema.json` with metering declarations;
   populate the table with deliberately coarse size functions (top-level
   lengths only); regenerate the builtins doc.
3. Add `spec/cases/cost/`: program → static-constant vectors, and
   (program, inputs) → consumed-fuel vectors, in the style of the hash
   cases. Migrate or delete the fuel-observing eval cases.
4. Land the TypeScript changes: promote `expression-metadata.ts` static
   costs from optimization to definition (region segmentation at
   ingestion), move budget checks to event points, implement registry-table
   metering, and — per Change 4 — strict binding evaluation.
5. Fold the cost-model version into the identity-hash engine component;
   update AGENTS.md, the roadmap Phase 0 record, and Proposal 8's
   post-review note.

## Acceptance criteria

- Two implementations (or one implementation under two evaluation
  strategies, e.g. with and without memoization or constant folding)
  produce identical consumed-fuel totals and identical exhaustion events on
  every cost vector.
- A memoized re-execution of a pure call charges recorded fuel plus
  re-entry and is otherwise indistinguishable.
- No conformance case observes evaluation order except through values
  (post-Change-4) — demand-order-sensitive fuel cases are deleted or
  provably value-determined.
- The static cost of every example module is derivable by an independent
  reimplementation of the region rule from the spec text alone.
- Compiled-instrumentation prototype: a hand-compiled example (e.g. the
  thermostat `decide` function) with injected constants matches the
  interpreter's fuel on all vectors.

## Costs and risks

- **Exhaustion precision.** Overshoot within a region, bounded by its
  static constant. Irrelevant to the DoS bound; visible only to tests that
  asserted mid-region exhaustion.
- **Laziness** (under the strict lean): demand-driven authoring patterns
  and the unforced-error-suppression behavior are removed; `where` remains
  order-independent, which preserves the authoring ergonomics that
  mattered.
- **A new normative analysis.** The region rule joins hashing and
  normalization as spec-level canonical machinery every implementation must
  reproduce. Mitigated by its totality and by input→number vectors; this is
  the load-bearing bet, with metering-profiles as the fallback if it
  proves fragile.
- **Registry gravity.** Builtin metering in the signature registry means
  cost changes are registry versions — deliberate friction, same as
  signature changes.

## Open questions

- The exact region-boundary rule for nested data literals and `$raw`
  payloads: charge at the containing region's event or as a distinct
  value-materialization event.
- Whether `handle` clause dispatch is an arm-selection event (proposed:
  yes, symmetric with `$match`).
- Whether recorded-fuel memoization entries belong in the durable store's
  metadata (Unison-style) in v1 of the CAS work or only in the in-memory
  cache.
- Whether the evaluation-nesting limit of 4,096 survives at all under
  strict bindings and event-granularity checks, or collapses into
  `maxCallDepth` plus structural depth.
