# Spec v2 status: what remains to be decided

Status: **living document**, 2026-08-06. Everything not yet decided, grouped
by what it blocks. The settled sequence is in [`plan.md`](plan.md); rationale
for the settled items is in [`review.md`](review.md).

## Decisions blocking plan stages

- **D1 — string length unit** (blocks Stage 1's size table). Code points vs
  UTF-16 code units as the unit for string sizes in the builtin cost table.
  Interacts with the open Unicode metering work in
  `plans/runtime-representation-gaps.md`; whichever is chosen must be stated
  in the same stage as the cost law or string-builtin fuel diverges across
  implementations.
- **D2 — materialization event encoding** (Stage 1). The rule is settled
  (constructed values charge at their creation event); still open is whether
  those charges appear in the trace as a distinct event kind or fold into
  the containing region's static constant. Decide with the capture record as
  the named vector.
- **D3 — the evaluation-nesting limit** (Stage 1/2 boundary). Whether the
  4,096 nesting limit survives under strict bindings and event-granularity
  checks, or collapses into `maxCallDepth` plus structural depth.

## Design work not yet proposal-ready

- **Pattern matching** ([`pattern-matching.md`](pattern-matching.md)).
  Canonical node shapes unfinished. Open inside it: arm-selection/dispatch
  events (one story shared with `handle` clauses and, later, `select` arms);
  absence patterns coherent with strict reads; whether a full pattern
  language subsumes `$match`.
- **Durable tasks** ([`durable-tasks-design.md`](durable-tasks-design.md)).
  Still a design exploration; needs decomposition into proposals along its
  own candidate seams (taxonomy → temporal values → guards → combinators →
  config → surface → checkpoints → durable trace). Named open tensions:
  - guard host-snapshot vocabulary (`now` clearly; how much more);
  - `with`-config attachment site — effect call site vs task value, and
    precedence if both;
  - trace retention/compaction vs the replay-basis and audit roles;
  - cross-invocation fuel budgets folding across cost-model versions
    (incomparable units when a workflow's life spans a version bump);
  - speculative preview's accounting posture (host-side, presumably charges
    no guest budget — needs a sentence when preview is specified).
- **Effect taxonomy + contract knob declarations.** Consumed by nearly all of
  durable tasks; lands as one versioned contract revision when the durable
  tasks proposals firm up. Bounds model (contract declares knobs and bounds,
  authors configure within them) is directionally settled; the schema is not.
- **Testing framework** ([`testing-framework.md`](testing-framework.md)).
  Proposal is drafted and additive; its own open questions: effectful
  subjects and contract linkage in test bodies; `prop` parameter generality
  beyond a single integer seed; failure-payload truncation rule;
  `assertHash` in the first cut or deferred; test names in standard error
  rendering; unused/test-only binding policy.
- **Shorthand, pending items**
  ([`shorthand-redesign.md`](shorthand-redesign.md)): pipe printback policy
  (normalize away vs render deep chains as pipelines); `&` durability
  semantics at suspension boundaries (by-name `$fn` vs captured closure);
  stdlib argument-order audit for pipeline ergonomics; `$imports` canonical
  form and hash-pinning location.
- **Proposal 6, signature-shape axis.** Whether the
  `required`/`optional`/`rest` signature shape ever changes; gated on a
  deliberate contract-format revision, not on any plan stage.

## Host and deployment questions (no spec-v2 language footprint)

- **celld/DO profile** ([`do-target.md`](do-target.md)) open questions:
  workflow-per-cell as the only supported mapping; pinned-world retention
  policy for resume-under-pinned-world; where the deployment identity hash
  lives in the deploy artifact; two-tier store promotion criteria; whether
  the measurement gate gets a hard suspension-latency budget.
- **CAS measurement gate re-baselining.** Re-run after Stage 2 lands, since
  capture removes substitution duplication; the codec must be justified by
  per-step duplication alone, measured with the ack-latency and
  hibernation-footprint instrumentation from `do-target.md` §2.
- **Follow-up B blockers** (`plans/content-addressing/lazy-refs-and-cas-runtime.md`):
  unforgeable ref representation, `ValueHash`-only equality evidence,
  `maxValueSize` boundary audit, transitive purity for memoization,
  builtin/validator forcing-depth audit. All unchanged; the fuel-leak
  blocker dissolves under Stage 1 (see bookkeeping below).
- **Checker-conformance migration**
  (`plans/checker-conformance-migration.md`): run after Stage 3, or priced
  with suite regeneration as part of it.

## Bookkeeping and cross-plan updates

- Update [`do-target.md`](do-target.md) after Stage 1: its follow-up B
  blocker list and fuel invariants were written against the pre-event-trace
  model; the "portable fuel must not leak chunk thresholds or cache warmth"
  blocker is dissolved by the adopted cost definition.
- Add the dependency note to
  `plans/content-addressing/lazy-refs-and-cas-runtime.md`: partial hydration
  composes with capture records (one lazy ref per record entry), which is
  why the closure format (Stage 2) lands before any follow-up B work.
- When durable tasks decomposes into proposals, check each new canonical
  shape against the Stage 4 posture: additive node kinds and tagged value
  encodings under an engine version bump, never redefinitions of existing
  shapes.
