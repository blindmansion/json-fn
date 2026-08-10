# Spec v2 status: what remains to be decided

Status: **living document**, 2026-08-09. Everything not yet decided, grouped
by what it blocks. The settled sequence is in [`plan.md`](plan.md); rationale
for the settled items is in [`review.md`](review.md) and
[`type-eval-coherence.md`](type-eval-coherence.md).

## Decisions blocking plan stages

None open. The three Stage 1 decisions were resolved 2026-08-06 and are
stated in the Stage 1 spec text; D4 and D5 were resolved 2026-08-08 (with
[`type-eval-coherence.md`](type-eval-coherence.md)'s adoption) and will be
stated in the Stage 2 spec text and the pattern-matching spec respectively:

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
- **D4 — truthiness: resolved, boolean conditions required.** Truthiness is
  deleted rather than kept-and-named: conditions must be boolean
  (evaluator-enforced error otherwise), and `$and`/`$or`/`!` become
  boolean-only with short-circuiting preserved. Rationale: the falsy-`0`/`""`
  exactness loss in condition narrowing is permanent (no `not` in the schema
  dialect), agent authors fix loud checker errors well but generate silent
  truthiness bugs (`if retries` at zero), and a silently wrong branch is the
  worst failure mode for durable workflows. The null/false-only middle
  option was rejected for flipping `if count` silently instead of erroring.
  Lands as Stage 2 chunk 2e; condition narrowing becomes exact. Residue: the
  null-defaulting surface replacing `x || default` (tracked below).
- **D5 — pattern v1 fragment boundary: resolved, the proposal's fragment as
  written.** Exhaustiveness is exact on: finite enums and literal unions;
  discriminated unions of **closed** objects, discriminated by any
  literal-covered field, nested; tuple-length splits with rest; and
  `null | T` splits. Outside the fragment the checker requires a catch-all
  and reports why. Leaf rules: refinement/`format`/`$ref`-typed binders are
  allowed but contribute nothing to coverage (erase to `true` for
  exhaustiveness); the optional-field pattern form is in v1; the pure
  absence pattern, or-patterns, closed object patterns, and pattern-level
  defaults stay excluded (additive later). Open data at workflow ingress is
  correctly outside the fragment: validate at the contract boundary with
  `$as` into a closed declared type, dispatch exhaustively inside.
  Consumed by Stage 3's case regeneration and the post-Stage-5 dialect.

## Design work not yet proposal-ready

- **Pattern matching** ([`pattern-matching.md`](pattern-matching.md)).
  Scope has narrowed (2026-08-08): the fragment boundary is resolved (D5),
  the clock-sensitive pieces moved into plan Stages 2–3, the dialect
  subsumes `$match` (resolved — the post-Stage-5 unit generalizes it), and
  absence/optional-field rules are aligned with strict reads in the
  proposal. Still open inside the remaining post-Stage-5 units:
  arm-selection/dispatch events (one story shared with `handle` clauses
  and, later, `select` arms); the guard arm encoding
  (`[pattern, guard, result]` triple vs a keyed variant); the typed-binder
  shorthand token (`(name: Type)` vs `name is Type`); whether
  `$let`-position destructuring joins parameter unification in the same
  pass.
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
  semantics at suspension boundaries (by-name `$fn` vs captured closure —
  chunk 2c's capture record now gives the captured alternative a precise
  meaning: a record-carrying function value survives suspension without the
  target host resolving the name);
  stdlib argument-order audit for pipeline ergonomics; `$imports` canonical
  form and hash-pinning location.
- **Null-defaulting surface after D4: resolved for Stage 2, no dedicated
  form** (2026-08-08, with chunk 2b's spec text —
  [`strict-reads-2b.md`](strict-reads-2b.md) decision 2). Absence-defaulting
  is strict reads' `$get`/`$else`; null-defaulting is the explicit
  conditional, which exact `T | null` narrowing makes fully typed, and the
  main null producers have better fixes (lazy parameter defaults). A
  dedicated form is additive and can land later without a format break.
  Revisit criterion: if the 2g corpus migration or the next blind-authoring
  run shows pervasive `if isNull(…)` boilerplate around stdlib nullable
  returns (`head`, `last`, `find`), a dedicated form — spelled distinctly
  from `??` — is the follow-up. The interacting `??` spelling question is
  also settled there: `??` is kept, miss-only, access-only (its divergence
  from JS's null-coalescing prior is documented prominently in the guide,
  and the checker keeps the null residue visible in the type).
- **Field defaults after the `$fields` collapse: resolved for Stage 2,
  `= e` lowers to the projection's `$else` arm** (2026-08-09, with chunk 2d's
  spec text — [`param-surface-2d.md`](param-surface-2d.md) rule 2). The arm
  fires on absence only, so present-`null` suppression is preserved exactly.
  Two documented deltas: a field default evaluates at bind time on absence
  (body-top, dependency-ordered) rather than lazily on first read, and a
  positional default can no longer reference a destructured field. The
  positional `$default` is the language's one remaining lazy construct and
  the sole default-force attachment. Fallback criterion: if the 2g corpus
  audit or a blind-authoring run shows real use of positional defaults
  reading pattern fields, the lowering re-projects field references inside
  default expressions (deterministic and printable, since the reserved
  `__p<i>` name cannot be authored) — an additive lowering rule, no format
  break.
- **`allowUntypedFunctions`: removed from spec-v2** (2026-08-09, revising
  2d rule 5 as the spec text landed). The option was the v1 migration escape
  hatch — its only effect was downgrading the missing-annotation error to an
  information diagnostic. spec-v2 fixes one policy: a named function that is
  not fully annotated is an error. Partial annotations remain legal syntax
  and are used as declared (2d rule 5), and contextually typed bare lambdas
  are untouched, so the option no longer earned its conformance surface —
  the portable `options` object is now empty and its concept deletes from
  `conformance/checking.md`. The option's schema field and its check cases
  delete with 2g's case migration; `info` diagnostics remain the encoding
  for other coverage degradation. The v1 spec, cases, and implementation
  flag (`--allow-untyped-functions`) are untouched until spec-v2 lands in
  the implementation.
- **Proposal 6, signature-shape axis.** Whether the
  `required`/`optional`/`rest` signature shape ever changes; gated on a
  deliberate contract-format revision, not on any plan stage. Unaffected by
  Stage 2's body-side `$sig` removal: the callable shape survives as the
  interface description, with a normative derivation from the inline form.

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
- **Checker-conformance migration for spec-v2.** The v1 corpus has been copied
  into `spec-v2/cases/check/`. Migrate the affected suites as part of Stage 2,
  then apply the additional Stage 3 cleanup; the v1 corpus remains unchanged.

## Bookkeeping and cross-plan updates

- Done (2026-08-08): [`type-eval-coherence.md`](type-eval-coherence.md)
  adopted — its consolidated ordering folded into [`plan.md`](plan.md)
  (Stage 2 chunks 2d–2f, Stage 3 item 4, the revised pattern-matching
  posture), and its two flagged decisions resolved as D4/D5 above.
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
