# Spec v2 update plan

Status: **adopted sequence**, 2026-08-06. The concrete, ordered updates to the
spec-v2 draft (the `spec-v2/` tree at the repo root). This document contains
only settled work. Everything still open lives in
[`status.md`](status.md); decision rationale lives in
[`review.md`](review.md) and the individual plans.

Working posture:

- The spec is the artifact under iteration. Implementations are ephemeral and
  trail it; rewrites (including in other languages) are expected and cheap.
- `spec-v2/cases/` is regenerated as a **product** of each stage, never
  treated as a constraint on it.
- Each stage is written in the vocabulary the previous stage establishes.
  Items within a stage land together.

---

## Stage 1 — cost model

The event-trace model per
[`event-trace-cost-model.md`](event-trace-cost-model.md), adopted as resolved
in [`review.md`](review.md) §3. Rewrites
`spec-v2/docs/language/json/execution-limits.md` and
`spec-v2/docs/runtime/execution-limits.md`; touches the builtin size table.

1. Cost is defined as a static function over straight-line regions of the
   canonical program plus a vocabulary of dynamic semantic events. Evaluation
   strategy (memoization, speculative or parallel forcing, compilation) exits
   the observable surface; an implementation's only obligation is the trace.
2. The event vocabulary is **closed per version and extended only by
   versioned addition**. New event kinds attach only to new node kinds, so an
   existing program's cost is invariant under vocabulary extension. Events
   are defined as canonically encodable data.
3. The builtin size table is deliberately coarse: top-level lengths only,
   floors not measurements. The normative framing sentence lands with it:
   **fuel is a semantic work measure for termination and replay determinism,
   never a resource meter**; billing and performance are host territory.
4. One general materialization rule: constructed values charge at their
   creation event. The closure capture record (Stage 2) is a named
   conformance vector for this rule.
5. The total-allocation addendum (Proposal 8) is adopted into the limits
   documents: fuel bounds work, not retention; `maxValueSize` is per-value;
   the host-level total-allocation bound is documented alongside them.
6. String sizes in the table are specified in a single pinned unit (unit
   choice is decision **D1** in [`status.md`](status.md)).

## Stage 2 — strict bindings and closures

The semantics rewrite. Rewrites `expressions.md`, `functions.md`, and
`closures.md` under `spec-v2/docs/language/json/`; the printer, normalizer,
and `spec-v2/docs/runtime/hashing.md` rules land in the same change.

1. **`$let` becomes strict and dependency-ordered** (Change 4's variant):
   bindings evaluate eagerly in dependency order, cycles are errors, the lazy
   forcing machinery and unforced-error-suppression semantics are deleted.
   Lazy parameter defaults remain as the one documented exception.
   Proposal 3 is recorded as resolved in this form.
2. **Parameter richness** (Proposal 6, in-scope portion): `$fields`
   destructuring patterns collapse into desugaring. The defaults axis is
   dropped — defaults stay lazy and primitive. The signature shape
   (`required`/`optional`/`rest`) is untouched.
3. **Closures move from substitution to capture** (Proposal 1, with the
   record-on-value encoding): escaping bodies are never rewritten; evaluated
   free-variable values attach as a capture record on the function value, a
   sibling of `$params`/`$return`. Capture is one mechanism generalized to
   values, escape is idempotent, name collisions are impossible by
   construction, and inertness survives serialization by position. The
   capture record's cost charges at the closure-creation event (Stage 1,
   item 4); re-entry charges 1. The record prints as the local-binding form
   for audit reading. Normalizer and printer rules plus hash vectors for the
   record shape land in this same stage.
4. **Strict reads**: [`strict-reads.md`](strict-reads.md) is absorbed,
   including the `$get` redesign and the absent-vs-null resolution
   (Proposal 10).

## Stage 3 — kernel cleanup

Small, definite deletions against the Stage 2 language.

1. **Remove `$if`**; one-arm `$cond` is the survivor. `$match` stays
   canonical.
2. **Record Proposal 5 as won't-do**: `$and`/`$or` stay.
3. **Run the Proposal 7 name-resolution audit** against the final resolution
   order (which retains a capture lookup tier), deleting asymmetric normative
   text where found.
4. Regenerate the affected `spec-v2/cases/` suites (as with every stage).

## Stage 4 — identity and record plumbing

Small normative additions that keep future work additive. Touches
`spec-v2/docs/runtime/hashing.md`, `spec-v2/docs/runtime/durable-host.md`,
and the deployment documents.

1. Deployment identity includes the **engine/stdlib semantic version** and
   the **cost-model version** as identity components.
2. Explicit version fields on: the environment contract format, the persisted
   continuation/workflow record, and the event vocabulary.
3. The **value-universe statement**: values are JSON, permanently. Richer
   types arrive as canonical tagged encodings plus checker-level refinements,
   never as new runtime value kinds.
4. The suspension record's pending-delivery slot is a **list** (of one,
   today), and effectId dedup rules are stated per delivery, not per
   suspension.
5. **Resume-time charging**: applying a resumed continuation charges re-entry
   only — the capture record's materialization cost was paid in the original
   invocation and fuel does not cross suspensions. One normative sentence in
   the durable-host document plus a cost vector.
6. The **envelope rule** is normative: status scans, revision checks,
   identity checks, and scheduling read inline envelope metadata only;
   nothing on those paths may hydrate a payload.

## Stage 5 — shorthand redesign (resolved items)

The nine resolved items from [`shorthand-redesign.md`](shorthand-redesign.md),
rewriting `spec-v2/docs/language/shorthand/`:

1. `let { … } in expr` replaces `where`; colon bindings, canonical
   `$let`/`$in` order.
2. K&R formatting: brace-form bodies hug `=>`, closers at column 0, long
   signatures wrap in the param list.
3. Function declaration sugar: `name(params) -> Type => body`; colon form
   valid input, sugar canonical.
4. `type Name: T`; `=` accepted as input, prints back as `:`.
5. Type-name casing is a lint-level convention only.
6. Imports are contract-injected namespaces with dot access; no guest import
   statement.
7. Exports via `pub` prefix per declaration.
8. Pipe `|>`: insert-last, left-associative, between `||` and `checked as`,
   bare-name RHS, no placeholder, lowers to nested calls; leading-pipe
   multiline via the shared peek-ahead rule.
9. `&` demoted: bare names idiomatic and canonical; `&` only under shadowing.

The pending shorthand items are excluded (see [`status.md`](status.md)).

---

## Deliberately not in this plan

Later, additive work that consumes Stages 1–4 but does not gate them:

- Everything in [`durable-tasks-design.md`](durable-tasks-design.md) —
  arrives as additive node kinds, versioned contract revisions, and host
  behavior.
- Pattern matching ([`pattern-matching.md`](pattern-matching.md)) — lands
  when its canonical shapes are design-ready.
- The testing framework ([`testing-framework.md`](testing-framework.md)) —
  additive by construction (`$tests` is excluded from module identity); can
  land any time after Stage 1.
- Effect taxonomy and contract knob declarations — one future versioned
  contract revision.
- Content-addressing follow-ups and the celld/DO profile
  ([`do-target.md`](do-target.md)) — host layer; their spec-v2 footprint is
  exactly Stage 4.
