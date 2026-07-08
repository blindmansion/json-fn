# Example-authoring friction log

Running notes from writing *new*, code-first example programs (as opposed to the
older JSON-first ones like `chess`/`life`/`tictactoe`, which read like
transliterated JSON trees). The goal of these examples is to write something of
comparable complexity that reads naturally, and to surface every spot where the
natural thing to write either isn't supported, behaves surprisingly, or lowers/
prints worse than expected.

Each example gets its own section. Findings are tagged:

- 🔴 **gap** — natural to write, not supported (or actively wrong).
- 🟡 **surprise** — supported, but behaves/lowers/prints in a non-obvious way.
- 🟢 **win** — a feature that made the code cleaner than expected (worth keeping in mind).

---

## `examples/calc.jfn` — a tiny arithmetic expression interpreter

Tokenizer → recursive-descent parser (AST as tagged records) → tree-walking
evaluator → AST pretty-printer. Self-referential, exercises `match`, records,
recursion, HOF combinators, templates, module constants. Validated end-to-end via
the CLI (`--entry demo`, `--entry calc --args …`); shorthand round-trips stably.

### 🔴 Comments do not survive lowering

Every `//` comment — the header block, the grammar sketch, the section banners —
is silently dropped by `to-json`, so it's gone from any canonical reprint
(`to-json | to-shorthand`). The shorthand spec already flags comment attachment
as an open TODO (§1, §12), but the practical consequence is sharp: **a file whose
whole purpose is to read well cannot be canonically reprinted without losing all
of its prose.** For an examples/ directory that doubles as documentation, this is
the single biggest gap. Until `$comment` attachment lands, hand-written examples
are the source of truth and must never be "fixed up" by running them through the
printer.

### 🔴 Self-referential bare function references throw a circular-dependency error

The natural way to recurse a callback over sub-nodes:

```jfn
evaluate: (node) => match node.type {
  ...
  "call" -> applyFn(node.name, map(evaluate, node.args)),   // inside `evaluate`
  ...
}
```

fails at runtime:

```
evaluation error: Circular variable dependency detected: evaluate -> evaluate
```

Why: `evaluate` is a module (lexical) binding, so the bare name `evaluate` in
value position is a `$var` **value** read, which forces the binding — but we're
already mid-evaluation of that same binding, so the letrec cycle-checker fires.

Fix: use the explicit reference form `&evaluate` (lowers to `{ "$fn": "evaluate" }`,
a name, not a forced value), or an eta-wrapper `(n) => evaluate(n)`.

Subtlety worth noting: **non**-self-referential bare refs are fine — passing
`parseTerm` into `parseBinary(…, parseTerm)` worked, because `parseTerm` isn't on
the stack when its value is forced. So the footgun is specifically
*recursion-through-a-value*. The shorthand spec says "`&` is optional for a bare
name," which is true only for *registry* names; for a self-referential local/
module binding, `&` is mandatory. That caveat isn't obvious from the spec.

Possible mitigations: (a) special-case function-valued bindings so a bare
self-reference resolves to the function *reference* rather than forcing the value;
(b) at minimum, document the rule and improve the error to hint "use `&name` to
pass a function by reference."

### 🟡 Expression-level `where` silently compiles to an IIFE

Written expecting `step` to be a local of `sqrtApprox`:

```jfn
sqrtApprox: (value) => if value <= 0 then 0 else step(value, 20) where {
  step: (guess, iters) => ...
}
```

The `where` binds to the nearest preceding expression — here the `else` operand
`step(value, 20)`, **not** the function body. Since `where` locals need a
function body to live in, an expression-position `where` lowers to a zero-arg
closure that is immediately invoked, and the printer faithfully renders it back as:

```jfn
sqrtApprox: (value) => if value <= 0 then 0 else (() => step(value, 20) where {
  step: ...
})(),
```

It's semantically correct (the demo's `sqrt` returns 5), but it allocates and
calls a closure on every branch hit, and reads worse. Attaching the `where` to
the whole function body by parenthesizing the `if` fixes both:

```jfn
sqrtApprox: (value) => (if value <= 0 then 0 else step(value, 20)) where {
  step: (guess, iters) => ...
}
```

Easy to get wrong. Worth a doc note under §8, and the printer could recognize the
`{$fn: [ <body-with-locals> ]}` IIFE shape and print it as a branch-level `where`
instead of re-expanding the IIFE.

### 🟡 Small data objects always pretty-print one key per line

A parser built on `{ node, next }` cursor records reads great inline, but the
printer explodes every data object vertically — `{ node: left, next: at }`
becomes three lines, and a nested `{ type: "binop", op, left, right }` inside a
`cond` arm becomes a deeply-indented block. The record-return style balloons in
canonical form. The argument/element-list printer already has a fits-on-one-line
heuristic; small data objects don't, and this style would benefit from the same.

### 🔴 No `sqrt` / `pow` in the stdlib

A "calculator" naturally wants these. Neither exists (despite `stretch.jfn`
referencing them — see `shorthand-llm-probes.md`). It turned into decent juice
here (the example ships its own `sqrtApprox` via Newton–Raphson and a recursive
`powInt`), but it's a natural expectation that isn't met. Candidates for the
stdlib backlog alongside `sum`/`unique`/etc.

### 🟢 Out-of-bounds index access returning `null` removed all end-of-input guards

`tokens[at]` past the end returns `null`, which matches no operator/paren, so the
recursive-descent folds terminate with **zero** explicit length checks. This made
the parser materially shorter than the equivalent would be in a language that
throws on OOB. Nice.

### 🟢 Passing module functions as values worked as written

`map(run, cases)`, `map(&evaluate, …)`, and the HOF parser combinator
`parseBinary(tokens, pos, ["*", "/"], parseFactor)` — where the sub-parser is
passed as a value and called through a parameter — all worked. The one-function
`parseBinary` covering both arithmetic precedence levels is exactly the kind of
abstraction the older examples avoid.

---

## `examples/poker.jfn` — a five-card poker hand evaluator

Deliberately a different flavor from `calc`: a **collection pipeline**, not a
tree walk. Parse cards → `groupBy` rank → `mapValues`/`values`/`entries` → `sort`/
`reduce` to classify, tie-break, and run a showdown. Validated across all nine
hand categories plus the A-2-3-4-5 wheel, a full-house-vs-full-house tiebreak, and
the non-straight K-A wrap; round-trips stably. This example hit **far** less
friction than `calc` — the collection stdlib is in good shape.

### 🟢 The collection stdlib composes into clean pipelines

`mapValues(length, groupBy(rankValue, hand))` for rank histograms,
`sort((a, b) => b - a, values(...))` for the count shape, `entries(...)` +
`sort` for tie-break ordering, `reduce(...)` for the showdown — all read like a
real data language. This is exactly the register the JSON-first examples never
reach, and it needed no workarounds. Bare module functions as callbacks/keyFns
(`groupBy(rankValue, …)`, `map(evaluate, hands)`, `mapValues(length, …)`) all
worked without `&` (non-self-referential, so no cycle — cf. calc finding #2).

### 🟢 Arrays as composite compare keys

Encoding a hand's strength as `score = [categoryRank, ...tiebreakRanks]` and
comparing with a recursive `lexCompare` felt natural and made `best` a one-line
`reduce`. Ordinary arrays + a small recursive comparator cover "sort by a tuple
of keys" without any special support.

### 🟡 `groupBy` on a numeric key hands back string keys

`groupBy(rankValue, hand)` groups by a **number** (rank 2..14), but `entries(...)`
then yields `["13", count]` — keys are stringified (`String(key)` in the impl).
Recovering the numeric rank for tie-break sorting needs an explicit
`num(e[0])`. Natural to forget; the round-trip number→string→number is a small
papercut inherent to object keys being strings.

### 🔴 No `sum` / `unique` (again)

Counting *distinct* ranks (to detect a straight) wanted `length(unique(map(rankValue, hand)))`;
with no `unique`, the workaround is `length(keys(rankCounts(hand)))` — lean on the
histogram's key set instead. Works, and arguably fine, but `unique`/`sum` keep
coming up (see `shorthand-action-items.md` backlog).

### 🟡 Printer: arrays never wrap, objects always wrap (neither is width-aware)

Confirmed again here and worth stating crisply as a pair with the calc finding:
the pretty-printer renders **every array on a single line** (the 9-element
`CATEGORIES` and the 8-element `hands` list each become one very long line) and
**every data object across multiple lines** (one key per line, however small).
Neither decision considers line width. A width-aware policy — wrap long arrays,
inline short objects — would markedly improve canonical output for both the
list-of-cases and record-return styles.

---

## `examples/calendar.jfn` — Gregorian calendar math (destructured-param showcase)

Built specifically to exercise **destructured (named-argument) parameters**: a
date is a `{ year, month, day }` record, and nearly every function takes it as an
object pattern. Zeller's congruence for weekday, leap-year rules, ordinal
day-of-year. Validated against reality: 2026-07-07 → Tuesday (matches "today"),
moon landing 1969-07-20 → Sunday, 2000-02-29 leap, and the 1900 century rule
(divisible by 100, not 400 → not leap). Round-trips stably.

### 🟢 Destructured params are fully implemented and print cleanly

Despite `plans/destructured-params.md` saying **"spec drafted, unimplemented,"**
the TS toolchain implements the whole feature — parse, eval, **and** printer.
`({ year, month, day }) => …` lowers to `{"$params":[{"$fields":[…]}]}`, evaluates
with fields bound eagerly, and prints back exactly as `({ year, month, day })`
(space inside braces, `", "` between fields) per the plan's §3.1. Round-trip is
stable. **Action:** the plan doc's status line is stale and should be updated to
"implemented (TypeScript)".

As named arguments they read exactly as hoped — `daysInMonth({ year: year, month: m })`
and `dayOfWeek({ year: 2026, month: 7, day: 7 })` are self-documenting and
transposition-proof, which is the whole pitch.

### 🟡 The feature makes call sites idiomatic — and the printer makes them ugly

This is the sharp one. Destructured params encourage passing **small literal
records** at every call site. But the printer's "objects always multi-line" rule
(see calc/poker) means each of those call sites explodes:

```jfn
daysInMonth({
  year: year,
  month: m
})
```

and the 5-element `dates: [ {…}, {…}, … ]` demo list becomes a ~30-line vertical
wall. So the parameter side is gorgeous while the argument side — the part this
feature multiplies — is the worst-reading part of the canonical output. A
fits-on-one-line heuristic for small objects would pay off *most* here; the two
features (named args + width-aware object printing) really want to ship together.

### 🟢 Object shorthand-property punning `{ year, month }` (resolved)

The natural companion to a `{ year, month, day }` **pattern** is a `{ year, month, day }`
**literal** that puns field names to same-named variables. It *was* a parse error:

```
{ year, month }  ->  parse error: expected ':' after data-object key, found 'comma'
```

**Fixed.** Punning is now implemented in the TypeScript toolchain (parse, print,
spec). A bare-identifier key with no `: value` lowers as `{ year }` ⇒
`{ "year": { "$var": "year" } }`, mirroring the destructuring syntax, and it is
the canonical printback for a `{ "$var": k }` value whose key equals the name.
Only bare identifiers pun (quoted-string keys still require a value), and a value
carrying a `$get` path (`{ year: year.start }`) is not a pun. Documented in
`docs/shorthand-spec.md` §3/§10; `examples/calendar.jfn` uses it at every
named-arg call site. This roughly halves the width of those call sites and
directly softens the previous finding.

Remaining: this makes the call sites *narrower* but they still explode
vertically because of the "objects always multi-line" printer rule above — the
width-aware object printing finding is the last piece needed to make these read
as well as they lower.
