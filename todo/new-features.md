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

## Captured function _references_ aren't inlined in call position (closure gap)

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
true only for a string name or a `$return`-bearing body. A reference _object_
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

Note this only bites when a reference _object_ reaches the param unevaluated
(e.g. injected via `--args`, or a `{ "$fn": <expr> }` computed reference). In
ordinary shorthand, `&add` in argument position **evaluates to the bare name**
`"add"` (case B) and therefore does travel — so `foldr`-style HOFs closing
over `&add`/`&mul` work today (see `examples/escaping-closures.jfn` §6). The
inconsistency is: name string and inline body both travel, but the reference
object does not.

Possible fix: in the call-position branch of `replaceVars`, when
`getVar(callee)` is a function-reference object (`{ "$fn": <string|value> }`),
substitute the callee with that reference (or its underlying name) instead of
requiring `isFnDeclaration`. Needs a conformance case per the reference vs.
name vs. body matrix above, and a decision on whether `{ "$fn": <expr> }`
(computed reference) should be captured eagerly or left for call-time.

## Guest-level stack traces for runtime errors (DX)

Today a runtime evaluator error (bad `$get` key, `Function not found`, fuel/depth
limits, division by zero, …) throws a plain host `Error`. The guest author sees a
host-language stack trace (frames of `callFunctionInternal`/`evaluateExpression`
in `typescript/src/evaluate.ts`) and a message with no _guest_ context: which
function, which `where`-local, or which sub-expression was being evaluated. For
straight-line pure code this is survivable; for effectful programs driven through
`runTask` (see `typescript/examples/dungeon.ts`) a guest bug surfaces as an opaque
Bun stack dump from inside the trampoline.

We improved the _messages_ (richer `$get` diagnostics) and _host presentation_
(examples catch non-`TaskRaiseError` evaluator errors and print cleanly). The
remaining, larger piece is a **guest-level traceback**: thread a lightweight
frame stack through `EvaluationContext` (function name, and ideally the active
`where`-local / argument values) so a thrown error can render as, e.g.

```
  in move (dir = null)
  in step
  in playTurn
  at exits[dir]        (examples/dungeon.jfn)
```

instead of interpreter internals. Design notes:

- Push/pop a frame in `callFunctionInternal` (function name + args) and optionally
  when entering a named `where`-local. Keep it cheap — this is on the hot path;
  gate detail behind a limit or a debug flag if needed, or keep only names.
- Attach the trace to the thrown error (a dedicated `JsonFnRuntimeError` carrying
  `{ message, frames, node? }`) rather than string-concatenating, so hosts can
  format it.
- Distinguish guest programming errors (host-fatal per the effects plan — fuel,
  depth, var-not-found, bad key) from in-language `raise`; only the former get a
  traceback. `raise` stays a structured effect payload.
- Source spans: shorthand parse position isn't currently carried into the core
  JSON, so a first cut is function/local _names_ only. A later pass could thread
  `$comment`/position metadata for true source locations.
- Cross-cutting: mirror in the Go/Python/Rust interpreters for conformance, or
  scope this as a TS-only DX feature and document it as non-normative.

## Housekeeping

- Correct `plans/shorthand-llm-probes.md` §2e: the `Invalid JSON expression: {`
  output was the probe harness truncating a multi-line `exprError`; the real
  message is `"No $cond branch matched …"`. `cond`'s runtime error is fine.
- Optionally stop `typescript/examples/stretch-syntax.ts` from truncating error
  text at the first newline so multi-line evaluator errors print in full.
