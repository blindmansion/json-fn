# Smaller fixes

Overview for §7 of `plans/recenter-plan.md`. Goal: a grab-bag of roughly
one-sitting fixes. Each is independent; none needs the big check-mode or
narrowing work, though a couple are partly subsumed by Priority 2/3.

## 1. `where` at expression top level

`where` doesn't parse everywhere the error message recommends it. Pick one:

- make it parse everywhere the error message suggests, or
- fix the `let … in` removal message so it only recommends `where` where it
  actually works.

Files: `typescript/src/shorthand/parser.ts` (and the error text in
`typescript/src/shorthand/error.ts`). Add `spec/parse-cases/`.

## 2. Index / parse ergonomics

Small rendering + shape fixes:

- `head([])` renders `false` in the element slot — fix the empty-array element
  type rendering.
- Flatten nested `anyOf` when building/rendering unions.
- Literal-union widening in rendered types (partly subsumed by Priority 2's
  check-mode, but the *rendering* fix stands on its own).

Files: `typescript/src/check/schema.ts` (union flatten / element type),
`typescript/src/shorthand/printer.ts` (type rendering),
`typescript/src/check/builtin-rules.ts` (`head`/`tail` element slot).

## 3. Refinement UX note (no code change expected)

Refined types (`Score = integer & min(0)`) remain opaque to arithmetic. The
agent-era answer is the same `!` / boundary-validation path as Priority 3, not
static refinement inference. Capture this as a documented limitation rather
than building refinement inference.

Files: `docs/language.md` (a short "refinements are opaque to arithmetic"
note pointing at `!`).

## Landing checklist

- `where` either parses where recommended or the message is corrected.
- `head([])` element slot renders sensibly; nested `anyOf` flattened.
- Refinement/arithmetic limitation documented, pointing at the `!` path.
