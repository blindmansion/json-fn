# Future features

Things we're thinking about but haven't committed to building. Unlike
`todo/impl-feature-parity.md` (port what already exists) and
`todo/conformance-tests.md` (pin what exists), this is the forward-looking
backlog. Design details, where they exist, live in `plans/`.

## Type system (large)
A JSON-Schema-backed structural type system: TS-flavored shorthand for types
that parses to JSON Schema, signatures via `$sig`, module-level `$types`, dual
static-check / runtime-validate reading, subschema checking over a restricted
schema fragment, internally-polymorphic builtins. Full design sketch (with
decisions, open questions, and a worked chess example) in
`plans/type-sketch.md`. Status: **draft / design sketch**, nothing implemented.

## Stdlib additions
Feasible, low-risk builtins the existing set implies; pick up individually as
demand appears. Each needs all four evaluators **plus** a `spec/cases` entry.
Candidates: `sum`, `unique`, `zip`, `take`/`drop`, `count`, `sqrt`/`pow`,
`replace` (plain, non-regex), `padStart`, `repeat`, `startsWith`/`endsWith`, and
a default comparator for `sort` (or `sortAsc`). Details + rationale:
`plans/shorthand-action-items.md` (Backlog).

## Shorthand syntax sugar (parser-only, TS + Rust)
Evaluate demand before adding each; all are pure surface sugar:
- object spread `{ ...s, k: v }` and array spread `[...xs, y]`
- computed object keys `{ [k]: v }`
- spread into call args `f(...xs)`
- block comments `/* … */`
- default parameters `(a, b = 1) =>`
See `plans/shorthand-action-items.md` (Syntax sugar candidates) and the full
LLM-probe findings in `plans/shorthand-llm-probes.md`.

## kwargs-style destructured function args
Named/keyword arguments via a destructured object parameter — e.g.
`({ from, to }) => …` called as `move({ from: 3, to: 7 })`, binding named fields
to locals instead of relying on positional order. Touches both the shorthand
(param destructuring syntax) and the calling convention / `$params` shape in the
evaluator (the calling convention is unchanged — a pattern slot destructures an
ordinary positional object argument), so it is a language feature, not
parser-only sugar. Full implementer-agnostic spec, with the `{ "$fields": [...] }`
canonical shape, lenient null-defaulting semantics, and conformance cases, in
`plans/destructured-params.md`. Status: **spec drafted (with cases),
unimplemented**; first cut is TypeScript-only. Optional/defaulted/renamed named
fields are deferred there. Interacts with the type system
(`plans/type-sketch.md`), whose `$sig` runs positionally parallel to `$params`.

## Core-form simplification (deprecate JSON-authoring conveniences)
Several core forms exist only to make **hand-authored JSON** terser or more
flexible. Now that the shorthand is the authored surface, that redundancy is
dead weight: the shorthand can lower to a smaller, more orthogonal core, and we
can strip the concise-but-overlapping node forms from the interpreters. Each
removal is a breaking change to the JSON layer, so batch and sequence them.
Candidates (collapse property access onto `$get`/`$from`, drop first-class
comparator nodes for stdlib functions, split the overloaded call/reference `$fn`
form) plus what to **keep** and full rationale: `plans/core-form-simplification.md`.

## Comment attachment (spec gap)
How `//` comments attach and lower to `$comment` — group/section comments,
comments on non-object targets — is unspecified. Open TODO in
`docs/shorthand-spec.md` §1 and §12.

## Module system (explicit non-goal for now)
`import` / `export`, re-exports, multiple modules, and a brace-less top-level
declaration form are noted as possible supersets but deliberately out of scope —
module scope kept to a single outermost frame over stdlib. See
`docs/shorthand-spec.md` §9 ("Future direction") and `plans/module-scope.md`
("Non-goal").

## Captured function *references* aren't inlined in call position (closure gap)

Escaping closures now re-attach the enclosing **local functions** they call by
name (see `docs/language.md` "Escaping closures carry the local functions they
call", impl in `replaceVars`/`attachFreeLocalFns` in
`typescript/src/evaluate.ts`, spec in `spec/cases/escaping-closures.json`). One
related gap is **not** covered by that work: a captured variable whose value is
a **function reference** (`{ "$fn": "name" }`, i.e. `&name`) used in **call
position** inside an escaping closure is left literal and dangles once the
closure leaves scope.

Root cause: the call-position capture in `replaceVars` only substitutes when
`getVar(callee)` resolves to a **function declaration** — `isFnDeclaration` is
true only for a string name or a `$return`-bearing body. A reference *object*
`{ "$fn": "add" }` is neither, so the callee name stays literal.

Minimal repro (from `typescript/`):

```bash
# A) reference OBJECT bound to `op`, used in call position -> stays literal, dangles
bun run src/cli.ts eval '(op) => (n) => op(n, 1)' --args '[{"$fn":"add"}]' --shorthand
#   => (n) => op(n, 1)
#   applying it fresh:  ((n) => op(n, 1))(5)  ->  "Function op not found"

# B) same, but `op` is a NAME STRING -> inlined (prints as the + operator)
bun run src/cli.ts eval '(op) => (n) => op(n, 1)' --args '["add"]' --shorthand
#   => (n) => n + 1

# C) same, but `op` is an inline BODY -> whole body inlined
bun run src/cli.ts eval '(op) => (n) => op(n, 1)' \
  --args '[{"$params":["a","b"],"$return":{"$fn":["add",{"$var":"a"},{"$var":"b"}]}}]' --shorthand
#   => (n) => ((a, b) => a + b)(n, 1)
```

Note this only bites when a reference *object* reaches the param unevaluated
(e.g. injected via `--args`, or a `{ "$fn": <expr> }` computed reference). In
ordinary shorthand, `&add` in argument position **evaluates to the bare name
`"add"`** (case B) and therefore does travel — so `foldr`-style HOFs closing
over `&add`/`&mul` work today (see `examples/escaping-closures.jfn` §6). The
inconsistency is: name string and inline body both travel, but the reference
object does not.

Possible fix: in the call-position branch of `replaceVars`, when
`getVar(callee)` is a function-reference object (`{ "$fn": <string|value> }`),
substitute the callee with that reference (or its underlying name) instead of
requiring `isFnDeclaration`. Needs a conformance case per the reference vs.
name vs. body matrix above, and a decision on whether `{ "$fn": <expr> }`
(computed reference) should be captured eagerly or left for call-time.

## Housekeeping
- Correct `plans/shorthand-llm-probes.md` §2e: the `Invalid JSON expression: {`
  output was the probe harness truncating a multi-line `exprError`; the real
  message is `"No $cond branch matched …"`. `cond`'s runtime error is fine.
- Optionally stop `typescript/examples/stretch-syntax.ts` from truncating error
  text at the first newline so multi-line evaluator errors print in full.
