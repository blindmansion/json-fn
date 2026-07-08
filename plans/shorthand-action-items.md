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

## Backlog — stdlib gaps & syntax sugar (case-by-case)

Feasible, low-risk additions surfaced by the probes; pick up individually as needed.

Missing stdlib that the existing set implies:

| Candidate | Notes |
| --- | --- |
| `sum` | fold over numbers; trivial |
| `unique` | dedupe (uses structural `eq`) |
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
