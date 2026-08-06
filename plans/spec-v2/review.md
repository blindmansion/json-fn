# Review: the spec-v2 decision cluster

Status: **review / synthesis.** External design review of the proposals under
`plans/spec-v2/` and `simplification-proposals.md` (all of Proposals 1–10),
read against the settled Phase 0–3 work, the content-addressing plans,
`strict-reads.md`, and the root-level plans. The goal is to pull the threads
into one decision graph, state a leaning on each open question, dispose of
the easy calls (§7), and name the loose ends and remaining cross-cutting
decisions (§6, §8) that no single document currently owns.

---

## 1. What is actually being decided

Two clusters, plus a sequencing question between them:

**The cost model.** Two competing redesigns of fuel:
`metering-profiles.md` (keep the current definition, scope bit-exact
determinism to a named, versioned profile pinned into deployment identity)
and `event-trace-cost-model.md` (redefine cost as a static function over
straight-line regions of the canonical program plus a closed vocabulary of
dynamic semantic events, retaining strong cross-implementation determinism
because the trace is a pure function of value semantics).

**The closure representation** ("the 1+2+3 design unit"):

- **P1** — replace substitution closures with environment-record capture:
  never rewrite an escaping body; attach evaluated free-variable values as a
  record beside it.
- **P2** — represent that record as an ordinary `$let` (each value in
  `$raw`) wrapping the body; delete `$captures` from the language.
- **P3** — make `$let` eager and sequential, reserving forward reference
  for function-valued bindings.

**Sequencing.** `simplification-proposals.md` says to evaluate 1+2+3
"against the settled fuel model." But the event-trace plan proposes to
replace that model, and (see §4) the replacement dissolves the hardest open
problem in the closure arc. The order of decisions is itself a decision.

---

## 2. The requirements floor for cost

Before choosing between the two cost proposals, it is worth writing down
the minimum the language actually needs from fuel, because v1 demonstrably
bought more than this and the excess is what every other plan keeps
tripping over.

The floor has exactly three properties:

1. **A hard halt bound** on accidentally or maliciously expensive code
   within one invocation. Needs monotone accrual and completeness floors,
   never per-node exactness.
2. **Replay determinism within a pinned deployment.** This one is _not_
   optional and is the reason "just use wall clock" fails: durable recovery
   is recompute-from-basis, so a replaying invocation must exhaust exactly
   where the original did. A workflow that legitimately exhausted must not
   replay to success; one that succeeded must not exhaust on replay.
   Determinism is a durability requirement, not an aesthetic.
3. **Additivity / monotonicity**, so audit tooling can reason about
   budgets compositionally.

Everything above the floor — cross-implementation bit-exactness, per-node
exhaustion precision, _accurate_ builtin costs — is ecosystem coherence,
worth keeping only where it is cheap. Note that the floor is precisely
Tier 1 of `metering-profiles.md`; the disagreement between the two plans is
entirely about what sits above it.

A corollary worth writing into the spec as framing, because it is the
immune system against future scope creep: **fuel is a semantic work
measure for termination and replay, never a resource meter.** Billing and
performance are host territory (job 4 in the event-trace plan's own
taxonomy). The memoization rule already concedes this — a cache hit charges
the _recorded_ fuel of the original computation, so memoization never saves
guest budget, only host time. Fuel and real cost are allowed to diverge;
that divergence is a feature.

---

## 3. Leaning: event-trace, with the guarantee held as a byproduct

**Recommendation: adopt the event-trace model, take its strict-binding
lean (Change 4), keep metering-profiles as the pre-written demotion path
rather than a live alternative.**

The reasoning, in order of weight:

**The value is the deletions, not the guarantee.** Defining cost over the
trace instead of the walk makes evaluation strategy exit the observable
surface: memoization, speculative and parallel forcing, and optimizing
compilation become unconditionally legal (an optimizer's only obligation is
the event trace, which any value-correct compilation preserves). Change 6's
two cache laws — metadata-computable charges without hydration, and
recorded-fuel memoization — discharge exactly the two hardest blockers in
`lazy-refs-and-cas-runtime.md`. This is the "cost model is preventing other
goals" problem solved _by redefinition_ rather than by weakening.

**The strong guarantee is then nearly free — so keep it, loosely.** Strong
cross-implementation determinism falls out because every event is
determined by value semantics. But it should be held as a byproduct, not a
goal: if the static region rule proves fragile to canonicalize, demote to
per-profile scope _without redesigning_ — the event vocabulary, floors, and
cache laws all survive that demotion intact. The design is not betting on
the guarantee; metering-profiles is the fallback the event-trace plan
already names, and its Tier-1 axioms are absorbed unchanged.

**The load-bearing risk is table gravity, not the region rule.** The
flagged bet — the region rule joining hashing and normalization as
canonical machinery — is a good one: the rule is total, decidable, and
vector-testable, and Phase 2 already landed its skeleton as an optimization
(`expression-metadata.ts`). The real failure mode is social: pressure to
make the builtin size functions _accurate_ (because `sort` "really" costs
n·log n, because someone wants fuel to correlate with wall time). The
moment the table chases accuracy, per-node conformance has been rebuilt
inside the registry. **Coarseness is the load-bearing feature**: top-level
lengths only, floors not measurements, and the §2 framing sentence in the
normative text to point at when the pressure arrives.

**Change 4 (strict bindings) should be taken, and its variant preferred
over Proposal 3's.** Deleting the binding-force event makes the trace fully
value-determined — the last channel through which evaluation strategy leaks
into semantics. Note that the event-trace variant (strict but
**dependency-ordered**, cycles still errors) is strictly better than P3's
strict-and-source-order-sequential: it keeps the order-independence that
was P3's only honest counterargument (agent-generated code need not be
topologically sorted), while still deleting the lazy machinery, the
demand-dependent fuel, and the unforced-error-suppression conformance
cases. Lazy parameter defaults remain the documented exception. When the
cost decision lands, P3 should be recorded as resolved _in this form_.

---

## 4. Leaning on the closure arc: P1 yes, P3 via Change 4, P2 in spirit but not in encoding

**P1 — take it, even at the increased sunk cost.** Every argument aligns
with the project's stated identity:

- The substituter is a second, parallel implementation of the entire
  scoping ruleset (~440 lines in TS) that every conforming implementation
  must replicate — exactly the small-kernel Lua lesson the repo itself
  invokes.
- Substitution rewrites bodies, so suspended continuations neither hash nor
  diff against the authored program — undercutting the hashable-auditable
  claim precisely for the values that matter most. Under capture, the body
  is byte-identical to deployed source and the record is a readable state
  snapshot.
- Identity-based runtime marks are now fuel-sound (the Phase 0 stable
  virtual cost decision guarantees mark loss cannot change observable
  behavior), but they remain a per-implementation hazard class; capture has
  nothing to re-derive.
- The format break only gets more expensive. Phase 2 hardened the machinery
  P1 deletes and exact-fuel cases now pin the area, so the break discards
  more landed work than at review time — which is an argument for deciding
  _now_, not for deferring.

**P2 — the fuel collision is diagnostic, not incidental.** P2's problem
under the settled model: `$raw` charges full static-literal cost so
quotation cannot reduce fuel, which means captures-as-`$raw`-in-`$let`
charge state-size-proportional fuel, while substitution's runtime-value
re-entry charges 1. The proposal's own update frames this as "accept the
cost or carve an exception that collides with the just-settled invariant."
But the collision exists because P2 places the record **inside the body**
(the `$let` re-evaluates per application). If the record instead lives **on
the function value** (a sibling of `$params`/`$return`), its cost is
charged once when the function-value literal is evaluated — the same rule
as any literal, one unit per node of the produced value — and references
cost 1 thereafter. No quotation loophole: a hand-authored function value
with a huge record pays the record's cost at construction.

The uncomfortable conclusion: the "policy construct" P2 wants to dissolve
into mechanism turns out to encode a genuine semantic distinction —
**once-per-creation versus once-per-application cost** — that `$let` +
`$raw` cannot express without either a fuel exception or spec'ing
cross-application memoization of escape-emitted frames, which leaks
evaluation strategy back into semantics: the exact disease the event-trace
plan cures. So the leaning is **P2 in spirit** (one mechanism for capture,
values not just function definitions, `$captures` generalized rather than
special-cased to local functions, escape idempotent, the `where`-clause
printing preserved as the audit rendering) **but with the record on the
value, not encoded as body-wrapping `$let`**.

Under the event-trace model this becomes clean rather than exceptional: the
record's constant charges at the closure-creation event (or the
value-materialization event — see §6), applications charge invocation plus
entry-region, re-entry charges 1. The open question in the event-trace plan
about where nested data literals charge is the _same question_ as where the
capture record charges; deciding them together closes both.

**What P2's simplifications survive the re-placement:** most of them.
Function values keep a second field, and lookup keeps a capture tier — those
two simplifications are lost. But the substituter still dies (P1), the
attach machinery for escaping local functions still dissolves (the record
holds values, and function-valued record entries retain
callability-by-name), escape is still idempotent, name collisions are still
impossible by construction, and inertness still survives serialization by
position rather than by identity marks. The trade is two retained spec
sections against a fuel exception; the retained sections are cheaper.

---

## 5. Sequencing: cost first

The simplification doc's ordering ("evaluate 1+2+3 against the settled
fuel model") is superseded by its own successor: the event-trace plan
replaces that model, and §4 shows the replacement dissolves the capture-cost
collision that is currently the closure arc's hardest open issue. Deciding
closures first means measuring them against a cost model with a known
expiration date.

Recommended order, one breaking release, zero external consumers:

1. **Decide the cost model** (event-trace, per §3), including the
   value-materialization open question, _with the capture record's charge
   point as a named test case for that question_.
2. **Decide the closure format** (P1 + record-on-value + strict bindings
   per Change 4) against the new model.
3. **Land together with `strict-reads.md`** as the already-planned single
   coordinated break: all three touch the trace and the conformance suite;
   landing them together produces one semantic break and one suite
   migration instead of three.

The clock argument is real and the repo already states it: lazy-binding and
substitution behavior are now pinned in portable `spec/cases/`, and every
new case raises the price of the break. The conformance suite is quietly
pouring concrete around the status quo; the window the documents call "the
cheap time to decide" is being spent.

---

## 6. Loose ends with no current owner

Collected from across the documents; each needs a home before the
coordinated release:

1. **Value-materialization events.** The event-trace plan's open question
   (charge nested data literals / `$raw` payloads at the containing
   region's event or as a distinct event) now also decides where capture
   records charge (§4). One decision, two consumers — should be resolved in
   the cost plan with the closure case as an explicit vector.
2. **Capture-record placement vs. the normalizer.** Escape-emitted shapes
   must satisfy `parse(print(node)) = normalize(node)`, and normalized
   identity feeds module hashing (Phase 3). Whatever record shape is chosen
   needs printer/normalizer rules and hash vectors in the same change, not
   as follow-up.
3. **CAS measurement gate re-baselining.** Substitution duplication is one
   of the two motivating costs in `content-addressed-values.md`, and the
   durable instrumentation currently measures it. P1 removes that cost
   class; the v1 gate should be re-run post-format-break so the codec is
   justified by per-step duplication alone (which capture does not fix —
   K suspension points still persist K near-copies of threaded state).
4. **Lazy refs and capture records compose — say so.** Partial hydration
   ("read `state.cursor`, never hydrate the 50 MB `state.history`") aligns
   naturally with a capture record (one ref per entry) and awkwardly with
   substitution (splices at each var site). This synergy is currently
   implicit; it belongs in `lazy-refs-and-cas-runtime.md` as a dependency
   note favoring the closure break landing first.
5. **Resume-time charging.** A resumed continuation arrives as input, not
   program. Whether applying it charges the record's materialization cost
   again, or re-entry only (leaning: re-entry only — the cost was paid in
   the original invocation and fuel does not cross suspensions), needs a
   normative sentence in the durable-host spec plus a cost vector.
6. **P3's resolution form.** When Change 4 lands, `simplification-
proposals.md` Proposal 3 should be marked resolved _in the
   dependency-ordered variant_, not the source-order one, so the two
   documents stop describing different strict semantics.
7. **Version-skew residual (Proposal 9).** Unchanged by all of the above:
   closures resolve module and stdlib names at the target host, so
   continuations are never fully self-contained. The format break lands in
   the versioned identity domains per `module-identity-pinning.md`; the
   cost-model version folds into the same identity component. Confirm both
   version bumps ride the same release.
8. **The nesting-limit question.** Whether the evaluation-nesting limit of
   4,096 survives under strict bindings and event-granularity checks, or
   collapses into `maxCallDepth` plus structural depth — flagged in the
   event-trace plan, unowned.
9. **P6 × Change 4: the lazy-defaults collision.** Currently flagged
   nowhere. Change 4 deliberately _retains_ lazy parameter defaults as the
   documented exception to strictness; Proposal 6 desugars defaults into a
   `$let` at the top of the body — which under strict bindings makes them
   eager. Adopting both as written is contradictory. Either P6's desugaring
   emits a lazy form (reintroducing a lazy construct Change 4 just
   deleted), or lazy defaults are dropped alongside P6, or P6's default
   axis is scoped out. One of the three must be chosen explicitly; the
   choice also interacts with the pinned lazy-default conformance cases
   noted in P6's post-review update.
10. **String length semantics are a hidden dependency of the metering
    table.** The event-trace table charges "top-level lengths," but
    `runtime-representation-gaps.md` leaves Unicode metering open. The
    length unit for strings (code points vs. UTF-16 units) must be pinned
    in the same release as the cost law, or string-builtin fuel silently
    diverges across implementations — breaking the strong guarantee in
    exactly the way the event model was designed to prevent. The Unicode
    work should be promoted from open investigation to a named dependency
    of the cost release.
11. **The total-allocation budget is orphaned.** Proposal 8's surviving
    addendum — fuel bounds work, not retention; `maxValueSize` is
    per-value; the structural limits bound tree shape, not residency — lost
    its owner when P8's central question settled. It is orthogonal to the
    event-trace redesign and should be adopted into the rewritten
    `execution-limits.md` (or an explicit follow-up) rather than left in a
    resolved proposal's margins.
12. **Checker-conformance regeneration sequencing.** The canonical migration
    is complete in `spec/cases/check/`. The remaining question is when to
    create the corresponding `spec-v2/cases/check/`: after the coordinated
    break, or by accepting suite regeneration as part of it. The break changes
    narrowing around strict reads, capture lookup tiers, and
    laziness-mirroring reachability, so copying the current corpus first would
    create the same concrete-pouring dynamic as §5.

---

## 7. Disposition of the remaining proposals

The proposals and plans outside the two main clusters, with a call on each.
"Ride the break" means the change belongs in the coordinated release of §5;
"independent" means it can land any time without touching the trace, the
canonical language, or persisted formats.

| Item                                               | Call                                          | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P4 — remove `$if`                                  | **Yes; ride the break**                       | Pure redundancy: one-arm `$cond` has identical evaluation _and_ identical narrowing. `$cond` is the better survivor (flatter JSON, shallower diffs for generated code). The recorded non-proposal — keep `$match` canonical — is correctly argued: its checker value is shape-dependent, and desugaring would force a gensym into the hashable artifact. (But see §8.1: pattern matching may reopen `$match`'s status from the other direction.) |
| P5 — desugar `$and`/`$or`                          | **No; close as won't-do**                     | The doc's own analysis: the gensym tax buys almost nothing since `factsFromCondition` narrowing survives desugaring anyway, and keeping them alongside `$match` is the consistent position. Recording the "no" is itself loose-end cleanup — the proposal is marked tentative and will otherwise linger.                                                                                                                                         |
| P6 — desugar parameter richness                    | **Yes in direction; scope carefully**         | Collapse `$fields` patterns (touches only the language; the signature describes the object type). The defaults axis is blocked on loose-end #9 (the Change 4 collision), and anything touching the `required`/`optional`/`rest` signature shape crosses the contract-format boundary (§8.3) and should be scoped out or bundled consciously.                                                                                                     |
| P7 — name-resolution asymmetries                   | **Yes; audit after the closure format lands** | Mostly deletion of normative sentences, and the asymmetry class is exactly what drifted the secondary implementations. But the record-on-value closure resolution (§4) _keeps_ a capture lookup tier that P2 would have deleted, so the audit must run against the final resolution order, not the current one or P2's.                                                                                                                          |
| P8 addendum — total-allocation budget              | **Yes; adopt into execution-limits**          | Orphaned; see loose-end #11. Orthogonal to the event-trace redesign, so it can ride the break or follow it.                                                                                                                                                                                                                                                                                                                                      |
| P9 — continuation format versioning                | **Effectively resolved**                      | Phase 4A / `module-identity-pinning.md` is the stated posture. The one live ask — a version field on the record format itself, enforced at the validated hydration path — is loose-end #7.                                                                                                                                                                                                                                                       |
| P10 — absent vs. null                              | **Resolved**                                  | Merged into `strict-reads.md`, which redesigned the `$get` node; already part of the coordinated break.                                                                                                                                                                                                                                                                                                                                          |
| `positional-omission.md`                           | **Nothing to do**                             | Already a settled decision record.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `effects-binding-scope.md`                         | **Yes; independent**                          | Documentation correction, no behavior change.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `leading-pipe-unions.md`, `module-where-blocks.md` | **Yes; independent**                          | Shorthand parser/printer only; no canonical, checker, or evaluator impact.                                                                                                                                                                                                                                                                                                                                                                       |
| `future-authoring-improvements.md`                 | **Leave parked**                              | Correctly labeled a parking lot; nothing in it gates the break.                                                                                                                                                                                                                                                                                                                                                                                  |
| `checker-conformance-migration.md`                 | **Done for `spec/`; sequence spec-v2 deliberately** | See loose-end #12: create the spec-v2 corpus after the break, or price its regeneration into the break.                                                                                                                                                                                                                                                                                                                                      |
| `runtime-representation-gaps.md`                   | **Mostly landed; one promotion**              | The open Unicode metering work becomes a named dependency of the cost release (loose-end #10).                                                                                                                                                                                                                                                                                                                                                   |

---

## 8. Remaining cross-cutting decisions

Beyond the two clusters already resolved by leaning (§3–4), three decisions
still cut across multiple plans and have no single owner:

### 8.1 Pattern matching: in the break, or after?

`pattern-matching.md` is the one major _addition_ in a release otherwise
made of deletions, and it touches nearly everything: the cost model
(arm-selection events must cover its dispatch — the plan's open question
about `handle` clauses generalizes to match arms), `strict-reads.md`
(absence-as-a-case at the access site and absence patterns in match arms
need one coherent story, since both dispatch on shape), P4's keep-`$match`
rationale (a full pattern language may subsume `$match`, reopening from the
other direction the question P4 closed), the checker conformance format,
and the normalizer/hashing pipeline (new canonical node shapes should
exist before identity consumers do).

The question is not whether it is good — the motivation (agent-written
workflows branching on discriminated-union-shaped foreign JSON) is the
project's core use case — but _when its canonical shapes freeze_. The
format-stability logic of §5 argues for deciding the canonical node shapes
inside the coordinated break even if full checker depth (exhaustiveness,
narrowing) lands afterward: shapes are what hashing and the normalizer
consume, and a second format break to add them later repays the
ossification tax with interest.

### 8.2 Release-train membership as one explicit decision

Cost + closures + laziness + strict-reads are committed to a single break.
Every other candidate (P4, P6's in-scope portion, P7, pattern-matching
shapes, the total-allocation budget) faces the same trade: riding along
grows and delays the break; deferring means a second break later, against a
larger conformance suite. That trade should be made once, explicitly, as a
release-manifest decision — not per-proposal by drift. The default posture
this review suggests: everything that changes _canonical shapes or the
trace_ rides the break (P4, P6-in-scope, pattern-matching shapes);
everything that only deletes normative text or adds host-side limits can
follow (P7, total-allocation).

### 8.3 The artifact-stability boundary

Several proposals each half-decide, locally, which artifacts may churn.
P6's caution is the sharpest statement: the environment contract is
operator-facing and the least churn-tolerant document. The policy should be
stated once, globally:

- **Canonical language and conformance suite** — fluid until the
  coordinated break ships; that is what the pre-consumer window is for.
- **Environment contract format** — treated as frozen-ish now; changes
  bundled consciously and rarely, because operators version against it
  independently.
- **Persisted continuation / workflow-record format** — never frozen,
  always _versioned_: explicit version field, stated compatibility policy
  (drain-before-upgrade is acceptable if stated), canonical JSON as the
  only durable format, compiled representations ephemeral by rule.

Writing this down converts several proposals' local hedges into one
navigable rule and gives §8.2's manifest decision its rubric.

---

## 9. Summary of leanings

| Question                  | Leaning                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost model                | Event-trace; strong determinism kept as byproduct; metering-profiles retained as demotion path, not alternative                                   |
| Builtin metering table    | Deliberately coarse forever; "fuel is not billing" written into normative text                                                                    |
| Laziness (P3 / Change 4)  | Strict, dependency-ordered (Change 4's variant, not P3's sequential one); lazy parameter defaults retained                                        |
| Closure capture (P1)      | Adopt; the auditability and small-kernel arguments are decisive and the break only gets costlier                                                  |
| Capture encoding (P2)     | Record **on the function value**, not `$let`+`$raw` in the body; keeps P2's mechanism-generalization and printing wins, avoids the fuel exception |
| Sequencing                | Cost model → closure format → one coordinated break with strict-reads                                                                             |
| Kernel cleanup (P4/P5/P7) | Remove `$if` (ride the break); keep `$and`/`$or` (close P5 as won't-do); run P7's audit after the closure format lands                            |
| Parameter desugaring (P6) | `$fields` yes; defaults blocked on the Change 4 collision (loose-end #9); signature-shape changes gated on the contract boundary (§8.3)           |
| Pattern matching          | Decide canonical node shapes inside the break; checker depth may follow (§8.1)                                                                    |
| Release membership        | One explicit manifest decision: shape/trace changes ride the break, text deletions and host limits may follow (§8.2)                              |
| Artifact stability        | State the three-tier boundary once: language fluid, contract frozen-ish, record format versioned-not-frozen (§8.3)                                |
| Urgency                   | High: portable conformance cases are actively pinning the semantics all of the above would change                                                 |
