# Language/Stdlib Changes Required by the Shorthand

The shorthand ([`shorthand-spec.md`](./shorthand-spec.md)) is a pure surface
layer, but two small changes to the **core language/stdlib** make its lowering
clean and idiomatic. Both are safe because nothing is locked yet. Each touches
`docs/language.md`, the TS and Python interpreters, and the examples.

## 1. `strcat` becomes variadic — DONE

**Was:** `strcat(a, b)` — strictly binary.
**Now:** `strcat(...strings)` — variadic, like `concat(...arrays)`.

Rationale: consistency with the stdlib's existing variadic string/array idioms
(`concat` is variadic; `join(arr, "")` already concatenates an array), and it
gives the shorthand's `++` operator and template strings a single flat lowering
target (`strcat(a, b, c)`) instead of a right-leaning nest of binary calls.

Shipped:

- All four interpreters use `arity = -1` and concatenate their args, still
  rejecting non-string arguments (`"strcat: arguments must be strings"`); no
  implicit coercion, consistent with the explicit `num`/`str` helpers.
- `strcat()` with zero args returns `""`; a single arg returns itself.
- Spec cases in `spec/cases/string-helpers.json` lock down the variadic form.
- `docs/language.md` signature updated to `(...strings)`.
- Backward compatible for existing 2-arg call sites.

## 2. Rename the `$literal` form to `$raw`

**Now:** `{ "$literal": <value> }` — return value verbatim, evaluate nothing.
**Change:** `{ "$raw": <value> }` — identical semantics, new key name.

Rationale: the shorthand keyword is `raw`, and keeping the JSON key identical
(`raw X` ↔ `{ "$raw": X }`) makes the mapping obvious. "raw" also signals
"un-evaluated / verbatim" more clearly than "literal".

- Rename the key in both interpreters and in `docs/language.md` +
  `docs/execution-limits.md`.
- Update examples (`examples/chess.jsonc` uses `$literal` in several places).
- Straight rename, no semantic change.

> Decision needed: whether to keep `$literal` as a temporary alias for
> compatibility, or hard-rename. Recommendation: **hard-rename** while unlocked.
