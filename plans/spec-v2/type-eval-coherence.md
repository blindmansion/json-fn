# Type/eval coherence, `$sig` inlining, and pattern-matching sequencing

Status: **adopted**, 2026-08-08 (written as working notes the same day). The
consolidated ordering in §4 is folded into [`plan.md`](plan.md) (Stage 2
items 5–7, Stage 3 item 4, the revised pattern-matching posture); the two
flagged open decisions are resolved as **D4** (truthiness: boolean
conditions required) and **D5** (pattern v1 fragment boundary: the
proposal's fragment as written) in [`status.md`](status.md). Compiled from a
design discussion
against the spec-v2 tree and plans. Covers three linked questions: where the
pattern-matching change fits in the adopted stage sequence
([`plan.md`](plan.md)), whether `$sig` should be removed in favor of inline
parameter types, and the general principle both decisions instantiate —
building the type system and evaluation coherently instead of the current
bolted-on relationship. Written in the plans' vocabulary; cites
[`pattern-matching.md`](pattern-matching.md),
[`simplification-proposals.md`](simplification-proposals.md) (Proposals 6, 7,
9), [`strict-reads.md`](strict-reads.md), and the Stage 1–5 sequence.

---

## 1. Sequencing the pattern-matching change

The tension: the adopted plan lands Proposal 6's `$fields` collapse in
Stage 2, while `pattern-matching.md` names pattern parameters as the natural
desugaring _target_ for that same collapse. Treated as one schedulable unit,
"pattern matching after the plan" re-lowers the same surface twice, with a
format-visible break each time. The resolution is to split the proposal into
three pieces with different clocks.

### Piece 1 — the fragment-boundary decision: now, in parallel

The v1 exhaustiveness-fragment / leaf-exclusion decision
(`pattern-matching.md` sequencing step 1) is pure design work with no stage
dependencies, and it is the input to piece 2. It should land before Stage 3's
check-corpus regeneration, so regenerated cases do not pin behavior the
fragment decision will change.

### Piece 2 — clock-sensitive extractions, folded into Stages 2–3

Two parts of the proposal get more expensive with every regenerated
`spec-v2/cases/` suite (Proposal 9's logic, which the proposal itself cites):

- **Static case position, the `^` / `$pin` escape, and `$else` elision on the
  scalar universe.** Format-visible breaks confined to the scalar `$match`
  that already exists. The exhaustiveness machinery (`caseUniverse`) is
  implemented; the `$else` spec/impl divergence is already leaking. This is
  Stage-3-shaped kernel cleanup requiring no pattern grammar, and landing it
  there means Stage 3's case regeneration pins the _right_ `$else` and
  case-position semantics instead of the wrong ones.
- **Choose Stage 2's `$fields` lowering to be the flat image of the future
  pattern lowering.** Today's `$fields` is flat — no renaming, no nesting —
  which is exactly the fragment where "irrefutable object pattern of bare
  binders" and "body-top `$let` of `$get`/`$else` projections" produce the
  same shape (using the strict-reads access forms landing in the same stage
  for the optional-field null-on-absence rule). Picking that lowering
  deliberately means parameter unification later _extends_ the surface rather
  than re-lowering existing programs: no second format break for interim
  shapes, and no pattern-bind kernel node needed yet — only nested/renamed
  patterns want one, and those do not exist until the dialect does.

### Piece 3 — the dialect proper, after the staged plan

The refutable core genuinely depends on Stage 1 and 2 vocabulary: normative
match order and per-node charge require the event-trace model (and the
closed-per-version, versioned-addition event rule is what makes deferral
safe cost-wise — match/dispatch events attach to new node kinds later without
perturbing existing programs); absence/optional-field rules require strict
reads; eager `$let` fixes the binder-installation lowering. Keep `plan.md`'s
posture: land the dialect + `$match` generalization as one unit post-Stage-5,
then parameter unification as the separable second unit — which, given
piece 2, shrinks to mostly surface, printer fold-back, and the
irrefutability subsumption check.

### Off every track

The `$sig`/contract signature-shape axis stays gated on its own deliberate
contract revision (Proposal 6's caution; `pattern-matching.md`'s stated
posture; `status.md`). Patterns are language-side; the contract keeps
describing object types. See §2 for how the `$sig` removal respects this.

## 2. Remove `$sig`; inline types into `$params`

Direction: **yes**, scoped precisely and bundled into Stage 2.

### Why

- **It deletes a zip invariant.** `type-syntax-spec.md`'s Parameter alignment
  section is cross-field bookkeeping every implementation must replicate:
  `$sig.required` aligns with leading required slots, `$sig.optional` with
  optional _and_ defaulted slots in source order, an object pattern consumes
  one signature slot while its fields consume none, and `rest` stores the
  element type where the surface writes the array type. That is a Proposal
  7-class asymmetry, plus a whole misalignment error class that cannot exist
  if the type lives on the slot.
- **Canonical form matches the surface.** `(color: Color) -> Color` already
  reads inline; lowering to a parallel structure is pure distance between
  shorthand and artifact.
- **It is where the pattern proposal is heading.** The dialect's typed binder
  is `{"$bind": name, "$type": schema}` — an inlined parameter type _is_ a
  typed binder. `$sig`-as-parallel-array gets strictly worse as parameter
  patterns get richer (alignment against a nested pattern slot has no good
  answer).

### Scope

`$sig` currently does double duty: author annotation on the body, and the
same shape as the interface artifact. Split them:

- Remove `$sig` from **function bodies only**. Types attach per-slot
  (`$type` on the descriptor); the return type moves to a `$returns` sibling
  on the body (no array, no alignment problem). "Fully typed or bare"
  survives as a per-body lint instead of a structural fact; contextually
  typed bare lambdas are untouched.
- The `required`/`optional`/`rest`/`returns` callable shape **survives as the
  interface description** — contract `functions`, contract `entry`, the
  builtin registry — with a small normative derivation function from the
  inline form. The "selected module function must satisfy the contract
  entry" check consumes the derivation. This keeps the operator-facing,
  churn-intolerant artifact untouched.

### Ordering: into Stage 2, not parked with pattern work

- Stage 2 is already the one versioned function-body format break (capture
  records, `$fields` desugaring, functions/hashing/printer rewrites). A
  second body-format change later re-pins hash vectors and cases for the
  same region twice — Proposal 9 says one break.
- Stage 2's `$fields` desugaring forces a rewrite of the alignment rules
  regardless ("an object pattern consumes one slot" stops being true when
  the slot is sugar). Rewriting that text only to delete it later is the
  expensive path.

### Forward commitments to make explicitly

- Pin `$type` as the shared attachment key now, so the dialect's typed
  binder lands on the same shape and parameter unification becomes a
  definition ("a typed param slot is a typed binder over a bare-name
  pattern"), not a migration.
- A row in the raw-inference conformance matrix: schema payloads inside
  `$params` are static syntax (same exemption pattern positions need).
- A line in the D2 cost framing: annotations fold into the region's static
  constant, so typing a function cannot change its fuel.

### Honest residue

Another format-visible change on the same pre-consumer clock; the checker's
contextual-typing and contract-subsumption text is restated per-slot. But
Stage 2 breaks the body format regardless, so the marginal price is near its
floor — and the alternative carries the zip invariant into a
pattern-parameter world, where it ages badly.

## 3. The general principle: one dialect, two consumers

The pattern proposal's load-bearing sentence — patterns erase to schemas,
matching is `$as` validation — is not a trick for match arms. It is the
general answer to "the type system was bolted onto a type-less evaluator":

> **The checker's types and the evaluator's validators are the same
> objects.** One schema dialect; the evaluator consumes a schema as a runtime
> test, the checker consumes the identical schema as a type via subsumption.

Coherence then is a checkable property, not a vibe: every static concept has
a runtime meaning by validation, and every runtime dispatch-or-assert
construct is defined over the dialect so the checker reasons about it with
the same machinery.

### Classifying the current leaks

- **`$as` — the good leak.** Already the one place type and value semantics
  coincide, which is why the pattern proposal could be built on it. The seed,
  not a wart.
- **`$nonnull` — the bad kind.** An evaluator node that exists because
  narrowing is weak: checker-shaped syntax leaking downward. Once the
  dialect lands it becomes definable rather than primitive (a wildcard match
  with a null arm, or ascription to the null-stripped type) — a future
  Stage-3-spirit kernel-deletion candidate, not worth touching before then.
- **Narrowing's static-access-path restriction — the third kind.** A checker
  limitation caused by eval offering no way to _name_ a projection (hence
  path-facts, hence `roles[0]` can never be a subject). Binders dissolve it
  structurally: coherence achieved by giving eval the right construct, not
  by making the facts model smarter.

### Two properties to state normatively

1. **Erasability.** Checking never changes behavior; the evaluator consults
   `$type` only at explicitly runtime positions (`$as`, patterns, parameter
   validation, contract edges), where the semantics is schema validation.
   This is what makes skipping the checker safe — secondary implementations
   carry only the evaluator (Proposal 4's observation), and durable
   workflows may resume on such hosts. Coherence must be achieved by
   defining eval constructs over the shared dialect, never by making
   evaluation depend on checking.
2. **A soundness statement.** In a checked program, runtime contract errors
   fire only at declared trust boundaries — `$as`, contract ingress, host
   data. "Well-typed programs don't go wrong except where they said they
   might." The fail-closed posture already in `narrowing.md` ("checking
   fails rather than widening to `any`") is what makes it attainable.

### One exactness fragment, named once

The honest limits — no `not` in the dialect so subtraction is partial;
refinements do not survive arithmetic; truthiness splits on numbers/strings
are not schema-expressible and widen — are currently scattered as per-feature
restrictions (narrowing subjects, `caseUniverse`, `excludeLiteral`, the
pattern proposal's declared fragment). The coherent version is a single
normatively declared **exactness fragment** of the dialect — where
subsumption, subtraction, and exhaustiveness are exact — with every consumer
stating its behavior on and off it. The pattern proposal already does this
for match; generalize it retroactively.

**Flagged open decision: truthiness.** Falsy-`0`/`""` is agent-ergonomic but
a permanent, unfixable exactness loss in condition narrowing. Decide on
purpose (keep it and name the loss, or require boolean conditions) rather
than inherit it; the price only rises.

### Landing shape

A thin framing document, not a stage: a short normative section — "types are
validators; types erase; failure only at declared boundaries; here is the
exactness fragment" — landable alongside Stage 2, since strict reads and the
`$sig` inlining already rewrite the adjacent text. It then acts as a filter
for later work: the `isType` predicate family gets respecified as schema
intersection sharing the pattern-arm machinery; `$nonnull` gets a deletion
path; `$type`-on-slots becomes an instance of the invariant rather than a
one-off.

**Audit procedure.** Walk every eval/checker touchpoint — truthiness, `$as`,
`$nonnull`, `isType` facts, match universes, parameter validation, overload
selection, the contract boundary — and classify each as: shared-dialect
(good); eval-only with a stated widening (acceptable, named); or
checker-only with no runtime meaning (suspect — this is where bolted-on-ness
actually lives, and the category should be small).

## 4. Consolidated ordering

1. **Now, in parallel:** the pattern v1 fragment-boundary decision (§1
   piece 1); the truthiness decision (§3).
2. **Stage 2:** `$fields` lowering chosen as the flat image of the future
   pattern lowering (§1 piece 2); `$sig` removed from bodies, `$type` on
   slots, `$returns` on bodies, contract-shape derivation specified (§2);
   the coherence framing section landed alongside (§3).
3. **Stage 3:** static case position + `$pin` + scalar `$else` elision (§1
   piece 2); regenerate cases against the corrected semantics, after the
   fragment decision.
4. **Post-Stage-5:** pattern dialect + `$match` generalization as one unit;
   then parameter unification as the separable second unit, now mostly
   surface + printer + irrefutability checking (§1 piece 3). `isType`
   respecification and the `$nonnull` deletion ride the same window.
5. **Independently gated:** the contract signature-shape axis — only ever a
   deliberate versioned contract revision.

The through-line: the system already stumbled into the right seam (`$as` as
shared validator/type, fail-closed widening, patterns-as-schemas). The
project is promoting the accident to an invariant, extracting the pieces
whose price rises with every regenerated case into Stages 2–3, and deleting
what contradicts the invariant when the dialect lands.
