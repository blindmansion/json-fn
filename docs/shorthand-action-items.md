# Shorthand action items

Concrete follow-ups from the LLM-inference probe experiment (see
`docs/shorthand-llm-probes.md` for the full findings). This doc lists only the
things we decided to change. Explicitly **out of scope** (decided against):

- Object literals as scopes — `where` covers the need; keep object literals as data.
- Dropping the `else` requirement for `match`/`cond` (totality-by-exhaustiveness) —
  needs a type system; requiring a catch-all is the principled choice.

Implementation surface reminder: shorthand parsers exist in **TS** and **Rust**;
the evaluator exists in **TS, Rust, Go, and Python**; cross-impl behavior is pinned
by `spec/cases/*.json`.

---

## P1 — Function-valued parameter calls

**Problem.** `f(x)` fails with `Function f not found` when `f` is a parameter or a
value-bound local. A bare identifier in call position is compiled to a literal
registry name, never a variable lookup, so combinators like `twice`/`compose` can't
invoke their function arguments. This is table stakes for higher-order code.

```jfn
twice:   (f) => (x) => f(f(x)),      // Function f not found
compose: (f, g) => (x) => f(g(x))    // Function g not found
```

**Decision.** Enable direct calls via an **evaluator fallback**: when a string
callee is not in the function registry, resolve it as a variable; if that yields a
function declaration, call it.

**Steps.**
1. TS: in `callFunctionInternal` (`typescript/src/evaluate.ts`), in the string-callee
   branch where `functions[fn] === undefined`, fall back to `context.getVar?.(fn)`;
   if it `isFnDeclaration`, invoke it instead of throwing.
2. Mirror in `rust/src/eval.rs`, `go/evaluate.go`, `python/src/jsonfn/evaluate.py`.
3. Add a `spec/cases/*.json` entry (function-valued param call + a `compose`/`twice`
   style case) so all four impls stay in parity.
4. Update `docs/shorthand-spec.md` §4 (call resolution) to document the fallback.

**Ordering / precedence.** Do **registry-first → variable** now: this is a pure
addition, no existing program changes behavior. When the global-shadowing cleanup
(P4) lands, flip this same call site to **variable-first** so a local genuinely
shadows a same-named global.

**Note.** `apply(f, [x])` already works and remains the explicit form; this just adds
the `f(x)` sugar. Local *function declarations* (e.g. `where`-bound `loop`) already
live in the registry and are unaffected.

---

## P1 — Expression-level `where`

**Problem.** `where` reads like it attaches to any expression, but it's only accepted
immediately after a function body. Attaching it to a binding value (or any
sub-expression) is a parse error.

```jfn
f: (n) => r where {
  r: (a * 2) where { a: n + 1 }    // parse error: expected ',' or '}' in where-bindings
}
```

**Decision.** Make `where` a general expression-level construct via a **parser-only**
lowering — no evaluator changes. `expr where { binds }` lowers to a zero-arg IIFE
over a scope, reusing the existing `buildScope`/`callJSONFunction` machinery:

```json
{ "$fn": [ { "<binds…>": "…", "$return": "<expr>" } ] }
```

Validated end-to-end: `f: (n) => ((a*b) where { a: n+1, b: n+2 })` ⇒ `f(3) = 20`,
with free variables (`n`) captured correctly by `replaceVars`.

**Steps.**
1. TS parser (`typescript/src/shorthand/parser.ts`): add `parseBody()` =
   `parseExpr()` + optional trailing `where { … }`; when a `where` is present, emit
   the IIFE form above. Factor the scope-map construction so `parseFuncLit` (which
   inlines locals directly into the function, no IIFE needed) and `parseBody` share it.
2. Call `parseBody()` in the positions where a trailing `where` should be allowed:
   `where`-binding values (`parseWhereBindings`), `cond`/`match` arm results and
   `if/then/else` branches (`parseArms`, `parseIf`). Unambiguous because `where` is a
   reserved keyword with a brace-delimited block.
3. Mirror in `rust/src/shorthand/parser.rs`.
4. Update `docs/shorthand-spec.md` to describe `where` as expression-scoped bindings
   (function bodies = the case that also has `$params`).

**Tradeoff.** One extra call frame (fuel +1) per expression-level `where`. Negligible.
Avoid the alternative of a dedicated `$let` eval node — it would duplicate `buildScope`
across all four evaluators for no benefit.

---

## P2 — `cond` requires an `else` arm (consistency with `match`)

**Problem.** `match` requires `else` at parse time; `cond` does not. A `cond` with no
matching branch and no `else` fails only at runtime (`No $cond branch matched …`).
The asymmetry is a footgun.

**Decision.** Require `else ->` in `cond` at the **shorthand** layer too, mirroring
`match`. (Canonical `$cond` keeps `$else` optional — this is an authoring policy, not
an evaluator change.)

**Steps.**
1. TS parser: in `parseCond` (`typescript/src/shorthand/parser.ts`), throw
   `"cond requires an 'else ->' arm"` when `elseVal === undefined`, mirroring
   `parseMatch`.
2. Mirror in `rust/src/shorthand/parser.rs`.
3. Update `docs/shorthand-spec.md` §7.

**Note.** No `spec/cases` change needed (those exercise canonical `$cond`, which stays
optional). Existing examples all already provide `else`.

---

## P4 — Deferred: global operator/name shadowing

**Problem.** Arithmetic operators lower to named stdlib calls (`+`→`add`, `-`→`sub`,
`*`→`mul`, `/`→`div`, `%`→`mod`, `++`→`strcat`, unary `-`→`neg`). A top-level or local
binding of one of those names silently rebinds the operator:

```jfn
{ add: (a, b) => a - b, f: (x) => x + 1 }   // f(10) => 9, because x + 1 desugars to add(x, 1)
```

**Decision.** Deferred (owner will handle) — considered a straightforward cleanup.
When implemented, coordinate with P1's call-resolution precedence (switch to
variable-first) so local shadowing is consistent between operators and direct calls.
No steps scheduled here; listed for tracking.

---

## Backlog — stdlib gaps & syntax sugar (case-by-case)

Feasible, low-risk additions surfaced by the probes; pick up individually as needed.

Missing stdlib that the existing set implies:

| Candidate | Notes |
| --- | --- |
| `sum` | fold over numbers; trivial |
| `unique` | dedupe (define equality: scalar/`jsonEq`) |
| `zip` | pair two arrays |
| `take` / `drop` | array prefix/suffix |
| `count` | `length(filter(pred, xs))` convenience |
| `sqrt` / `pow` | math; `pow` = `Math.pow` |
| `replace` | plain (non-regex) string replace; complements `reReplace` |
| `padStart` | string pad |
| `repeat` | string/array repeat |
| `startsWith` / `endsWith` | string predicates |
| `sort` default comparator | today `sort` requires a comparator; consider a default or a `sortAsc`/keep `sortBy` |

Each new builtin must be added to all four impls plus a `spec/cases` entry.

Syntax sugar candidates (parser-only, TS + Rust) — evaluate demand before adding:

- object spread `{ ...s, k: v }` and array spread `[...xs, y]`
- computed object keys `{ [k]: v }`
- spread into call args `f(...xs)`
- block comments `/* … */` (line `//` comments already work)
- default parameters `(a, b = 1) =>`

---

## Housekeeping

- Correct the note in `docs/shorthand-llm-probes.md` §2e: the `Invalid JSON
  expression: {` output was the probe harness truncating a pretty-printed multi-line
  `exprError` at its first newline — the actual message is the proper
  `"No $cond branch matched …"`. `cond`'s runtime error is fine as-is.
- Optionally stop `typescript/examples/stretch-syntax.ts` from truncating error text
  at the first newline, so multi-line evaluator errors print in full.
