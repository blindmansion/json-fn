# Structural pattern matching

Status: **proposal.** Written during the ground-up spec revisit. The TypeScript
implementation is cited throughout as evidence — measurements of where the
current design already carries the needed machinery and where it forces
complexity — but that implementation is ephemeral; nothing here is scoped to
preserving its code. Where this proposal touches areas under active
reconsideration (`later/simplification-proposals.md` Proposals 3, 4, 6;
`strict-reads.md`), it states the interaction and assumes the coherent-whole
resolution rather than the currently-shipped composition.

---

## Motivation

json-fn's target program is an agent-written durable workflow: a long-lived
process that consumes heterogeneous JSON — task completions, API responses,
tool results, approval decisions — and branches on shape. That data is
discriminated unions all the way down (`{status: "approved"} |
{status: "rejected", reason}`, tagged event envelopes, `{ok, ...}` result
wrappers), and much of it arrives from systems the author does not control,
where the discriminant is structural rather than a clean tag.

Today the language expresses this dispatch through three partial,
independently-specified pattern languages:

1. **Scalar `$match`** — equality dispatch on a scalar subject, with real
   checker value (finite universe, dead-case and exhaustiveness lints,
   discriminant narrowing through `match base.tag`).
2. **`$fields` object-pattern parameters** — flat destructuring of one object
   argument, with its own descriptor grammar, optional/default machinery, and
   an explicit prohibition on renaming and nesting.
3. **Flow narrowing** — facts on static access paths (bare variables and
   literal-string field chains), with numeric indices, computed keys, and
   non-variable roots excluded by design.

Each covers a slice; none composes into the others. The median workflow arm —
"if the response is `{ok: false, error: {code: 404}}` do X" — requires either a
`cond` of predicates the narrower only partially follows, or projections the
narrower cannot follow at all (array indices are not narrowing subjects). The
authors are language models, which systematically generate the happy path and
omit the unsalient failure arm; in an approval workflow the unhandled arm is
precisely the catastrophic one. Exhaustiveness checking at generation time —
already implemented for the scalar fragment — is the single highest-leverage
static guarantee for this population of authors, and it currently stops at
scalars.

This proposal replaces the three partial languages with one **pattern
dialect**, used in `$match` arms and (as a later, separable step) in parameter
position.

## The design principle: patterns are schemas with binding sites

The load-bearing observation is that json-fn already contains a structural
pattern language: the type-syntax schema dialect. `const` leaves, closed
objects with `required`, tuples via `prefixItems` + rest, unions — that _is_
the test half of a pattern. And `$as` already specifies a runtime structural
matcher (validate a value against a schema).

So the dialect is defined by one erasure rule:

> A **pattern** is a JSON term that erases to a schema in the existing
> dialect by replacing each binding site with `true` (or with its declared
> type, for typed binders). A value **matches** a pattern iff it validates
> against the erased schema. Binding projects sub-values at binder positions
> of the (already validated) subject.

This gives one semantics with three consumers:

- the **evaluator** matches by the same validation semantics as `$as`;
- the **checker** computes arm narrowing as `subject ∩ erased-schema` and
  reasons about dead arms and exhaustiveness via the existing subsumption
  machinery;
- **binder types** are projections of the arm-narrowed subject.

No new semantic universe is introduced; the pattern dialect is a quoted
fragment of the schema dialect plus names. This is the same move the spec
review's framing note calls mechanism-over-policy: `$fields`, discriminant
narrowing, and scalar match are policy constructs; schema-validation-plus-
projection is the mechanism underneath all three.

## Canonical form

`$cases` entries become `[pattern, result]` pairs. A pattern is **static
syntax**, not an evaluated expression (see "Dynamic case values" below for the
compatibility note). Pattern grammar, canonical JSON:

- **Literal pattern** — a scalar JSON value (`null`, boolean, number, string).
  Matches by strict equality. Identical in meaning to today's scalar cases:
  every existing `$match` program is a valid program under this proposal.
- **Binder** — `{"$bind": "name"}`. Matches any value; binds it. Erases to
  `true`.
- **Typed binder** — `{"$bind": "name", "$type": <schema>}`. Matches iff the
  value validates against the schema; binds it. Erases to its schema.
- **Wildcard** — `{"$bind": null}`. Matches anything, binds nothing.
- **Object pattern** — a plain JSON object whose values are sub-patterns.
  **Open**: mentioned fields must be present own properties matching their
  sub-patterns; extra keys are ignored. (This follows the `$fields`
  precedent — "extra object keys are ignored" — and deliberately diverges
  from the type syntax's closed-by-default objects; the asymmetry is named
  here so it is a decision, not an accident. Openness is what makes
  exhaustiveness over closed-_typed_ subjects behave: patterns test what the
  author cares about, the subject's type bounds what exists.)
- **Tuple pattern** — a JSON array of sub-patterns. Exact length unless the
  final element is a **rest binder** `{"$bindRest": "name"}` (or
  `{"$bindRest": null}`), which matches and collects the remainder,
  including an empty one. Erases to `prefixItems` (+ `items` for rest),
  mirroring the tuple type lowering.
- **Guard** — an arm-level `[pattern, guard, result]` triple (or a keyed
  variant; bikeshed at spec time). The guard is an ordinary boolean
  expression evaluated in the arm's scope (binders visible), with the arm
  taken only when the pattern matches and the guard is truthy.

Because object-pattern values are sub-patterns, **renaming is free**:
`{"from": {"$bind": "start"}}` binds `start` from field `from`. The `$fields`
rule "renamed, nested, and rest object patterns are invalid" stops being a
restriction to specify and enforce — those forms simply exist as compositions.

`$else` becomes **optional when the checker proves the arms exhaustive**, and
remains required otherwise. Note this resolves an existing spec/implementation
divergence in the proposal's favor: `expressions.md` says `$else` is required,
`eval/expression-type.ts` enforces it, but `check/checker.ts` already
implements exhaustiveness-based omission (`visitMatchArms` runs the §5.6
uncovered-cases lint only when `$else` is absent). The pressure for
else-elision has already leaked into the implementation once.

### Shorthand

Arms keep the existing colon-arm surface; the brace-matched arm parsing that
already distinguishes arm colons from nested object colons carries over.

```jfn
type Decision =
  | { status: "approved", approver: string }
  | { status: "rejected", approver: string, reason: string }
  | { status: "expired" }

describe: (d: Decision) -> string => match d {
  { status: "approved", approver }:         concat("approved by ", approver),
  { status: "rejected", approver, reason }: concat("rejected by ", approver, ": ", reason),
  { status: "expired" }:                    "expired"
}
```

No `else`: the three arms provably cover `Decision`. Untagged and nested
dispatch:

```jfn
match res {
  { ok: true, data: { user: { name, roles: ["admin", ..._] } } }:
    concat("admin ", name),
  { ok: true, data: { user: { name } } }:
    concat("user ", name),
  { ok: false, error: { code: 404 } }:
    "not found",
  { ok: false, error: { code, message } } if code >= 500:
    concat("server error: ", message),
  { ok: false }:
    "request failed"
}
```

Surface mapping: bare identifiers are binders, `_` is the wildcard,
`{ field }` is shorthand for `{ field: field }` (exactly the `$fields`
convention), `field: subpattern` renames or refines, `[..]` is a tuple
pattern, `..._` / `...name` the rest forms, `(name: Type)` a typed binder
(parenthesized to keep the annotation colon out of the object-pattern colon's
way; the parenthesized form deliberately echoes parameter annotations), and
`if` before the arm colon a guard. The one genuinely contested token is the
typed-binder syntax; `name is Type` (echoing the `isType` predicate family) is
the fallback if the parenthesized form proves too quiet in practice.

### Dynamic case values — a real semantic change, with an escape

Today `$cases` entries are _expressions_: `interpreter.ts` evaluates each
candidate at match time (line ~633 ff.), and the checker's `visitMatchArms`
already treats non-literal cases as second-class (its `litOf` bails, an
`allLiteral` flag disables the universe lints). Patterns must be static for
the checker to reason about them, so this proposal makes case position static
syntax and adds an explicit **pin** for the dynamic-equality case
(`^expr` in shorthand, `{"$pin": <expr>}` canonically): evaluate the
expression, compare by the language's structural equality. Without the pin, a
bare identifier in case position would silently change meaning from "compare
against this variable" to "bind a new variable" — the classic footgun the
pin/binder distinction exists to prevent (Elixir's `^` is the precedent).
Scalar literal cases are unchanged in meaning, so the break is confined to
programs whose case values are non-literal expressions — exactly the programs
the checker already cannot lint.

## Evaluation semantics

- The subject is evaluated once (unchanged).
- Arms are tested in source order; the first arm whose pattern matches (and
  whose guard, if present, is truthy) selects its result. Only that result is
  evaluated.
- Pattern testing is **left-to-right, depth-first, first-fail**, and this
  order is normative. Under the settled Phase 0 fuel decision (stable virtual
  cost, cross-implementation), matching cost is observable semantics: the
  spec must state the per-node charge and the traversal order, and
  `spec/cases/` gains fuel-pinned match cases alongside the existing
  exact-budget suites. This is priced, not incidental: the strong-fuel
  decision means _any_ new evaluation form carries this obligation.
- Binds are **eager projections** of the already-evaluated subject, installed
  when the arm is selected. There is nothing to defer — the subject exists —
  so pattern binds take no position in the Proposal 3 (lazy vs eager `$let`)
  question, and compose cleanly with either resolution. If Proposal 3 lands
  eager-sequential, the lowering target for binder installation is
  particularly simple.
- A guard is evaluated only after its arm's pattern matches, in the arm scope.
- Falling off the end of a `$match` with no `$else` is unreachable in checked
  programs (the checker proved exhaustiveness); in unchecked evaluation it is
  an error, mirroring `$cond` with no matching arm.

Patterns are plain JSON, so canonical encoding and hashing need nothing new;
the printer/normalizer obligation is the standard one
(`parse(print(node)) = normalize(node)`), and the pattern surface forms above
were chosen to round-trip through the existing arm rendering.

**Interaction with raw inference.** Pattern position is a third syntactic
category: not expression, not data. The raw-semantics cleanup's inference
(quoted `$`-prefixed keys bubble to a maximal `$raw` boundary) must not fire
inside case-pattern position — `$bind` there is pattern syntax, not data to
quote. The rule is the same shape as the existing "the surrounding form
distinguishes arm colons" disambiguation: the `$cases` pattern slot delimits
the pattern dialect, and raw inference treats it as opaque. This needs a row
in the raw-inference conformance matrix, not a redesign.

## Static semantics

Three sub-problems, in ascending difficulty. The current implementation is
evidence for how much of each already exists.

### Arm narrowing: intersection

Within an arm, the subject's type is `subject ∩ erased-pattern-schema`:
filter union arms against the pattern (a generalization of what discriminant
narrowing does today), split tuples on length, pin literals. The machinery is
substantially present: `check/narrowing.ts` (616 lines) exports the
literal-pin / arm-filtering operations, and `schema.ts` supplies
`classifySchema`, `projectField`, `prefixItems`, `unionOf`. Binder types are
projections under the arm-narrowed subject — `projectField` and the tuple
utilities again.

The significant _relief_ this buys: binders subsume the narrowing spec's
static-access-path restriction for match-shaped code. Today `res.data.user`
is a narrowing subject but `roles[0]` is not, and never can be under the
facts model — numeric indices were excluded because path-facts on them are
fragile. A binder does not narrow a path; it names a projection. Deep
dispatch that is _inexpressible_ under the facts model falls out of pattern
structure with no extension to the facts machinery at all. The narrowing
spec's Subjects section stops being the ceiling on dispatch precision.

### Later-arm and else narrowing: subtraction

Arm _i_ is checked knowing arms `0..i-1` failed; `$else` knows all arms
failed. This requires subtracting a pattern's match set from the subject —
and the schema dialect deliberately has no `not`, so exact subtraction is
impossible in general. The narrowing spec already states the principled
answer for exactly this situation: _"splits that aren't exactly expressible
widen back to the whole type rather than under-approximate."_ The
implementation's `excludeLiteral` (category-exact exclusions only, no-op
otherwise) is the existing precedent. This proposal extends that rule, not
the schema dialect: subtraction is exact for literal pins against finite
universes, for discriminant-arm removal against unions of closed objects, and
for tuple-length splits; everywhere else the later-arm context soundly keeps
the wider type. Dead-arm detection (arm _i_ subsumed by earlier arms) is a
best-effort lint on the same fragment, powered by `isSubschema`
(`check/subsumption.ts`, 358 lines — already written, the single biggest
head start in the codebase).

### Exhaustiveness: exact on a declared fragment

Classic usefulness algorithms assume constructor types; json-fn's subjects
are schemas, where full exhaustiveness is not decidable (regex `pattern`
complements alone kill it). The proposal is to make exhaustiveness **exact on
a normatively declared fragment** and demand `else`/wildcard outside it —
Rust's `_`-for-`non_exhaustive` posture:

- finite enums and literal unions (today's `caseUniverse`, generalized);
- discriminated unions of closed objects, discriminated by any
  literal-covered field, nested;
- tuple-length splits with rest;
- `null | T` splits.

Outside the fragment (open objects, `pattern`/`format`/refinement-bearing
subjects, `any`), the checker requires a catch-all and reports _why_ the
subject is outside the fragment. The current `visitMatchArms` (~59 lines, the
largest arm visitor per Proposal 4's measurement, with `caseUniverse` /
`matchCaseFact` / `matchElseFact` behind it) is the scalar instance of
exactly this design: universe when finite, lints on the universe, silence
otherwise. The proposal is that function generalized, not replaced.

## Unification with parameters (separable step)

`$fields` is an irrefutable flat object pattern with a bespoke grammar. Under
this proposal, parameter destructuring becomes the **irrefutable pattern**
use of the same dialect: a pattern in parameter position must be irrefutable
against the declared parameter type (binders, wildcards, object patterns of
irrefutable sub-patterns, tuple patterns with rest — no literals, no guards),
checked by the same subsumption question ("does the parameter type validate
against the erased schema for every inhabitant"). Nesting, renaming, and the
parking-lot array-pattern parameters (`future-authoring-improvements.md`)
fall out as compositions instead of feature requests.

This resolves Proposal 6's direction question rather than fighting it.
Proposal 6 wants the canonical calling convention shrunk (required
positionals + rest) with `$fields` desugared at parse time into body-top
bindings. Pattern parameters are the natural desugaring _target_: a
destructuring parameter lowers to a plain positional parameter plus an
irrefutable pattern-bind at the top of the body — one kernel construct
(pattern bind) serving both match arms and parameters, with the printer
folding the parameter shape back, exactly the `do` precedent Proposal 6
cites. The measured weight of the current composition — `params.ts` ~460
lines, multiplying into capture shadowing and signature matching — is the
complexity a unified dialect deletes. Per Proposal 6's own caution, the
`$sig`/environment-contract surface is untouched: patterns are a language-
side representation; the contract continues to describe object types.

Whether `$let`-position destructuring (`let {a, b} = expr`) joins in the same
pass is left open; it is the same irrefutable-pattern construct and adds no
new semantics, only surface and printer work.

## Interaction with strict-reads (absent vs null)

Object patterns must answer the question `strict-reads.md` owns. Aligned
positions:

- A field sub-pattern requires the field to be a **present own property**;
  a `null` literal sub-pattern matches present-`null` only. Absence is never
  silently conflated with `null` inside a pattern — the same distinction the
  `$get`/`$else` redesign draws at access sites.
- An optional-field form (`field?: pat` in shorthand, an `$optional` marker
  canonically) matches whether or not the field is present, binds `null` on
  absence — mirroring `$fields` optional fields, and typed by the same
  optional-property rules the narrowing audit in strict-reads covers.
- An explicit _absence pattern_ ("matches only when the field is missing")
  is deferred; if workflow experience demands it, it is a small additive
  marker, and its exhaustiveness contribution is well-defined (present/absent
  is a two-arm split on optional properties of closed objects).

## Scope: what v1 refuses

The value is concentrated in exhaustive tagged dispatch plus binding; the
spec cost is concentrated in the exotic tail. v1 excludes, deliberately:

- **Or-patterns** (`p1 | p2`) — binder-consistency across alternatives
  (same names, unioned types) is real specification work for marginal
  workflow value.
- **Regex / `format` / refinement leaves** — they destroy subtraction and
  smuggle validation cost into dispatch. A typed binder may carry a `$ref`
  or refinement type, with the stated rule that such a binder contributes
  nothing to exhaustiveness (it is `true` for coverage purposes on the
  refined portion).
- **Closed object patterns** — no "and nothing else" marker in v1; the
  subject's type already bounds the keys in checked code.
- **Pattern-level defaults** — `= expr` stays a parameter-position affordance;
  match arms have guards and later arms instead.

Each exclusion is additive later; none blocks the fragment above.

## Costs, honestly

- **Spec surface.** A pattern grammar, its erasure, normative match order and
  fuel, printer/normalizer rules, raw-inference exclusion, and new
  conformance suites (parse, eval, fuel, check). Against a trimming-phase
  budget this is the proposal's real price. The mitigation is what it
  deletes or forestalls: the `$fields` descriptor grammar and its
  prohibitions, the parking-lot array-pattern feature, future pressure for
  more narrowing subject forms, and a third partial pattern language that
  would otherwise keep growing.
- **Checker work.** Intersection is moderate (existing utilities);
  bounded subtraction and fragment exhaustiveness are the genuinely new
  algorithmic content — plausibly on the order of `narrowing.ts` again
  (~600 lines) in a conforming implementation, concentrated in the _one_
  canonical implementation per Proposal 4's observation that secondary
  implementations carry only the evaluator. The evaluator itself is a small
  structural walk sharing its definition with `$as` validation.
- **A format-visible change** to `$cases` (patterns, pin escape, optional
  `$else`). Existing scalar programs are unaffected in meaning; programs
  with computed case values must adopt `^`. Per Proposal 9's logic this
  lands inside the pre-consumer window or not cheaply at all — every
  portable spec case pinning scalar-match behavior raises the price, the
  same clock Proposal 3's update describes.
- **Two named asymmetries** carried on purpose: pattern objects are open
  while type objects are closed; pattern position is exempt from raw
  inference. Both are stated rules with precedents (`$fields`; arm-colon
  disambiguation), not emergent behavior.

## Sequencing

1. Decide the **v1 fragment boundary** (the exhaustiveness-exact set and the
   leaf exclusions) first — it is the load-bearing scope decision, and it
   determines the conformance surface under strong fuel.
2. Land the **pattern dialect + `$match` generalization** as one unit:
   grammar, erasure, evaluation order and fuel, intersection narrowing,
   fragment exhaustiveness, pin escape, `$else` elision. Resolve the
   `$else` spec/impl divergence in the same stroke.
3. Take **parameter unification** as a second, separable unit, co-designed
   with Proposal 6's desugaring direction (and Proposal 3 if eager-let has
   landed, since it fixes the lowering target).
4. Fold the **absent/optional-field pattern rules** into the strict-reads
   plan's narrowing audit rather than running them here.

The unifying observation from the simplification review applies with unusual
force: values are syntax and fuel makes evaluation observable, so this is
semver-visible in every dimension — which is exactly why the ground-up
revisit is the cheap moment. The counter-observation is equally true: three
partial pattern languages already exist and already interact; the choice is
not whether json-fn has pattern matching, but whether it has one or several.
