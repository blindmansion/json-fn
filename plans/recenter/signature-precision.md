# Signature-precision work

Overview for §5 of `plans/recenter-plan.md`. Goal: tighten a handful of
builtin signatures that currently return bare, imprecise types. This mostly
fits the existing data-driven builtin design — `spec/builtins.json` edits plus
`$tvar` templates — but the object-producing cases (§1, §2) need a small
`CODE_RETURNS` code rule because the template resolver can't bind a type
variable nested inside a tuple or object. See each section for specifics.

## 1. `fromEntries` precise return — DONE

`fromEntries : ([string, V][]) -> { [string]: V }` now projects the pair's
second element into `additionalProperties`, so `fromEntries([["a", 1]])` types
as `{ [string]: integer }`.

Implemented as a `CODE_RETURNS` entry in `builtin-rules.ts` (the return-recompute
escape hatch `merge` uses), **not** a plain `$tvar` template: `unifyTemplate`
can't bind a var nested inside a tuple/object, so a template like
`array items [string, V]` never binds `V` and collapses to `any`. A
`pairValueType` helper pulls `V` from the entry element (tuple second slot,
homogeneous array element, or a per-arm union join) and the rule returns
`{ type: "object", additionalProperties: V }`, degrading to a bare object when
`V` is unknown.

The param stays permissive (`{ "type": "array" }`), *not* the strict
`[string, V][]` from the target signature: a closed 2-tuple param would reject
`fromEntries(entries(obj))`, since `entries` yields an open `array items array`.
All the precision lives in the return.

Files touched: `typescript/src/check/builtin-rules.ts` (`CODE_RETURNS` +
`pairValueType`), tests in `typescript/test/check/builtins.test.ts`.

## 2. Audit sibling object-producing builtins — DONE

`merge` was **already done** — it returns the structural spread of its operands
via the `CODE_RETURNS['merge']` rule, not a bare `object`.

`values` and `entries` are **now done too**. They were the remaining bare ones
(`values` returned a bare `array`, `entries` an `array items array`). Both want
the object's value type `V` — which hit the *same* missing-object-case gap in
`unifyTemplate` as `fromEntries` (§1), so they also take a `CODE_RETURNS` rule
rather than a template. A new `objectValueType` helper in `schema.ts` (the
inverse of `pairValueType`) joins a closed object's declared property value
types with its map's `additionalProperties` value, degrading to `any` for an
open object. `values` returns `V[]`; `entries` returns `[string, V][]`, so
`fromEntries(entries(map))` now round-trips the value type. An open object (no
precise `V`) degrades each back to its bare floor.

The params stay permissive (`{ "type": "object" }`); all the precision lives in
the return, matching `fromEntries`.

Files touched: `typescript/src/check/schema.ts` (`objectValueType`),
`typescript/src/check/builtin-rules.ts` (`CODE_RETURNS`), tests in
`typescript/test/check/builtins.test.ts`.

## 3. Stdlib pressure away from `-1` sentinels — DONE

`find` was **already done**: it returns `T | null` in both the runtime and its
signature (`anyOf [T, null]`), pairing with the narrowing/`!` discharge path
from Priority 3.

The *index*-returning members `findIndex` and `indexOf` are **now done too**:
both return `integer | null` (`null` on "not found"), replacing the `-1`
sentinel. The honest type is `integer | null`, **not** `T | null`, since they
return an index. This was a behavior change touched across all the required
layers together:

- **runtime** (`typescript/src/stdlib.ts`): `findIndex` returns `null` instead
  of `-1`; `indexOf` maps its `-1` (array `findIndex` / string `indexOf`) to
  `null`.
- **signatures** (`spec/builtins.json`): both returns → `anyOf [integer, null]`.
- **docs** (`docs/language.md`): the `indexOf` and `findIndex` rows now say
  `null` if missing.
- **conformance cases** (`spec/cases/search-quantify.json`,
  `array-accessors.json`): the not-found / empty expectations flipped from `-1`
  to `null`.
- **examples**: the `-1` idioms were rewritten — `>= 0` "found?" checks became
  `!= null` (`calc.jfn`, `chess`), a `< 0` guard became `== null` (`life.jfn`),
  an `== -1` check became `== null` (`chess` `isInCheck`), and an
  always-found arithmetic site took an `!` (`poker.jfn` `rankValue`). Runtime
  spot-checks confirm the rewrites behave identically for the found case and
  degrade to `null` cleanly.

Note the Go/Python/Rust runtimes still return `-1` (they're known out of spec);
only TypeScript + the shared spec/docs/examples were updated, per AGENTS.md.

## Scope note

This is precision, not new type-system capability — no new schema constructs.
Keep each signature within the tractable fragment the shorthand gate emits.
Note the one caveat above: `fromEntries`/`values`/`entries` precision needs a
small `CODE_RETURNS` rule (or a tuple/object case in `unifyTemplate`) because
the current template resolver can't bind a var inside a tuple or object — this
is engine plumbing, not a new schema construct.

## Landing checklist

- [x] `fromEntries` projects the value type into `additionalProperties` (via a
  `CODE_RETURNS` rule).
- [x] Object-producing builtins audited (`merge` already done); `values`/
  `entries` now project the object's value type (`V[]` / `[string, V][]`) via
  `CODE_RETURNS` + `objectValueType`.
- [x] `findIndex`/`indexOf` switched to `integer | null` (dropping the `-1`
  sentinel) with signatures + runtime + docs + conformance cases + examples
  updated together. (`find` already returned `T | null`.)
- [x] `builtins.test.ts` green.
