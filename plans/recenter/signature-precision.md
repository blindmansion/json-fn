# Signature-precision work

Overview for §5 of `plans/recenter-plan.md`. Goal: tighten a handful of
builtin signatures that currently return bare, imprecise types. This mostly
fits the existing data-driven builtin design — `spec/builtins.json` edits plus
`$tvar` templates — but the object-producing cases (§1, §2) need a small
`CODE_RETURNS` code rule because the template resolver can't bind a type
variable nested inside a tuple or object. See each section for specifics.

## 1. `fromEntries` precise return

Today it returns a bare object:

```258:258:spec/builtins.json
    "fromEntries": [{ "params": [{ "type": "array" }], "returns": { "type": "object" } }],
```

Target: `fromEntries : ([string, V][]) -> { [string]: V }` — projecting the
pair's second element into `additionalProperties`.

**This needs engine work, not just a signature edit.** A plain `$tvar` template
can't express it today: `unifyTemplate` in `builtin-rules.ts` only binds type
variables nested in a bare `$tvar`, an `array items` template, or a `$fnType` —
there is no tuple (`prefixItems`) or object (`additionalProperties`) case, so a
var inside `[string, V]` falls through to the plain `isSubschema` branch, never
binds, and collapses to `any`. Two options:

- Add a `CODE_RETURNS` entry keyed on `fromEntries` (the return-recompute
  escape hatch that `merge` already uses — normal overload pass for arg/arity
  diagnostics, then recompute the return structurally). Preferred.
- Or add a tuple case to `unifyTemplate` so the plain template resolves.

Files: `spec/builtins.json`, `typescript/src/check/builtin-rules.ts`
(the `CODE_RETURNS` table).

## 2. Audit sibling object-producing builtins

`merge` is **already done** — it returns the structural spread of its operands
via the `CODE_RETURNS['merge']` rule, not a bare `object`. The remaining bare
ones near lines 255–261 are `values` (returns bare `array`, no items) and
`entries` (`array items array`). Both want the value type `V` bound from the
object's `additionalProperties` — which hits the *same* missing-object-case gap
in `unifyTemplate` as `fromEntries` (§1), so they also need a `CODE_RETURNS`
rule or an engine extension, not a plain template.

Files: `spec/builtins.json`, `typescript/src/check/builtin-rules.ts`, tests in
`typescript/test/check/builtins.test.ts`.

## 3. Stdlib pressure away from `-1` sentinels

`find` is **already done**: it returns `T | null` in both the runtime and its
signature (`anyOf [T, null]`), pairing with the narrowing/`!` discharge path
from Priority 3.

What remains are the *index*-returning members, `findIndex` and `indexOf`,
which still return `-1` at runtime and bare `integer` in their signatures. Note
these return an index, so the honest type is `integer | null`, **not**
`T | null`. Decide per function: switch to `integer | null`, or document why
`-1` stays. Either way `docs/language.md` still documents `-1` (the `indexOf`
row and the `findIndex` row).

Any change here is a behavior change, so it needs runtime + signature + docs +
conformance-case updates together.

Files: `typescript/src/stdlib.ts`, `spec/builtins.json`, `docs/language.md`,
`spec/cases/`.

## Scope note

This is precision, not new type-system capability — no new schema constructs.
Keep each signature within the tractable fragment the shorthand gate emits.
Note the one caveat above: `fromEntries`/`values`/`entries` precision needs a
small `CODE_RETURNS` rule (or a tuple/object case in `unifyTemplate`) because
the current template resolver can't bind a var inside a tuple or object — this
is engine plumbing, not a new schema construct.

## Landing checklist

- `fromEntries` projects the value type into `additionalProperties` (via a
  `CODE_RETURNS` rule or an extended `unifyTemplate`).
- Object-producing builtins audited (`merge` already done); `values`/`entries`
  bare returns reduced where feasible.
- `findIndex`/`indexOf` sentinel decision made (`integer | null` or keep `-1`)
  and, where changed, signatures + runtime + docs + conformance cases updated
  together. (`find` already returns `T | null`.)
- `builtins.test.ts` green.
