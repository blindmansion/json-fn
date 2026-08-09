# Plan: strict `$let` (Stage 2 chunk 2a)

Status: **proposed**, 2026-08-08. Owns [`plan.md`](plan.md) Stage 2 chunk 2a.
The decision itself is settled — Change 4's dependency-ordered variant, adopted
in [`review.md`](review.md) §3 and recorded in
[`event-trace-cost-model.md`](event-trace-cost-model.md); Proposal 3 is
resolved in this form. This document plans the spec text: what the normative
statements are, which files they land in, the handful of small rules that must
be pinned while writing, and what the chunk hands to 2c/2d/2g.

## The adopted semantics, restated precisely

`$let` bindings (and module bindings — the adopted Change 4 text covers both)
evaluate **eagerly, exactly once each, in dependency order**, before the scope
body. Deleted with the lazy machinery:

- laziness and demand: no binding waits to be referenced;
- memoize-after-first-use: a binding is simply evaluated once and bound;
- unforced-error suppression: a failing binding fails the `$let` even if
  `$in` never references it;
- the **binding-force event** and the `$let` lazy region boundary in the cost
  model — the last channel through which evaluation strategy (demand order)
  leaked into the trace.

Preserved:

- **order-independence for authors**: bindings need not be topologically
  sorted in source; dependency ordering supplies the evaluation order
  (this is what makes Change 4's variant strictly better than Proposal 3's
  sequential one);
- **scoping**: lookup, shadowing, and the callable-by-name rule for
  function-valued bindings are untouched — only evaluation *timing* changes;
- **mutual recursion** between sibling function-valued bindings;
- **cycles are errors** (now a schedule property, not a forcing property);
- **lazy parameter defaults** — positional `$default` and `$fields` field
  defaults (2d keeps the latter primitive) become the *only* lazy construct
  in the language, and the cost model's lazy boundary narrows to exactly
  them.

The determinism payoff, stated once in the runtime limits document: with
demand gone, the trace is fully determined by values alone, and speculative
or parallel evaluation is unconditionally legal (rather than legal only for
"values whose demand is determined").

## Rules to pin while writing

Each has a recommendation so the chunk is not blocked; none rises to a
status.md decision.

### 1. The dependency relation

An order edge runs from binding A to binding B when A's expression
**statically references** B — the same transitive `$var` / named-`$call` /
`$fn` relation the checker's reachability rule already names in
`expressions.md`. References from inside a nested function body **do**
create edges: closure creation consumes the referenced values (substitution
today, the capture record after 2c), so the values must exist when the
closure is created.

The exemption that preserves mutual recursion: a **call-position reference
to a sibling function-valued binding** resolves by name (today via
`$captures` machinery; after 2c via the retained by-name lookup tier that
Stage 3's resolution audit keeps) and adds **no edge**. Recommended
companion rule: value-position references to a sibling function binding
(`$var`/`$fn` taking the closure as a value) **do** add an edge — taking a
closure as a value needs the closure to exist. Consequence to state: two
sibling functions may recurse mutually through calls, but a value-position
cycle (`f` stores `g`'s closure while `g` stores `f`'s) is a cycle error.
Written in coordination with 2c so the edge rule and the capture rule are
the same sentence viewed from two sides.

### 2. The evaluation order, normatively

Order must be pinned, because it is observable through exactly three
channels: which error surfaces when independent bindings both fail, `tap`
output order, and the mid-flight fuel-exhaustion point. Recommended
statement (Kahn with source-order priority, phrased without the name):

> Bindings evaluate one at a time. At each step, the first binding in
> source order whose statically referenced siblings have all been evaluated
> is evaluated next. If unevaluated bindings remain and none is ready, the
> bindings form a cycle and evaluation fails.

This is total, decidable, and cheap; "as-if" freedom (reordering,
parallelism) follows from the determinism section rather than being
restated here — an implementation may evaluate in any order that produces
the same trace.

### 3. Cycle errors

Fail-closed and evaluator-enforced: the schedule stalls, evaluation fails.
The checker additionally reports the cycle statically (it has the same
graph). Error identity to pin, replacing the "first cycle reached" forcing
language in `language/json/execution-limits.md`: recommend naming the cycle
through the **earliest stalled binding in source order**, path in reference
order, keeping the existing rendering:

```
Circular variable dependency detected: a -> b -> a
```

Direct self-reference (`x: x`) is the one-node case of the same rule.

### 4. Dynamic references during binding evaluation

A dynamic callee (`{"$call": {"$var": "name"}, ...}`) can resolve to a
sibling binding's name at runtime, invisible to the static graph. Inside
`$in` this is a non-issue — every binding is evaluated by then. During
*binding* evaluation, recommend the TDZ-shaped fail-closed rule: a dynamic
name resolution that reaches a sibling binding **not yet evaluated** is a
deterministic evaluation error naming the binding. Deterministic because
the schedule (rule 2) is; cheap because it is a lookup-time check.

### 5. Module entries

The adopted text says module bindings go strict too, but modules serve
multiple entry points, so "evaluate everything always" is wrong-shaped.
Recommended rule: the module value entries in the **selected entry's static
reference closure** (same relation as rule 1) evaluate at invocation start,
dependency-ordered, before the entry function is invoked; entries outside
the closure do not evaluate. The trace stays a pure function of
(program, entry, inputs, effect results) because entry selection is an
input. Per-invocation, no cross-invocation memoization — matching Stage 1's
posture that a constant subtree charges on every invocation. Resumed
continuations do not re-enter module entries: captured values ride the
record (2c), and module *functions* stay by-name as today.

## Rewrite surface, file by file

Normative core:

- `spec-v2/docs/language/json/expressions.md` — the Let-binding section is
  the primary rewrite: strict/dependency-ordered semantics, the order rule,
  the edge rule and its mutual-recursion exemption, cycle errors. The
  checker block keeps the unused-binding error but replaces "Static
  reachability does not change evaluation: unused bindings are not
  evaluated" with the strict statement (in unchecked evaluation, an unused
  binding still runs — and can still fail).
- `spec-v2/docs/language/json/modules.md` — the entry-semantics bullet
  ("lazy, memoized, order-independent, mutually recursive, cycle-checked")
  becomes the rule-5 statement; name-resolution text is untouched.
- `spec-v2/docs/language/json/execution-limits.md` — "Circular variable
  dependencies" rewritten from forcing language to schedule language; the
  `$let` cost paragraph loses the binding-force event ("each binding
  expression is its own region, entered by the binding-force event" is
  replaced by the folding rule below).
- `spec-v2/docs/runtime/execution-limits.md` — the region rule's "no lazy
  boundary" clause narrows to the parameter-default boundary (the one
  surviving lazy construct); **binding force** leaves the event vocabulary
  and a **default force** event (attaching only to `$default` expressions)
  replaces it; the determinism paragraph drops the "values whose demand is
  determined" qualifier. A `$let` whose bindings and `$in` contain no
  invocation, branch, or builtin call now folds entirely into its
  containing region — `$let` disappears from the cost model as a boundary.
  Note for the versioning section: this is a redefinition of the vocabulary,
  not a versioned addition; it is priced into Stage 2's single break (the
  cost-model version identity component is Stage 4's item).
- `spec-v2/docs/language/json/functions.md` — light touch: the lazy-default
  sentences gain the "documented exception" framing (defaults are now the
  only lazy construct). Why the exception is sound to keep: in a strict
  language, whether and when a default is first read is itself
  value-determined, so the trace remains a pure function of values.

Consistency sweep (laziness language that must not contradict the core):

- `spec-v2/docs/language/shorthand/function-literals-and-local-bindings.md`
  — the `where` semantics paragraph and its cost paragraph (charged "when
  the binding is first forced" → containing-region folding).
- `spec-v2/docs/language/shorthand/effects.md` — `do` pure bindings lower
  to plain `$let`, so they inherit strictness automatically; rewrite the
  "lazy, memoized, order-independent, mutually recursive" sentence
  (order-independent and mutually recursive survive; lazy and memoized do
  not).
- `spec-v2/docs/language/shorthand/files-and-program-shape.md` — module
  entries paragraph, aligned with `modules.md`.
- `spec-v2/docs/language/shorthand/grammar.md` — the "pure (lazy-local)
  binding" comment token.
- `spec-v2/docs/language/shorthand/operators-and-precedence.md` — the
  "lazy `$let` binding" aside on comparison-chain lowering.
- `spec-v2/docs/language/json/standard-library.md` — "A `tap` in an
  unreferenced lazy binding is not evaluated" is deleted; under strict, a
  `tap` in any binding fires (and `tap` order is pinned by rule 2).
- `spec-v2/docs/language/json/narrowing.md` — verify-only: the named-guard
  alias cycle-check text survives unchanged (cycles are errors either way);
  the truthiness text in the same file is 2e's, not ours.
- `spec-v2/docs/guides/writing-jfn.md` — the `where`-semantics passages,
  and the **authoring-pattern break** below.

## The authoring-pattern break to document

The guide currently teaches demand-driven bindings, with an example that is
**an error under strict `$let`**:

```jfn
mean: total / n, // never forced on the empty branch
```

Under strict evaluation this divides by zero on the empty branch regardless
of which branch is taken. The migration is mechanical — move the binding
into the branch that uses it — and this is precisely the
"demand-driven authoring patterns are removed" cost the event-trace plan
accepted. The guide gets the corrected idiom; `examples/` programs are
audited for the same pattern when the stage lands. This is the one
user-visible sharp edge of 2a and deserves its own paragraph rather than a
silent example fix.

## Hand-offs to sibling chunks

- **2c (capture closures)** consumes the rule-1 edge definition: "capture
  stores eagerly evaluated binding values" is the same fact as
  "value-position references create order edges." The by-name tier for
  sibling and module functions must be one story across 2a's exemption,
  2c's record, and Stage 3's resolution audit.
- **2d (`$fields` lowering)** targets 2a's eager `$let` for its body-top
  projections; field defaults stay lazy *at the slot descriptor*, not in
  the lowered `$let` — nothing in 2a's text may imply a lazy `$let` form
  survives for the lowering to lean on.
- **2g (conformance assembly)** inherits the case-level consequences;
  drafted here, assembled there:
  - delete: unforced-error-suppression cases, demand-order fuel cases,
    forcing-based cycle cases;
  - rewrite: cycle errors as schedule-stall errors with the pinned
    identity (rule 3);
  - add: dependency-order vectors observable through error selection and
    `tap` order; strict-failure cases (erroring unreferenced binding);
    value-position vs call-position sibling-function cycle cases (rule 1);
    the dynamic-reference TDZ error (rule 4); module entry-closure cases
    (rule 5); cost vectors for `$let` region folding and the narrowed
    default-force event.

No format-visible shape changes originate in 2a: no new fields, no printer
or hashing rules. 2a is semantics, cost, and error-identity text only,
which is why it can be written first and the others in its vocabulary.
