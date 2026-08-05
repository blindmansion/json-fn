# json-fn: Spec Simplification Proposals

Proposals for changing the language design and specification, compiled from a design review of the canonical spec (`docs/`) with the TypeScript implementation used as evidence. These are proposals against the _language_, not the TS codebase; where line counts or code structure are cited, they serve as measurements of the complexity a given spec decision forces onto every conforming implementation.

Ordering is roughly by leverage. Proposals 1–3 form a connected arc and are best evaluated together; the rest are independent.

> **Post-review reconciliation (2026-08-04).** This review was performed against the pushed state of the repository and did not see the local commits that landed the implementation roadmap's Phase 0 (settled invariants and four design decisions), Phase 1 (representation integrity: own-property construction everywhere, fixed structural limits of depth 512 / evaluation nesting 4,096), and Phase 2 (the full raw-semantics cleanup: runtime-value marking split from `$raw`, the `raw` keyword removed in favor of inferred `$raw`, full static-literal `$raw` fuel, centralized validated task/workflow rehydration, and formalized printer normalization). The **Post-review update** notes below reconcile each proposal against that work; proposals without a note (4 and 5) are unaffected. Headlines: Proposal 8's central question is now settled (strong, cross-implementation fuel); Proposal 2's precondition 2 is largely done but its precondition 1 rests on a superseded fuel claim that opens a real design question; Proposal 1's serialization-soundness evidence is stale while its persisted-size claim is now directly measurable.

A framing note that motivates several proposals: json-fn is a guest language, and the most battle-tested guest language in existence is Lua. Its thirty years of host-boundary scar tissue validates json-fn's core bets (capability-by-contract rather than retrofitted sandboxing; continuations as serializable data rather than live stacks) and supplies its cautionary tales (the LuaJIT fork as what happens to secondary implementations without a small kernel; unstable bytecode and cavalier versioning as what breaks persisted artifacts). Those lessons appear throughout.

---

## Proposal 1 — Replace substitution closures with environment-record capture

**Status quo.** When a function body escapes as a value, capture is by substitution: the interpreter walks the returned body and splices captured values directly into expression position (`language.md` § Closures specifies the substituted output as the observable value). Escaping local functions are handled by a separate attach mode that serializes closed-over definitions under `$captures`.

**Proposed change.** A function value never has its body rewritten. Escape computes the body's free variables and attaches their evaluated values as a data record alongside the unmodified body. Lookup consults the record before enclosing scope. (Proposal 2 refines the record's representation.)

**Why.**

_Complexity._ Substitution forces a second, parallel implementation of the entire scoping ruleset inside the substituter — shadowing by `$params`, `$captures`, and nested `$let` must exactly mirror interpreter lookup. In the TS implementation this is `eval/closures.ts` (~440 lines), a classic two-implementations-of-one-semantics bug surface that every conforming implementation must replicate. It also necessitates the raw-marking system: substituted data sits in expression position, so a host object whose keys look like `$call` would be executed unless branded inert. The capture model deletes the substituter (reduced to free-variable computation) and dissolves the code/data confusion class rather than defending against it — captured data lives in a position that is data by definition.

_Auditability._ Substitution rewrites bodies, so an escaping closure no longer hashes or diffs against the authored program — undercutting the project's core "hashable, diffable, auditable artifact" claim precisely for the values that matter most (suspended continuations). Under capture, a pending record has a clean seam: the body is byte-identical to deployed source (verifiable), and the captured record is a plain state snapshot (readable).

_Persisted size._ Substitution splices a captured value at every reference site; in memory those are shared pointers, but serialized to a workflow store they are duplicated copies. A capture record stores each value once.

_Serialization soundness._ The TS implementation's inertness marks are identity-based (`WeakSet` in `utils.ts`) and cannot survive JSON round-trip; whether marks are correctly re-derived on durable resume is at minimum an open question. The capture model has nothing to re-derive.

**Suspension is preserved.** The suspended form's contract (`language.md` § The suspended form) requires `resume` to be a _self-contained_ closure — closed JSON with no references to live host memory. Substitution achieves closedness by inlining; capture achieves it by attachment. Both yield plain JSON that persists, ships, prints, and applies multi-shot (safe because the language has no mutation, so sharing one record across applications is sound). The `{done}` / `{pending}` envelope is unchanged; only the function value's internal shape changes. The enabling design was never substitution — it was reifying the continuation as data (tasks as an inert `bind` spine). This is exactly the property Lua coroutines lack (live C stack + heap pointers), and it survives the representation change untouched.

**Cost.** Function values are spec'd _format_, not just behavior — the spec shows the exact substituted output — so this is a breaking change to the function-value format, and stored workflow records from before the change cannot resume. That is the argument for deciding now, pre-consumers, before any workflow store holds continuations there is an obligation to resume. Residual caveat, unchanged in both models: closures resolve module and stdlib functions by name at the target host, so they are never fully self-contained; this is the version-skew exposure addressed in Proposal 9.

**Post-review update (2026-08-04).** Substitution remains the spec'd model (`language.md` § Closures is unchanged), but the evidence has shifted in both directions. The _serialization soundness_ bullet is stale: marks now live in `runtime-values.ts` (still identity-based), rehydration is one centralized, validated pass (`restoreRuntimeMarks` in `host/task-serialization.ts`, with shape validation at both persist and hydration time; `test/task-rehydration.test.ts`), and the settled stable-virtual-cost fuel decision guarantees mark loss can never change fuel, results, or errors — the "open question" is answered, leaving a complexity argument rather than a soundness gap. The _persisted size_ bullet is now measurable rather than asserted: the durable instrumentation (`bun run instrument:durable`) reports repeated-subtree / closure-substitution expansion directly. The _cost_ paragraph gains a landing spot: the settled identity decision (artifact hash + normalized hash in separate versioned domains) and roadmap Phase 4A are where the format break would be versioned, per Proposal 9. One honest cost increase: Phase 2 hardened, tested, and perf-baselined the substitution/marking machinery this proposal deletes, and exact-fuel spec cases now pin behavior in the affected area, so the break discards more landed work than at review time (though still pre-consumer).

---

## Proposal 2 — Collapse `$captures` into `$let` + `$raw`

**Status quo.** `$captures` is a dedicated sibling field on function bodies carrying closed-over local function definitions, with its own shadowing tier (params > captures > enclosing), its own printer handling, and its own spec section.

**Proposed change.** Represent capture (as generalized by Proposal 1) as an ordinary `$let` wrapping the body, with each captured value wrapped in `$raw`:

```json
{
  "$params": ["__v"],
  "$return": {
    "$let": { "st": { "$raw": {} }, "cfg": { "$raw": {} } },
    "$in": "<authored body, unmodified>"
  }
}
```

Escape is then: compute free variables, wrap their values in `$raw`, bind them in one `$let` around the body. `$captures` is removed from the language.

**Why.** The genuine invariant separating a capture from a let binding is _evaluated-ness_: a `$let` binding is unevaluated program (checked, fueled, sibling-referencing), while a capture is an already-evaluated inert result. That distinction cannot be collapsed away — but the language already reifies it as a canonical form: `$raw`. Composing the two existing mechanisms yields the missing construct exactly, and makes the serialization contract honest in a way identity-based marks never were: `$raw` is JSON, so inertness survives persistence by construction.

Consequences: function values collapse to a single shape (`$params`/`$return`, no sibling field), simplifying the checker, printer, structural equality, and the suspended-form spec. Lookup loses a tier. The escaping-local-function attach machinery mostly dissolves, because `$let` already grants function-valued bindings callability-by-name and mutual recursion — recursive escape becomes plain nested-let scoping. Escape is naturally idempotent (a second escape finds no free variables; they are raw literals). The printer needs no captures-specific folding: a suspended `resume` prints via `$let`'s existing surface form, e.g. `(__v) => body where st: {...}, cfg: {...}` — the workflow state snapshot rendered as a `where` clause, a genuinely good audit artifact. Name collisions are impossible by construction: free variables of the body exclude its own `$params`, so the wrapping `$let` can never shadow a parameter, and existing inner-binder-wins rules cover nesting.

**Preconditions to check.**

1. _Coupling to `$let` semantics._ Collapsed captures inherit lazy/memoized/recursive machinery they do not need, and deterministic fuel makes that observable: applying a closure now pays let-frame costs, which the spec must pin down. This welds Proposal 2 to Proposal 3 — under eager `$let` the collapse is cleaner, and forcing a `$raw` is the already-specified cost-1 case.
2. _`$raw` promotion._ `$raw` becomes the load-bearing code/data boundary for every persisted continuation. Its spec currently reads as an authoring convenience and must become airtight: nesting behavior (raw inside raw), payloads containing `$`-shaped keys at depth, interaction with fuel's raw rules.

In the Lua frame: `$captures` is policy — a dedicated construct for one use case. `$let` + `$raw` is the mechanism pair underneath it; once the mechanism is sound, the policy construct is just a shape the escape procedure emits.

**Post-review update (2026-08-04).** Precondition 2 is largely done by the raw-semantics cleanup: `$raw` inference is spec'd with a conformance matrix (`spec/cases/parse/raw-inference.json`); quoted `$`-prefixed keys at depth bubble to one maximal boundary (rejected with positioned errors in dynamic contexts); redundant wrappers normalize away; `$comment` interaction is fuel-pinned; and `rawCost(payload) = staticLiteralCost(payload)` is normative. But precondition 1's claim that "forcing a `$raw` is the already-specified cost-1 case" is **superseded**: `$raw` now deliberately charges the full static-literal cost of its payload so that quotation cannot reduce deterministic fuel; cost-1 applies only to _runtime-value re-entry_ (the in-memory identity-marked category, restored on hydration). That opens a real fuel question for this proposal: today an escaped capture is a substituted runtime value costing 1 on re-entry, while captures represented as `$raw` syntax would charge fuel proportional to captured-state size each time the binding is forced. Either the spec accepts state-size-proportional closure-application cost, or capture needs an exception — which collides with the just-settled "quotation is not a fuel escape hatch" invariant. Two smaller notes: the `raw` keyword no longer exists (`$raw` payloads print as quoted strict JSON; the `where st: {...}` rendering above still works), and escape-emitted shapes must be stable under the now-formalized normalizer (`parse(print(node)) = normalize(node)`, `shorthand/normalize.ts`), since normalized program identity feeds module hashing in roadmap Phase 3.

---

## Proposal 3 — Make `$let` eager and sequential; reserve recursion for function-valued bindings

**Status quo.** `$let` bindings are lazy, memoized after first use, order-independent, and mutually recursive, with dynamic cycle detection (`language.md` § Let Binding — normative text). Parameter defaults are also lazy. Do-notation pure bindings inherit these semantics.

**Proposed change.** Bindings evaluate eagerly in source order. Forward reference is permitted only to function-valued bindings (which the spec already special-cases for callability), preserving recursive and mutually recursive local functions. Cycle detection becomes a static check. Parameter defaults evaluate eagerly at bind time.

**Why.** Laziness reads as a local feature but is a whole-language commitment with observable consequences everywhere: thunk frames and dynamic cycle detection in every evaluator; demand-dependent fuel (deterministic, but a function of which bindings get forced — cost-model spec surface); a checker reachability analysis that exists largely to mirror runtime laziness; and do-notation's pure-binding semantics. This is the precedent of nearly every strict language (Scheme `letrec*`, OCaml's function-restricted `let rec`).

The honest counterargument is agent authorship: order-independence means generated code need not be topologically sorted. But a canonicalizer can sort mechanically, and since the checker already rejects unused bindings, "unused is never evaluated" buys little in checked code. If order-independence is retained as a _source_ affordance, it can be a canonicalization step rather than an evaluation semantics.

**Interaction.** Makes Proposal 2 cleaner (capture frames stop inheriting lazy machinery) and shrinks the fuel spec (Proposal 8's concern) by removing demand-dependence.

**Post-review update (2026-08-04).** Still undecided, and the settled fuel decision does not force it — demand-dependent fuel is still a pure function of the program and its inputs, so laziness remains compatible with stable virtual cost. But lazy-binding and lazy-default behaviors have since been moved into portable `spec/cases/`, so laziness is now pinned conformance surface: the pre-consumer window this document identifies as the cheap time to decide is being spent.

---

## Proposal 4 — Remove `$if`; make single-arm `$cond` the canonical conditional

**Status quo.** Three branching forms: `$if`/`$then`/`$else`, `$cond` (+ optional `$else`), `$match`/`$cases`/`$else`.

**Proposed change.** Remove `$if` from the canonical language. Shorthand `if c then a else b` parses to a one-arm `$cond` with `$else`; the printer folds that shape back to `if`.

**Why.** `$if` is pure redundancy: a one-arm `$cond` has identical evaluation _and_ identical narrowing — the checker's `visitCondArms` accumulates negated guards into `$else`, which for a single arm is exactly `visitIfArms` (TS: `check/checker.ts`). `$cond` is the better survivor: flatter JSON, shallower diffs, less nesting for generated code. Costs are small everywhere (`$if` is ~8 interpreter lines, ~10 checker lines, ~13 parser lines in TS) — this proposal is about kernel surface area per conforming implementation, not code volume.

**Non-proposal, recorded deliberately: keep `$match` canonical.** At runtime `$match` is an `eq`-chain with the subject evaluated once, but its checker value is real and _shape-dependent_: the finite case universe, exhaustiveness and dead-case lints, and discriminated-union narrowing through `match base.tag` (~59 lines of `visitMatchArms`, the largest of the three) all rely on recognizing the syntactic form. Desugaring to `$let` + `$cond` would force a synthetic binding name into the hashable artifact, and would relocate — not delete — the recognition logic into the printer _and_ the checker. Roughly cost-neutral in code, strictly worse for the artifact. The multi-implementation risk argument does not apply: secondary implementations carry only the evaluator (~13 lines), while the expensive checker and parser exist once, in the canonical implementation.

---

## Proposal 5 — Reconsider `$and` / `$or` as canonical forms

**Status quo.** Variadic short-circuit `$and` and `$or` are expression forms, distinct from the eager stdlib `and`/`or` functions.

**Proposed change (tentative).** Define them as canonicalization into `$let` + `$cond` (short-circuiting falls out of conditional evaluation), or at minimum evaluate the trade before the kernel is frozen.

**Why.** Same kernel-minimization logic as Proposal 4, with lower semantic value than `$match`: no exhaustiveness analysis, and their narrowing contribution (`factsFromCondition` handles `$and`/`$or` sense-tracking) survives desugaring since it operates on conditions generally. The known tax is the same gensym problem as desugaring `$match` — value-position operands need a synthetic binding to avoid double evaluation — so this is flagged as worth a deliberate decision rather than a clear win. If the gensym tax is judged acceptable nowhere, keeping `$and`/`$or` and `$match` together is the consistent position; keeping `$match` while desugaring `$and`/`$or` is defensible because only `$match` carries shape-dependent checking.

---

## Proposal 6 — Desugar parameter richness at parse time

**Status quo.** The calling convention spans required positionals, optionals with lazy defaults, rest parameters, and `$fields` object patterns with per-field defaults. In TS this is `params.ts` (~460 lines), and each axis multiplies into closure capture shadowing, signature matching (`parameterShapeMatches`), and the shorthand.

**Proposed change.** Canonical calling convention: required positionals + rest. `$fields` patterns and defaults become parse-time desugarings into a `$let` at the top of the body (the printer folds them back), following the `do` precedent — which demonstrates the pattern already works in this language: `do` is parser-only sugar lowering to a `bind` spine + `$let` nodes, with the printer folding the exact shapes back.

**Why.** Each parameter axis is spec surface every implementation must match, and the axes interact (defaults × laziness × capture shadowing). Desugaring collapses the evaluator's calling convention while preserving the authoring surface.

**Caution.** Arity richness leaks into the _signature_ shape (`required`/`optional`/`rest`) used by `$sig`, the builtin table, and — critically — the environment contract, an operator-facing, independently versioned artifact. Desugaring `$fields` touches only the language (the signature describes the object type); collapsing optional-with-default parameters would touch the contract format, which is the document least tolerant of churn once operators exist. Scope this proposal to what leaves the contract format untouched, or bundle the contract change explicitly and consciously.

**Post-review update (2026-08-04).** Unaffected in substance. Note only that lazy parameter-default behavior is now pinned in portable spec cases (see Proposal 3's update), so the desugaring must reproduce it exactly or bundle with Proposal 3's change.

---

## Proposal 7 — Eliminate name-resolution asymmetries and dual function representations

**Status quo.** Callees may be names or bodies; `$fn` yields either; resolution spans registry, local bindings, captures, and contract functions; and rules exist like "a function-valued `$let` binding shadows a same-named registry function _in call position_, but a non-function binding does not hide a callable registry entry" — dispatch depending on the runtime type of a binding.

**Proposed change.** Audit these rules with a bias toward a single function-value representation and uniform, type-independent name resolution. Proposals 1–2 remove one driver (by-name recursion in escaping closures currently forces the captures machinery); the remainder should be simplified or deleted as normative text.

**Why.** Each asymmetry is small, but this is exactly the category of surface that drifts secondary implementations out of spec — the current state of the Go/Python/Rust ports is the evidence, and the LuaJIT freeze at Lua 5.1 is the end state of that dynamic. Unlike checker-heavy features, resolution rules must be replicated _in every evaluator_. This proposal is mostly deletion of normative sentences.

**Post-review update (2026-08-04).** One asymmetry class was removed incidentally by the own-property work: registry and property lookups no longer observe inherited `Object.prototype` members (guest calls to `toString` used to resolve to inherited host functions, and required-key validation for names like `constructor` passed vacuously). The by-name shadowing rules this proposal targets are untouched.

---

## Proposal 8 — Decide the scope of fuel determinism explicitly

**Status quo.** Fuel is deterministic and spec'd in detail (`docs/runtime/execution-limits.md`), including rules that exist only to keep optimizations observationally deterministic — e.g., a cached constant subtree "charges the same complete node count measured by its first evaluation." The unstated question: deterministic _across implementations_, or per-deployment?

**Proposed change.** State the answer in the spec. Two coherent positions:

- **Strong (cross-implementation):** a workflow suspended under one interpreter resumes under another with the same remaining budget. Then every builtin's metering and every cache policy is permanent spec surface for all implementations — effectively the entire evaluator becomes conformance-testable cost model. Choose this only deliberately, with fuel cases in `spec/cases/` treated as normative.
- **Weak (per-host):** determinism holds within a deployment; fuel becomes mostly implementation territory, and the conformance burden on secondary implementations drops by a large factor.

**Why.** Deterministic fuel promotes the cost model into observable semantics — evaluation strategy, caching, even laziness (Proposal 3) become spec-visible through fuel. The portable-artifact framing of contracts and profiles implicitly leans toward the strong version without having priced it. This is a decision to make on purpose, not inherit.

**Related (from Lua's experience):** Lua's instruction-count debug hooks were never deterministic across versions and made poor limits; deterministic spec-level fuel is the right correction. But what actually bounded hostile guests in Lua embeddings was the host-supplied allocator (`lua_Alloc`) — _total_ heap accounting. json-fn's `maxValueSize` is per-produced-value and fuel bounds work, not retention: a guest holding many medium values in live scope has unbounded resident memory under both limits. Add a total-allocation budget to the execution-limits model alongside the per-value bound.

**Post-review update (2026-08-04).** The central question is **settled**, in the strong direction, and in the deliberate way this proposal asked for. Roadmap Phase 0's fuel decision: fuel is a _stable virtual cost_ — a pure function of the program, its inputs, and recorded effect results — independent of caches, serialization, and ingestion route; caches and metadata loss may change host preparation time only, never fuel, results, or errors. `docs/runtime/execution-limits.md` was rewritten to state it, and fuel cases are now normative conformance (`spec/cases/fuel-limits.json`, plus exact-budget cases for constant caching, runtime-value re-entry, and `$comment`). The status-quo quotation above is superseded by the new wording: a discovered or preseeded constant subtree charges its full recorded node count on every invocation. What remains live from this proposal is the addendum: a total-allocation budget. The new fixed structural limits (structural depth 512, evaluation nesting 4,096) bound tree shape, not total retention, so that gap stands.

---

## Proposal 9 — Version the continuation / workflow-record format as strictly as the contract

**Status quo.** The environment contract carries `version: 1`. The durable workflow record — the persisted continuation a future interpreter must resume — has no comparably explicit versioning-and-migration story, while module identity is delegated to an opaque host-chosen tag.

**Proposed change.** Give the persisted continuation format an explicit version, a stated compatibility policy, and a migration posture (even if v1's policy is "no cross-version resume; drain before upgrade" — stated is the point). Treat any compiled/cached internal representation the way Lua treats bytecode: an ephemeral, never-interchanged cache, with canonical JSON as the only durable format.

**Why.** Durable workflows make version skew existential: continuations persisted today must be readable by tomorrow's interpreter, and closures additionally resolve module/stdlib functions by name at the resuming host (they are never fully self-contained — see Proposal 1's caveat). Lua is the cautionary tale on both axes: bytecode explicitly non-stable, compatibility broken between minor versions, ecosystem forked as a result. If Proposal 1 is adopted, its format break should land as the first versioned transition.

**Post-review update (2026-08-04).** The status quo is now stale at the plan level: roadmap Phase 4A (owner: `plans/content-addressing/module-identity-pinning.md`) specifies versioned component identities, an aggregate executable-world identity, persisted original identity on every workflow variant, compatibility handling for old records, and non-mutating drift rejection by default — with migration/routing hooks explicitly excluded, which is effectively the "stated, even if drain-before-upgrade" posture this proposal asks for. Workflow-record hydration is also now a single validated path (`WorkflowRecordValidationError`), the natural enforcement point for a record-format version field. Not yet implemented (blocked on Phase 3 hashing). Remaining ask: confirm Phase 4A versions the continuation _format_ itself, not only the executable world resuming it.

---

## Proposal 10 — Distinguish absent from null in `$get` (flagged, not urgent)

**Status quo.** `$get` returns `null` for a missing object key and for an out-of-bounds index, conflating _absent_ with _present-and-null_.

**Proposed change (to evaluate).** Options include: a distinct canonical form or stdlib function for "has key"; making missing-key access an error with an explicit defaulting form; or accepting the conflation but auditing the narrowing rules around optional properties for soundness against it.

**Why.** Lua's `nil`-means-absent is the field's best-documented version of this trap (array holes, ambiguous `#`, a generation of workarounds). Closed schemas (`additionalProperties: false`) mitigate the risk substantially, which is why this is flagged rather than urged — but the checker's optional-property narrowing is where it would eventually bite, and the cost of the decision only rises after consumers exist.

**Post-review update (2026-08-04).** This already has an owning plan: roadmap Phase 5, `plans/strict-reads.md`, whose gates include "every runtime absence behavior is derivable from canonical syntax" and explicit, ergonomic nullable/defaulting absence. This proposal should merge into that plan rather than run on its own track. The adjacent soundness hole (required-key validation for names like `constructor` passing vacuously) was already fixed by the own-property work.

**Merged (2026-08-04, later).** `strict-reads.md` was revised to own this fully, and resolved it by redesigning the canonical node rather than adding builtins: the `$get` key domain narrows to a single string or integer (the array-path form is removed; static paths lower to nested `$get`s, eliminating the evaluator's dispatch-on-key-shape — a Proposal 7-class asymmetry), and an optional lazy `$else` arm carries the absence policy at the access site (`?? null` subsumes the once-proposed `lookup` builtin). The sibling-arm choice deliberately accepts the same gensym-avoidance trade this document weighs for Proposal 5. Bare-miss becomes an immediate error; `$else` fires on absence only, never on present `null`, preserving the distinction this proposal asked for.

---

## Suggested sequencing

1. **Decide Proposal 8's question first** — it determines how much of everything else is spec surface.
2. **Proposals 1 + 2 + 3 as one design unit** (function-value format, capture representation, let semantics interlock; one format break, versioned per Proposal 9).
3. **Proposals 4–7** as kernel-surface cleanup, cheap while pre-consumer.
4. **Proposal 10** on its own track; audit narrowing soundness now, decide the language change later.

**Post-review update (2026-08-04).** Step 1 is done: Proposal 8's question was settled (strong / cross-implementation) by the Phase 0 fuel decision. The 1+2+3 design unit is now the live decision, and it should be evaluated against the settled fuel model — in particular the capture-cost question raised in Proposal 2's update — sooner rather than later, because each new portable spec case pinning lazy or substitution behavior raises the price of the format break. Proposal 10 no longer needs its own track; it folds into `plans/strict-reads.md` (roadmap Phase 5).

The unifying observation: in json-fn, "just an implementation detail" barely exists, because _values are syntax_ (function values are inspectable, serializable JSON — representation is behavior) and _deterministic fuel makes evaluation strategy observable_. Nearly every choice above is semver-visible, which is precisely why the pre-consumer window is the cheap time to make them.
