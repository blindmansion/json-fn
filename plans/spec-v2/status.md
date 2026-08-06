# Spec v2 status: what remains to be decided

Status: **living document**, 2026-08-06. Everything not yet decided, grouped
by what it blocks. The settled sequence is in [`plan.md`](plan.md); rationale
for the settled items is in [`review.md`](review.md).

## Decisions blocking plan stages

None open. The three Stage 1 decisions were resolved 2026-08-06 and are
stated in the Stage 1 spec text:

- **D1 — string length unit: resolved, Unicode code points.** Stated once in
  the measures section of `spec-v2/docs/runtime/execution-limits.md`;
  consistent with `maxValueSize` and string indexing. The Unicode metering
  work in `plans/runtime-representation-gaps.md` must hold this unit.
- **D2 — materialization event encoding: resolved, fold static
  materializations into region constants.** Data literals and `$raw`
  payloads count in the containing region's static constant; the
  value-production event covers only dynamically sized builtin/host
  products. The capture record (Stage 2) remains the named conformance
  vector for the materialization rule.
- **D3 — the evaluation-nesting limit: resolved, dropped.** Its counting
  rule was defined in terms of per-node charging, which the event-trace
  model deletes; `maxCallDepth` plus the fixed structural depth of 512
  remain.

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
  blocker dissolved with Stage 1 (2026-08-06).
- **Checker-conformance regeneration for spec-v2.** The canonical `spec/`
  migration in `plans/checker-conformance-migration.md` is complete.
  Regenerate an equivalent `spec-v2/cases/check/` corpus after Stage 3, or
  price that regeneration into the coordinated break.

## Bookkeeping and cross-plan updates

- Done (2026-08-06): [`do-target.md`](do-target.md) updated after Stage 1 —
  its follow-up B blocker list and fuel invariants now reflect the
  event-trace model, with the "portable fuel must not leak chunk thresholds
  or cache warmth" blocker recorded as dissolved.
- Add the dependency note to
  `plans/content-addressing/lazy-refs-and-cas-runtime.md`: partial hydration
  composes with capture records (one lazy ref per record entry), which is
  why the closure format (Stage 2) lands before any follow-up B work.
- When durable tasks decomposes into proposals, check each new canonical
  shape against the Stage 4 posture: additive node kinds and tagged value
  encodings under an engine version bump, never redefinitions of existing
  shapes.
