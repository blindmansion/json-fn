# Spec v2 update plan

Status: **adopted sequence**, 2026-08-06; revised 2026-08-08 to fold in
[`type-eval-coherence.md`](type-eval-coherence.md) (adopted): `$sig` inlining,
boolean conditions (D4), the deliberate `$fields` lowering, and the coherence
framing section join Stage 2; the scalar `$match` corrections join Stage 3;
the pattern dialect proper stays post-Stage-5. The concrete, ordered updates
to the spec-v2 draft (the `spec-v2/` tree at the repo root); Stage 1 is
implemented there. This document contains
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

## Stage 2 — strict bindings, closures, and type/eval coherence

The semantics rewrite, and the **one versioned function-body format break**
(Proposal 9's logic: every body-format change after this one re-pins hash
vectors and cases for the same region twice). Rewrites `expressions.md`,
`functions.md`, `narrowing.md`, and `closures.md` under
`spec-v2/docs/language/json/` and the parameter/type sections of
`spec-v2/docs/language/shorthand/type-syntax-spec.md`; the printer,
normalizer, and `spec-v2/docs/runtime/hashing.md` rules land in the same
change.

The stage **lands as one break** but decomposes into ordered chunks for
writing and review. Each chunk is internally coherent spec text; later
chunks are written in the vocabulary of earlier ones. Dependency spine:
2a → 2c (capture stores eagerly evaluated binding values); 2a + 2b → 2d
(the `$fields` lowering targets eager `$let` and strict-read projections);
2e is independent of 2a–2d but must precede 2f; 2f consumes the text of
2b, 2d, and 2e; 2g is last and assembles the conformance surface for the
whole stage.

### 2a — strict `$let`

**`$let` becomes strict and dependency-ordered** (Change 4's variant):
bindings evaluate eagerly in dependency order, cycles are errors, the lazy
forcing machinery and unforced-error-suppression semantics are deleted.
Lazy parameter defaults remain as the one documented exception.
Proposal 3 is recorded as resolved in this form. Rewrites the binding
sections of `expressions.md`. Chunk plan: [`strict-let.md`](strict-let.md)
— pins the dependency relation, the normative evaluation order, cycle and
dynamic-reference error identity, and the module-entry rule; the rewrite
surface extends to `modules.md` and both execution-limits documents (the
binding-force event narrows to parameter defaults).

### 2b — strict reads

[`strict-reads.md`](strict-reads.md) is absorbed, including the `$get`
redesign and the absent-vs-null resolution (Proposal 10). Settle the
null-defaulting surface ([`status.md`](status.md)) and the `??` spelling
question here if possible — this chunk owns the access/defaulting forms
that D4 (2e) leans on. Chunk plan:
[`strict-reads-2b.md`](strict-reads-2b.md) — restates the design over the
event-trace cost model (the `$else` arm as an arm-selection branch, path
unfolding as region-constant changes), settles `??` as miss-only with no
dedicated null-defaulting form, and pins error identity, checker typing,
and `hasKey` narrowing; the rewrite surface spans `expressions.md`,
`narrowing.md`, both execution-limits documents, and the shorthand access
and operator references. Spec text landed 2026-08-08; cases remain with 2g.

### 2c — capture closures

**Closures move from substitution to capture** (Proposal 1, with the
record-on-value encoding): escaping bodies are never rewritten; evaluated
free-variable values attach as a capture record on the function value, a
sibling of `$params`/`$return`. Capture is one mechanism generalized to
values, escape is idempotent, name collisions are impossible by
construction, and inertness survives serialization by position. The
capture record's cost charges at the closure-creation event (Stage 1,
item 4); re-entry charges 1. The record prints as the local-binding form
for audit reading. Rewrites `functions.md`/`closures.md`; the normalizer
and printer rules plus hash vectors for the record shape are drafted here
and assembled in 2g. Chunk plan:
[`capture-closures-2c.md`](capture-closures-2c.md) — pins the record shape
(`$captures` generalized to values, empty omitted), the capture relation as
2a's edge rule viewed from the value side, the flat-group rule for by-name
recursion after escape, the no-new-event cost treatment (records fold into
region constants; hydrated application charges re-entry), boundary
validation, and the audit-rendering posture for printing. Spec text landed
2026-08-09; cases remain with 2g.

### 2d — the parameter surface: `$fields` lowering + `$sig` inlining

The two parameter changes are one chunk: both rewrite the same
`functions.md`/`type-syntax-spec.md` text, and the alignment rules the
`$sig` removal deletes are the same rules the `$fields` collapse forces a
rewrite of.

- **Parameter richness** (Proposal 6, in-scope portion): `$fields`
  destructuring patterns collapse into desugaring. The defaults axis is
  dropped — defaults stay lazy and primitive. The lowering is deliberately
  chosen as the **flat image of the future pattern lowering**
  ([`type-eval-coherence.md`](type-eval-coherence.md) §1 piece 2): an
  irrefutable object pattern of bare binders lowers to a body-top `$let` of
  `$get`/`$else` projections (2a's eager `$let`, 2b's access forms;
  optional fields bind `null` on absence), with the printer folding the
  parameter shape back. Parameter unification later _extends_ this surface
  rather than re-lowering it; no pattern-bind kernel node is introduced
  yet. The signature shape (`required`/`optional`/`rest`) is untouched as
  the interface description (below).
- **`$sig` inlining** ([`type-eval-coherence.md`](type-eval-coherence.md)
  §2): `$sig` is removed from **function bodies only**. Types attach
  per-slot (`$type` on the parameter descriptor); the return type moves to
  a `$returns` sibling on the body. The
  `required`/`optional`/`rest`/`returns` callable shape survives as the
  **interface description** — contract `functions`, contract `entry`, the
  builtin registry — with a normative derivation function from the inline
  form; the "selected module function must satisfy the contract entry"
  check consumes the derivation. "Fully typed or bare" becomes a per-body
  lint; contextually typed bare lambdas are untouched. Forward commitments
  land with it: `$type` is pinned as the shared attachment key (the future
  pattern dialect's typed binder uses the same shape); schema payloads
  inside `$params` are static syntax (a row in the raw-inference
  conformance matrix); annotations fold into the containing region's
  static constant (one line in the D2 cost framing — typing a function
  cannot change its fuel).

Chunk plan: [`param-surface-2d.md`](param-surface-2d.md) — restates both
changes over the 2a/2b/2c vocabulary and pins: the synthesized slot name
and its shorthand reservation; the defaulted-field question the adopted
texts left open (field `= e` lowers to the `$else` arm, so the lazy
exception narrows to the positional `$default` — flagged as revising two
landed sentences); the slot grammar with `$type`/`$returns`; the
interface-description derivation and its consumers; alignment rules as
derived read checking, with fully-typed-or-bare as the per-body lint; the
annotations-charge-nothing cost line; and the printer fold-back
conditions. The rewrite surface spans `functions.md`,
`type-syntax-spec.md`, `expressions.md`, both execution-limits documents,
the contract and registry wording, and `closures.md`'s co-owned
value-shape text.

Note 2c and 2d both alter the function-value shape (capture record;
`$returns` and typed descriptors) — the `functions.md` hashing/printing
text is co-owned, so whichever chunk is written second reconciles it.

### 2e — boolean conditions (D4)

Decision **D4** in [`status.md`](status.md): truthiness is deleted.
Conditions (`$if`, `$cond` arms) must be boolean; a non-boolean condition
is an evaluation error (evaluator-enforced, fail-closed — condition
position is a runtime position whose semantics is validation against the
boolean schema). `$and`/`$or` become boolean-only (operands boolean,
result boolean, short-circuit preserved); prefix `!` likewise. Condition
narrowing becomes exact. The truthiness sections of `expressions.md`,
`narrowing.md`, and `spec-v2/docs/language/shorthand/control-flow.md` are
rewritten; the authoring guide follows. Absence-defaulting is already
absorbed by 2b's `$get`/`$else`; the null-defaulting surface replacing
`x || default` is settled in 2b (or tracked in
[`status.md`](status.md) if it slips). Chunk plan:
[`boolean-conditions-2e.md`](boolean-conditions-2e.md) — pins the
boolean-position inventory (conditions, `$and`/`$or` operands, `!`/`not`,
and the boolean-declared predicate-callback results, so truthiness deletes
from the stdlib too), validation attached to evaluation with the
short-circuit shape preserved, error identity and the host-error class, the
condition-type checker rule, the exact boolean narrowing rewrite, the
no-cost-change statement, and the `$and`/`$or` minimum-arity constraint;
the rewrite surface spans `expressions.md`, `narrowing.md`, the shorthand
control-flow and operator references, `standard-library.md`, and the
guide's truthiness teaching. Spec text landed 2026-08-09; cases remain
with 2g.

### 2f — the coherence framing section

[`type-eval-coherence.md`](type-eval-coherence.md) §3: a short normative
section, landed alongside this stage's rewrites — the checker's types and
the evaluator's validators are the same objects; checking never changes
behavior (erasability); in a checked program, runtime contract errors fire
only at declared trust boundaries; and the normatively declared
**exactness fragment** (which D4 keeps clean on conditions and D5 defines
for exhaustiveness). Written after 2b/2d/2e so it states, rather than
anticipates, the adjacent text. It acts as the filter for later work
(`isType` respecification, the `$nonnull` deletion path).

### 2g — conformance assembly

Migrate the affected `spec-v2/cases/check/` suites for strict bindings,
generalized captures, `$fields` lowering, strict `$get`, inline parameter
types, and boolean conditions; add `$else` and `hasKey` narrowing
coverage. The v1 corpus remains unchanged. Final printer/normalizer
round-trip rules and the hash vectors drafted in 2c/2d are assembled and
pinned here, once, for the whole stage — this is what makes the stage a
single format break.

## Stage 3 — kernel cleanup

Small, definite deletions against the Stage 2 language.

1. **Remove `$if`**; one-arm `$cond` is the survivor. `$match` stays
   canonical.
2. **Record Proposal 5 as resolved**: `$and`/`$or` stay as forms; their
   boolean-only semantics landed with D4 in Stage 2.
3. **Run the Proposal 7 name-resolution audit** against the final resolution
   order (which retains a capture lookup tier), deleting asymmetric normative
   text where found.
4. **Scalar `$match` corrections**
   ([`type-eval-coherence.md`](type-eval-coherence.md) §1 piece 2): case
   position becomes **static syntax** with the `^` / `$pin` escape for
   dynamic equality (`{"$pin": <expr>}` canonically; evaluate, compare by
   structural equality); `$else` becomes elidable when the checker proves
   the arms exhaustive **on the scalar universe** (resolving the existing
   `$else` spec/impl divergence in that direction). Format-visible breaks
   confined to the scalar `$match` that already exists; no pattern grammar
   is introduced. Lands before this stage's case regeneration so
   regenerated cases pin the corrected `$else` and case-position semantics.
5. Regenerate the affected `spec-v2/cases/` suites (as with every stage) —
   against the corrected `$match` semantics and the D5 fragment boundary.

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
- Pattern matching ([`pattern-matching.md`](pattern-matching.md)) — the
  clock-sensitive pieces are extracted into Stages 2–3 above (the `$fields`
  lowering choice; the scalar `$match` corrections) and the v1 fragment
  boundary is resolved (**D5** in [`status.md`](status.md)). What remains
  lands post-Stage-5 as two units: the **pattern dialect + `$match`
  generalization** first (grammar, erasure, normative match order and
  per-node charge over the Stage 1 event-trace model, intersection
  narrowing, fragment exhaustiveness), then **parameter unification** as
  the separable second unit — mostly surface, printer fold-back, and the
  irrefutability subsumption check, given Stage 2's lowering choice. The
  `isType` respecification (schema intersection sharing the pattern-arm
  machinery) and the `$nonnull` deletion path ride the same window.
- The testing framework ([`testing-framework.md`](testing-framework.md)) —
  additive by construction (`$tests` is excluded from module identity); can
  land any time after Stage 1.
- Effect taxonomy and contract knob declarations — one future versioned
  contract revision.
- Content-addressing follow-ups and the celld/DO profile
  ([`do-target.md`](do-target.md)) — host layer; their spec-v2 footprint is
  exactly Stage 4.
