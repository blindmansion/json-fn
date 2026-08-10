# Plan: boolean conditions (Stage 2 chunk 2e)

Status: **chunk plan**, 2026-08-09 — plans the spec text; nothing below has
landed in `spec-v2/docs/` yet. Owns [`plan.md`](plan.md) Stage 2 chunk 2e.
The decision itself is settled — **D4** in [`status.md`](status.md), resolved
2026-08-08 with [`type-eval-coherence.md`](type-eval-coherence.md)'s
adoption: truthiness is deleted rather than kept-and-named. This document
restates the change in the vocabulary Stages 1/2a/2b established, pins the
rules that must be fixed while writing (each with a recommendation, so the
chunk is not blocked), and maps the rewrite surface onto `spec-v2/docs/`.
2e is independent of 2a–2d and must precede 2f; it is written after 2b so
the migration text *states* the replacement defaulting forms rather than
anticipating them.

## The adopted change, restated precisely

**Condition positions are runtime boolean positions.** The evaluated
condition of an `$if` and of each `$cond` arm must be `true` or `false`; any
other value is an immediate evaluation error. Evaluator-enforced and
fail-closed: condition position is a **declared runtime position whose
semantics is validation against the boolean schema** — the `$as` posture,
not a checker-only rule. In a checked program the error is near-unreachable
(the checker requires the condition's type to be boolean, rule 4); the
runtime rule is what makes the semantics derivable from canonical syntax
alone.

**`$and`/`$or` become boolean-only.** Operands evaluate left to right; each
*evaluated* operand is validated against the same boolean position rule.
`$and` returns `false` at the first `false` operand without evaluating the
rest, and `true` when every operand is `true`; `$or` is the mirror. The
result is always a boolean. Short-circuiting is preserved exactly — operands
after the deciding one are neither evaluated nor validated. For programs
whose operands were already boolean, old and new semantics agree value for
value; the break is confined to non-boolean operands, which now error
instead of flowing through as "the deciding value."

**Prefix `!` likewise.** `!` lowers to the `not` builtin, so boolean-only
`!` *is* boolean-only `not`: a non-boolean argument is a runtime error. The
registry already declares `not`, `and`, and `or` as `(boolean, …) →
boolean`; the runtime behavior now matches the signatures instead of
coercing.

**Condition narrowing becomes exact.** The truthiness narrowing form
deletes; a bare boolean subject splits exactly into `true`/`false`, and the
boolean-field discriminant idiom (`if r.ok …`) survives verbatim — now with
no truthy/falsy approximation anywhere in the condition forms.

Untouched, stated to keep the boundary visible: `$match` (structural
equality, never truthiness); `$get`'s `$else` arm (miss-triggered — there is
no condition); the `$then`/`$else`/result positions of every branch form
(any type, as today); the `isType` family, `hasKey`, comparisons, and regex
tests (already boolean-producing); and the defaulting story — the
`x || default` idiom this chunk deletes was already replaced by 2b:
`?? default` for absence, the exactly-narrowed explicit conditional for
null ([`strict-reads-2b.md`](strict-reads-2b.md) decision 2).

## Rules to pin while writing

### 1. The boolean-position inventory

State the rule **once**, over a named list of positions, so later deletions
edit the list rather than the rule (Stage 3 removes `$if`; the rule must not
be phrased as `$if`'s). The positions:

- the `$if` condition;
- each `$cond` arm condition;
- each `$and` / `$or` operand;
- the arguments of the `not`, `and`, and `or` builtins;
- **predicate-callback results**: the callback result of every builtin whose
  registry signature declares a `boolean`-returning callback — the
  `filter`, `partition`, `find`/`findIndex`, `some`, `every`, and `count`
  families, including their `*Indexed` forms.

The last entry is the sweep that makes "truthiness is deleted" true rather
than mostly-true: if `filter` keeps coercing its callback result, truthiness
survives inside the stdlib with no spelling. Recommend the family rule as
one sentence in `standard-library.md` beside the existing precedent
("`reReplaceWith` callbacks must return strings"): a predicate callback must
return a boolean; any other result is the same evaluation error as a
non-boolean condition. The registry signatures already say boolean —
nothing in the registry or the generated catalog changes.

### 2. Validation is attached to evaluation, never a pre-pass

A non-boolean condition errors only when evaluation reaches it: a `$cond`
arm whose condition is non-boolean errors only if every earlier condition
evaluated to `false`; an `$and`/`$or` operand past the deciding one is
neither evaluated nor validated. "Only the taken branch / tested prefix
evaluates" survives unchanged, and the trace stays a pure function of values
(which operand errors is value-determined). One sentence, stated with the
position rule.

### 3. Error identity

Pin the payload the way 2a pinned the cycle rendering and 2b the miss
payloads:

- the error names the position (the `$if` condition; `$cond` arm *i*'s
  condition; `$and`/`$or` operand *i*; `not`'s argument; the named
  builtin's callback result) and the evaluated value's kind — recommend the
  2b-shaped rendering: "condition must be a boolean; got string";
- the class is **host error** — the same class as `checked as` failures,
  arithmetic errors, and access misses, not a `raise`-catchable domain
  signal. This is forced by the framing: condition position validates
  against the boolean schema, and schema-validation failures are host
  errors. Runtime source spans are not required (2b's posture).

### 4. Checker surface

A condition's type must be **assignable to `boolean`** (`boolean`, `true`,
`false`, unions thereof) — ordinary assignability against the declared
position, no new machinery, which is exactly the 2f invariant instance: the
checker's boolean requirement and the evaluator's boolean validation are
the same object. Consequences to state:

- `string`, `integer`, `T | null`, composites: static errors at the
  condition, with the fix hints the migration teaches (`x != null`,
  `n > 0`, `s != ""`, `length(xs) > 0`) — the loud checker error is the
  point of D4;
- `any` is admitted (the general posture: `any` is unknown evidence, not a
  rejection), with the runtime validation as the fail-closed backstop — in
  a fully checked program with no `any` reaching a condition, the runtime
  error is unreachable;
- a literal `true`/`false` condition is legal (`true:` is the documented
  explicit catch-all arm of `cond`); unreachable-branch diagnostics remain
  a separate concern, unchanged here.

### 5. The narrowing rewrite

`narrowing.md` form 1 (Truthiness) is **replaced**, not patched, by a
boolean-subject form: a subject used directly as a condition — necessarily
boolean-typed now — is `true` in the then branch and `false` in the else
branch; `boolean` ⇒ `true`/`false`, and a literal boolean type collapses to
`never` on the impossible branch. Deleted with the old form: the falsy-slice
text (`0`/`""` dropping), "composites and functions are always truthy," and
the widen-back-on-inexact-split soundness clause — on the boolean domain the
split is a partition and **exact**, the sentence 2f consumes. Kept,
reworded:

- the union-base **boolean discriminant** (`if r.ok then r.output else
  r.error` on `{ok: true, …} | {ok: false, …}`): each branch keeps the arms
  whose field admits `true` (then) / `false` (else); an arm whose field is
  plain `boolean` survives both. Same idiom, same text shape, minus the
  truthy/falsy vocabulary;
- **named boolean guards**: the fallback sentence "the local is narrowed by
  its own truthiness" becomes "the local is narrowed as a boolean subject";
- `not`/`!`, `$and`, `$or` composition and the `$and`-false / `$or`-true
  limits: unchanged — senses and fact conjunction are unaffected by the
  operand type rule.

The `if x` idiom on `T | null` does not survive as a narrowing form — it is
now a checker error at the condition — and needs no replacement text beyond
form 3's existing `x != null`.

### 6. Cost: nothing changes

The first Stage 2 chunk with **no cost-vocabulary edit**: no new event, no
redefinition. The boolean validation is part of the branch node's
straight-line work — a constant-time kind check like `$get`'s key-validity
check, folded into the node's existing count in the region static constant.
It is *not* the `$as` validator (no schema-walk cost). The arm-selection
attachment list (`$cond`/`$match`/`$if` arms, further `$and`/`$or`
operands, `$get` `$else`, `handle` clauses) is untouched. One short
paragraph in the language limits document beside the access-cost one;
`runtime/execution-limits.md` is verify-only. Conformance vector to draft
for 2g: short-circuit charging is value-for-value identical before and
after for a boolean-operand program.

### 7. `$and`/`$or` arity — at least two operands

The current constraint ("value must be an array of expressions") is silent
on empty and singleton arrays, and the value-returning semantics gave them
no stable meaning. Under boolean-only semantics both acquire tempting
definitions (empty = identity `true`/`false`; singleton = "validate
boolean"), and both should be **rejected**: recommend a structural
constraint of **at least two operands**. Reasons: the shorthand can only
express two or more (`&&`/`||` flatten from binary); an empty form would be
a second canonical spelling of `true`/`false` and a singleton a bare
validation form, violating one-spelling-per-layout (2d rule 3's posture);
and the singleton cannot be normalized away (`$and: [e]` → `e` drops the
validation, so it is not semantics-preserving). Programmatic composition
has the eager `and`/`or` builtins and `reduce`. Priced into the Stage 2
break like every structural tightening.

## Rewrite surface, file by file

Normative core:

- `spec-v2/docs/language/json/expressions.md` — the primary rewrite. The
  Conditional section: "if truthy" becomes the boolean-position rule
  ("`$if` must evaluate to `true` or `false`; any other value is an
  immediate error"), with the validation-against-the-boolean-schema framing
  sentence, the position inventory (rule 1), and the error identity
  (rule 3) stated here once. The Multi-branch section: "the first truthy
  condition wins" becomes "the first condition to evaluate to `true`
  selects its result," plus rule 2's reached-arm sentence. The
  `$and`/`$or` sections: rewritten to boolean-only semantics (operand
  validation, boolean result, short-circuit preserved; the
  first-falsy/first-truthy return language deletes), with the arity
  constraint (rule 7). A new checker paragraph carries rule 4. The
  constraints list: the truthiness definition line **deletes**; the
  `$and`/`$or` entries gain "of at least two expressions."
- `spec-v2/docs/language/json/narrowing.md` — form 1 replaced per rule 5;
  the composition section's named-guard sentence; the exactness sentence
  2f consumes. The Limits section survives (the `$and`-false/`$or`-true
  limit is unchanged).
- `spec-v2/docs/language/shorthand/control-flow.md` — "the first truthy
  condition selects its result" rewords; the **Truthiness section is
  replaced by a Boolean-conditions section**: conditions must be boolean,
  non-boolean conditions error, `&&`/`||`/`!` are boolean-only, `match`
  uses structural equality as before.
- `spec-v2/docs/language/json/execution-limits.md` — one short paragraph
  beside the property-access one: boolean validation is straight-line work,
  no event; typing/validating a condition cannot change its fuel (rule 6).
- `spec-v2/docs/language/json/standard-library.md` — the Logic family gets
  its runtime sentence (`not`/`and`/`or` error on non-boolean arguments);
  the HOF section gets the predicate-callback family rule beside the
  `reReplaceWith` precedent (rule 1).

Consistency sweep:

- `spec-v2/docs/language/shorthand/operators-and-precedence.md` — the
  `&&`/`||` rows' meaning text (boolean and/or; no "deciding value"); the
  prefix-`!` sentence gains boolean-only; lowerings, flattening, and the
  "named `and(...)`/`or(...)` remain eager" aside are unchanged.
- `spec-v2/docs/runtime/execution-limits.md` — verify-only: the
  arm-selection bullet already covers `$and`/`$or` operand continuation and
  needs no edit; confirm no truthiness vocabulary appears.
- `spec-v2/docs/builtins/` — verify-only: `not`/`and`/`or` and the
  predicate signatures already declare boolean; no registry change, no
  regeneration.
- `spec-v2/docs/language/json/index.md` — the `expressions.md` /
  `narrowing.md` line descriptions, if they name truthiness.
- `spec-v2/docs/guides/writing-jfn.md` — the authoring rewrite [`plan.md`](plan.md)
  assigns this chunk:
  - §5: the operator-table rows for `&&`/`||` ("returns the deciding
    value" → boolean and/or); the `emptyIsTruthy` and
    `fallback: value || "default"` example lines delete, replaced by
    boolean idioms; the surrounding prose drops truthiness.
  - §8: "first truthy arm wins" → "first true arm wins"; one sentence
    stating the boolean rule and the error.
  - §11: the narrowing summary's truthiness form is replaced by the
    boolean-subject/boolean-discriminant statement.
  - §13 lists: the "only `false`/`null`/`0`/`""` are falsy" (JS) and
    "empty `[]`/`{}` are truthy" (Python) trip-ups are replaced by the new
    one — **conditions must be boolean**: `if retries` is an error at zero
    or not; write `retries > 0`, `s != ""`, `length(xs) > 0`, `x != null`.
  - The migration idioms paragraph points at 2b's landed forms:
    `x || default` becomes `x ?? default` when the value is an access and
    absence is the case, and the explicit conditional (fully typed under
    exact `T | null` narrowing) when null is. No new defaulting surface is
    introduced here — 2b's decision 2 and its revisit criterion govern.

## Hand-offs to sibling chunks

- **2b (strict reads)** — consumed, as its hand-off anticipated: the
  migration text states `?? default` and the exact conditional as the
  landed replacements for `||` defaulting. Nothing in 2e's text may
  introduce a defaulting form; the null-defaulting residue stays governed
  by 2b's revisit criterion in [`status.md`](status.md).
- **2a / 2c / 2d** — no interaction, verified in both directions: 2d's
  lowering emits projections and `$else` arms, never conditions, and no 2e
  text may treat a `$get` `$else` (miss-triggered) as a condition position.
  The `$and`/`$or` operand-continuation cost text 2b/2a shaped is
  untouched.
- **2f (coherence framing)** — consumes two sentences written here: the
  exactness statement (condition narrowing is exact on the boolean domain)
  and the validation framing (the checker's boolean requirement and the
  evaluator's boolean validation are the same object; in a checked program
  the runtime condition error fires only where `any` crosses in). Written
  after 2e so it states, rather than anticipates, this text.
- **2g (conformance assembly)** inherits the case consequences; drafted
  here, assembled there:
  - delete: the truthiness narrowing suite
    (`spec-v2/cases/check/narrowing/truthiness.json`) and every eval case
    pinning truthy/falsy condition behavior or value-returning
    `$and`/`$or`;
  - rewrite: the conditionals eval suite, branch/guard check suites, and
    the program-level cases (`chess`) to boolean conditions and boolean
    `$and`/`$or` results;
  - add: the non-boolean runtime error per position in rule 1's inventory
    (including a predicate-callback result case); rule 2's
    short-circuit-before-validation cases (a non-boolean operand past the
    deciding one does not error; a non-boolean `$cond` arm condition
    errors only when reached); the arity-constraint rejections (empty and
    singleton `$and`/`$or`); checker condition-type errors (`string`,
    `T | null`) plus the admitted-`any` case; exact boolean narrowing
    (`boolean` ⇒ `true`/`false`; the boolean discriminant; the named-guard
    fallback); and rule 6's fuel-unchanged vector.
  - The `examples/` corpus audit rides 2g: checked programs already hold
    boolean-typed conditions almost everywhere (the checker rewarded it);
    expect the breakage to concentrate in `||` defaulting and bare
    `if x` null checks, each migrating mechanically to 2b's forms.
- **Stage 3** — item 1 (`$if` removal) edits rule 1's position list, not
  the rule; item 2 records Proposal 5 as resolved by pointing at this
  chunk's `$and`/`$or` text, which is why the boolean-only semantics must
  read as *the forms' definition*, not as a condition-position side effect.
- **[`status.md`](status.md)** — when the spec text lands: mark D4's entry
  stated in spec text (as D1–D3 were for Stage 1), and record rule 1's
  predicate-callback pin and rule 7's arity pin as settled-while-writing,
  the way 2b and 2d recorded theirs.

## Acceptance criteria

- Truthiness is unexpressible: no coercion at any boolean position, and no
  truthy/falsy vocabulary survives anywhere in `spec-v2/docs/` (grep-clean
  for truthy/falsy/truthiness) — with one carve-out: the authoring guide may
  name the concept in explicit statements of absence ("there is no
  truthiness"), the same pattern as its "no `===`" / "no `?.`" trip-ups,
  because migration text must name the instinct it negates. Normative
  reference documents stay fully grep-clean.
- Every boolean position in rule 1's inventory is fail-closed at runtime
  and statically checked against the same boolean schema; one conformance
  case per position asserts the error.
- Short-circuit structure is unchanged: only the taken branch / tested
  prefix evaluates, validation attaches to evaluation, and a
  boolean-operand program consumes identical fuel before and after.
- Condition narrowing is exact — the boolean-subject split is a partition,
  the boolean-discriminant idiom typechecks as today, and no approximation
  clause remains in the condition forms.
- The registry, the generated builtin catalog, and the contract format are
  byte-unchanged.

No format-visible shape changes originate in 2e beyond the `$and`/`$or`
minimum-arity constraint: no new fields, no printer, normalizer, or hashing
rules. Like 2a, this chunk is semantics, checker-surface, and
error-identity text only — which is why it is independent of 2a–2d and
needs only 2b's landed vocabulary. Case migration and vector pinning stay
with 2g, as for the whole stage.
