# Plan: two-tier cost determinism and metering profiles

Status: **proposed.** Supersedes the strong option settled under
[`later/simplification-proposals.md`](later/simplification-proposals.md)
Proposal 8 and revises `docs/runtime/execution-limits.md`. There is no
backwards-compatibility constraint, so this lands as one breaking
reclassification of the cost model rather than a compatibility layer over
the current one.

Split the cost model into two tiers. Tier 1 is language surface: fuel
exists, is deterministic, additive, and a hard termination bound, and its
exhaustion is a deterministic guest-visible failure. Tier 2 is a **metering
profile**: the concrete charge assignments — per-node costs, builtin
metering, laziness and caching charges — published as a named, versioned,
hashable artifact and pinned into deployment identity. Determinism is
bit-exact **within a profile**; across profiles, only values, effect
sequences, and error identity are portable. The current cost model becomes
the reference profile, not the language.

## Motivation

The strong decision promoted the entire cost model into cross-implementation
observable semantics: every builtin's metering, the caching policy, and
demand order are conformance surface for every evaluator, forever. Proposal 8
priced this honestly ("effectively the entire evaluator becomes
conformance-testable cost model") and the price lands on exactly the work
this repository is planning:

- **Compilation.** Only faithful-cost compilation is legal. Constant
  folding, dead-code elimination, inlining, and strictness analysis all
  change observable node counts. A native implementation is reduced to a
  tree-walker with the dispatch removed.
- **Lazy refs.** The hardest open blocker in
  [`content-addressing/lazy-refs-and-cas-runtime.md`](content-addressing/lazy-refs-and-cas-runtime.md)
  is that portable fuel cannot depend on chunk thresholds, cache warmth, or
  store state, so every hydration and cache-hit path needs spec'd virtual
  inline-equivalent charges. Under this plan those charges are profile
  territory.
- **Memoization and parallelism.** A `(callee hash, args hash)` cache and
  parallel forcing of independent lazy bindings are value-invisible but
  fuel-visible. Strong fuel forbids both outright.
- **Kernel size.** The simplification review's central argument is that
  oversized normative surface is what drifts and freezes secondary
  implementations (the LuaJIT lesson). Strong fuel is the single largest
  contributor to that surface, and it must be replicated _in every
  evaluator_, not just every checker.

Against these costs, the strong option's stated benefit — "a workflow
suspended under one interpreter resumes under another with the same
remaining budget" — protects less than it appears to. Per
`docs/runtime/execution-limits.md`, a durable suspension **ends the
invocation**, and recovery or delivery starts a new invocation **with fresh
configured limits**. Remaining budget never crosses a suspension. What
strong fuel actually guarantees is that a single invocation exhausts at the
same point on every implementation — a hazard that arises only when one
workflow is executed by different implementations, which is precisely the
condition
[`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md)
already detects and policy-gates. The version-skew problem has a targeted
solution; strong fuel is a second, global solution to the same problem, paid
for by every optimization the language could otherwise perform.

What durability genuinely requires is narrower and is kept in full:
recompute-from-basis needs pure evaluation to reproduce identical **values**
and an identical **effect sequence** (so replay assigns the same effect
IDs), and it needs fuel exhaustion to be **deterministic within the
deployment that recomputes**. Both are Tier 1 / same-profile properties
below. Neither requires that two different engines agree on the price of a
`sort`.

## Design

### Tier 1: portable fuel axioms

The language reference specifies fuel by axioms, not by charges. For every
conforming implementation and every profile it executes:

1. **Determinism.** Fuel consumed is a function of the program, its inputs,
   the recorded effect results, and the metering profile. Parser metadata,
   caching, serialization, ingestion route, wall-clock, and store state do
   not change it. (Unchanged in substance; the profile joins the function's
   domain.)
2. **Additivity and monotonicity.** Fuel only accrues, and the fuel of a
   computation is the sum of the fuel of its parts under the profile's
   aggregation rule. Aggregation must be order-independent for parts whose
   evaluation order is not value-observable, so that parallel forcing of
   independent bindings is a legal implementation strategy.
3. **Completeness (termination floor).** Every function invocation charges
   at least 1. Every builtin charges at least 1, and native input-sized work
   charges at least proportionally to that input under a profile-declared
   constant. Every array or string produced by a builtin or host function
   charges at least its top-level length. Consequently a finite `maxFuel` is
   a hard termination and allocation bound under **every** profile — the
   property agent-written code actually needs from fuel.
4. **Deterministic exhaustion.** Evaluation fails at the first program point
   where consumed fuel exceeds `maxFuel`, and that point is deterministic
   within the profile. The failure is the existing guest-visible fuel error;
   its identity does not carry profile detail.
5. **Reporting.** Usage reporting exposes consumed fuel and the profile
   identifier without changing evaluation.

Value semantics, effect sequencing, error identity, laziness as
value-observable behavior (an error in an unforced binding never fires;
cycles fail only when forced), `maxValueSize`, `maxCallDepth`, boundary
validation, and the fixed structural depth of 512 are untouched and remain
cross-implementation normative. Only _charging_ moves.

### Tier 2: the metering profile artifact

A metering profile is portable JSON, conventionally `.metering.json`,
declaring:

- `id`: a domain-separated, versioned identifier (for example
  `jfn:metering:tree-v1`);
- the expression-node charge rule and function-invocation charge;
- the per-builtin metering table, keyed by builtin name against the
  signature registry;
- the laziness charge policy (charge on first force, as today, or charge on
  bind);
- the cache policy charges (constant-subtree re-entry, memoization hit, ref
  hydration, `eq` hash fast-path), each either a declared virtual charge or
  `as-computed`;
- the completeness constants of axiom 3.

Profile validation is structural and closed, mirroring contract validation:
unknown keys reject, every builtin in the signature table must have an
entry, and the declared constants must satisfy the axiom-3 floors. A profile
cannot express charges that depend on anything outside axiom 1's domain.

The deployment profile references exactly one metering profile. The
**deployment identity hash** from module-identity pinning extends its
"closed portable limits" component to include the metering profile `id` and
content hash. Two deployments differing only in metering are different
executable worlds, which is correct: they disagree about where a
recomputation exhausts.

### The reference profile

The complete current cost model in `docs/runtime/execution-limits.md` — one
unit per expression node, one per invocation, the existing builtin metering
obligations, first-force laziness charging, `$raw` value-node charging,
constant-subtree re-entry at 1 — is republished verbatim as
`jfn:metering:tree-v1`, the reference profile. The canonical TypeScript
implementation implements it. Nothing about today's observable behavior
changes for a deployment pinned to `tree-v1`; the change is what that
behavior is _called_.

An implementation must execute at least one profile correctly and must
reject a deployment whose metering profile it does not implement, using the
stable validation-classification convention. Implementing `tree-v1` is
recommended, not required: a compiling implementation may instead publish
`jfn:metering:compiled-<name>-v1` with basic-block-precomputed charges,
`as-computed` cache hits, or coarser builtin constants, provided the axioms
hold.

### Evaluation nesting joins Tier 2

The fixed evaluation-nesting limit of 4,096 counts expression nesting
accumulated across open call frames — an artifact of tree-walking that a
compiled implementation flattens away and would otherwise simulate with a
virtual counter solely to fail at the mandated point. It is reclassified as
a profile-declared safety limit with a required floor: every profile
declares an evaluation-nesting limit of at least 4,096 (or declares the
limit structural-depth-subsumed for non-recursive evaluation strategies),
and exhaustion remains a deterministic guest-visible failure within the
profile. Structural depth 512 is representation integrity, not cost, and
stays fixed.

### Recovery, resume, and cross-world policy

- **Same deployment (the durable path today):** recompute-from-basis is
  bit-identical, including exhaustion points and effect-ID assignment.
  Nothing weakens.
- **Different world at resume:** already detected by the identity hash. The
  driver policy vocabulary gains one axis: `metering: "same-profile"`
  (default: reject a resume under a different metering profile) or
  `metering: "any"` (accept; invocations run under the resuming world's
  profile with its fresh configured limits — sound because budget never
  crosses the suspension anyway).
- **Effect IDs:** unaffected. The replay sequence is a Tier 1 consequence of
  value and effect-sequence determinism, not of charging.

## What this supersedes and unlocks

- Proposal 8 is resolved by construction: fuel determinism is strong within
  a profile and deliberately not cross-profile. The "decide on purpose"
  demand is met with the boundary drawn where the durability model actually
  needs it.
- Proposal 3 (laziness) loses its fuel entanglement: demand-dependent
  charging becomes a profile line item, and the language-level laziness
  decision reduces to value semantics and authoring ergonomics. The pinned
  conformance window stops being spent by the cost model.
- The lazy-refs plan drops its hardest blocker. Hydration, cache warmth, and
  hash fast-path charges are declared in the CAS runtime's profile rather
  than specified as cross-implementation virtual costs.
- Sound memoization and parallel forcing become legal implementation
  strategies under any profile declaring their charges.
- The strict-reads plan's fuel coordination note shrinks to: update the
  `tree-v1` profile cases in the same release.

## Conformance impact

`spec/cases/` splits along the tier boundary:

- value-semantics, parse, hash, and deployment cases remain language
  conformance, unchanged;
- existing fuel-observing eval cases move under
  `spec/profiles/tree-v1/cases/` and become conformance for that profile;
- new Tier 1 cases assert the axioms structurally: exhaustion determinism
  under a fixed profile, the completeness floors (a loop of N invocations
  fails under `maxFuel < N` on every profile), and reporting stability.

Language conformance surface shrinks by the entire metering table; profile
conformance carries it for implementations that opt in.

## Costs and risks

Stated so they are chosen, not inherited:

- **Budget portability is lost as an automatic property.** A `maxFuel` tuned
  under one profile is only a _bound_, not a _measure_, under another.
  Mitigation: axiom 3 keeps it a real bound everywhere; operators tune
  budgets per profile, which they already do per deployment.
- **Cross-engine usage comparability is lost.** Fuel reports are
  profile-scoped. Billing and quotas become host/profile territory, which
  matches their non-portable character today (wall-clock and cancellation
  are already host-local).
- **Profile proliferation.** Many profiles would fragment the ecosystem the
  way many dialects would. Mitigation: one blessed reference profile,
  profiles as validated registered artifacts, and identity pinning making
  every divergence visible rather than silent.
- **A subtle class of spec bugs moves.** Under strong fuel, a metering
  disagreement is a conformance failure caught by shared cases; under
  profiles, it is a profile bug caught only by that profile's cases. The
  Tier 1 axioms are deliberately small so the language-level statement stays
  checkable.

## Implementation steps

1. Rewrite `docs/runtime/execution-limits.md` as Tier 1 axioms plus a
   pointer; publish `tree-v1` as a metering-profile document and JSON
   artifact with schema and validation classifications.
2. Extend the deployment profile to reference a metering profile; extend
   `validate-profile` and the identity-hash projection; add the resume
   policy axis to the durable driver.
3. Relocate fuel-observing spec cases under the profile tree; add the Tier 1
   axiom cases.
4. Land the TypeScript changes: profile loading and validation, the
   identity-hash component, and the (mechanical) re-labelling of the
   existing meter as `tree-v1`.
5. Update AGENTS.md, the roadmap's Phase 0 decision record, and the
   Proposal 8 post-review note to point here.

## Acceptance criteria

- A deployment pinned to `tree-v1` is behaviorally indistinguishable from
  today, including every existing fuel case.
- A second profile with different builtin constants passes Tier 1 axiom
  cases unmodified and fails none of the value-semantics suite.
- A resume under a world differing only in metering profile is rejected
  under the default policy and accepted under `metering: "any"`, with the
  divergence visible in both records.
- No document outside the profile tree states a numeric charge.

## Open questions

- Should the reference profile be mandatory-to-implement for the first N
  releases to keep early implementations comparable, then relaxed? (The
  reversibility argument that justified settling strong fuel pre-consumer
  argues yes; the kernel-size argument argues no.)
- Does axiom 2's order-independent aggregation need a normative statement of
  which evaluation orders are value-observable, or is the existing laziness
  spec sufficient as the boundary?
- Whether `maxCallDepth` should join Tier 2 alongside evaluation nesting.
  It is kept portable here because call depth is strategy-independent and
  contract-adjacent, but a CPS evaluator has no native notion of it either.
