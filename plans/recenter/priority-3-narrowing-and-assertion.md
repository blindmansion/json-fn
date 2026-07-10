# Priority 3 — Freeze narrowing; ship `!`; collapse the warning tier

Overview for §4 of `plans/recenter-plan.md`. Goal: stop growing flow
narrowing, document the frozen set, fix the one narrowing bug, ship the `x!`
assertion operator as the sanctioned discharge path, and turn the ambiguous
warning tier into errors. This is a deliberate reversal of the
human-authored recommendation: deterministic, simple rules are easier for
models to learn and stay stable across model generations.

## 1. Freeze narrowing + write a short spec

Freeze the current working set — do not extend it:

- truthiness
- `isNull` / type predicates
- discriminant equality (`==` on a literal / static path) for `$if`/`$cond`
- on params and eager bindings

Deliverable is documentation of what exists, not a rebuild: a short spec
listing which condition forms produce facts and how they compose under
`not` / `$and` / `$or`, then table-test that set.

Files: new `docs/` section (or `plans/narrowing-plan.md` promoted/trimmed),
table tests in `typescript/test/check/`. Behavior lives in
`typescript/src/check/narrowing.ts`.

## 2. Fix the `factsFromCondition` fallback bug (one-liner)

A bare-var condition that resolves as a named boolean guard recurses into the
binding expression and returns `{}` when that yields no facts, instead of
falling back to `truthinessFact` on the var itself. This is why
`if h then h else 0` narrows for a param but not a `where`-local.

```268:272:typescript/src/check/narrowing.ts
    const guardExpr = ctx.guards?.[guardVar];
    if (guardExpr !== undefined && !seen.includes(guardVar)) {
      return factsFromCondition(guardExpr, sense, ctx, [...seen, guardVar]);
    }
```

Fix: if the recursion returns `{}`, fall back to
`truthinessFact(cond, sense, ctx)` on the guard var. File:
`typescript/src/check/narrowing.ts`.

## 3. `match` subject narrowing

Include `match` subject narrowing in the frozen set. It's the same
discriminant machinery `cond` already has (this is absence, not difficulty),
and `match subject.tag { … }` is the natural tagged-dispatch shape agents emit
constantly.

Files: `typescript/src/check/narrowing.ts` (reuse `equalityFact` /
discriminant logic), the `$match` synth/check case in
`typescript/src/check/checker.ts`.

## 4. Ship the `x!` assertion operator (type spec §9)

`x!` currently doesn't even parse. Ship it as the sanctioned discharge path
for unions in locals:

- Parse `x!` as a postfix operator in the shorthand (`lexer.ts` / `parser.ts`)
  and lower to a cast node in the canonical AST.
- Checker treats the cast's result as the asserted type.
- Runtime inserts a runtime-checked cast so soundness holds at the sandbox
  boundary (validate the value against the asserted type; raise on mismatch).

Files: `typescript/src/shorthand/lexer.ts`, `typescript/src/shorthand/parser.ts`,
`typescript/src/check/checker.ts`, `typescript/src/evaluate.ts` (runtime cast),
`typescript/src/shorthand/printer.ts` (round-trip), `docs/language.md` +
`docs/shorthand-spec.md`, plus `spec/parse-cases/` and `spec/cases/`.

## 5. Collapse the warning tier → errors

With `!` available, the anti-false-positive-fatigue warning downgrade is no
longer justified for agents (a warning is an ambiguous signal). Convert the
narrowable-mismatch warning to an error: prove it with a recognized guard, or
assert it with `!` and eat a runtime check. Make `$match` exhaustiveness /
dead-case lints errors too.

- Remove the `warning` downgrade at the narrowable-mismatch site (the §5.5
  runtime-checkable path in `context.ts` / `checker.ts`).
- Decide whether `warning` stays in `Severity` at all (may be replaced by the
  info/coverage tier from Priority 1).

Files: `typescript/src/check/context.ts` (`Severity`, `report`),
`typescript/src/check/checker.ts` (`reportMismatch` / mismatch sites),
`$match` lint site.

## 6. Do not loosen callback arity

Keep requiring the wrapper lambda (`map((x) => g(x), xs)`). Verbose but
mechanical; agents will just do it, and the subtyping rule stays simpler.
This is an explicit non-change (reverses the earlier loosen-for-idiom
recommendation) — call it out so it isn't "fixed" later.

## Note on existing machinery

The narrowed-memo / free-var re-synthesis machinery for lazy locals can stay
as-is or be simplified once narrowing is frozen — it no longer needs to grow.

## Landing checklist

- Frozen narrowing set documented and table-tested.
- `factsFromCondition` falls back to truthiness for named-guard locals;
  `if h then h else 0` narrows for a `where`-local.
- `match` subject narrowing works.
- `x!` parses, checks, round-trips, and inserts a runtime-checked cast.
- Narrowable-mismatch warnings and `$match` lints are errors.
- Callback arity rule unchanged.
