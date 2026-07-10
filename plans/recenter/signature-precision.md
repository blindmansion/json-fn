# Signature-precision work

Overview for §5 of `plans/recenter-plan.md`. Goal: tighten a handful of
builtin signatures that currently return bare, imprecise types. This fits the
existing data-driven builtin design cleanly — mostly `spec/builtins.json`
edits plus `$tvar` templates the table already supports.

## 1. `fromEntries` precise return

Today it returns a bare object:

```258:258:spec/builtins.json
    "fromEntries": [{ "params": [{ "type": "array" }], "returns": { "type": "object" } }],
```

Target: `fromEntries : ([string, V][]) -> { [string]: V }` — a `$tvar`
template projecting the pair's second element into `additionalProperties`.
The table already supports `$tvar` templates, so this is a signature edit, not
new engine code.

Files: `spec/builtins.json`. Verify the template resolver in
`typescript/src/check/builtin-rules.ts` / `builtin-types.ts` handles the
projection; add a rule escape hatch only if a plain template can't express it.

## 2. Audit sibling object-producing builtins

While in there, audit the other object-producing builtins returning bare
`{"type":"object"}` and tighten where a template can carry more information
(e.g. `merge`, `values`, `entries` and friends near lines 255–261).

Files: `spec/builtins.json`, tests in `typescript/test/check/builtins.test.ts`.

## 3. Stdlib pressure toward `T | null` over `-1` sentinels

Continue moving the `find`-family (and similar) toward `T | null` return
variants instead of `-1` sentinels, so signatures can be honest and pair with
the narrowing/`!` discharge path from Priority 3.

- Identify sentinel-returning stdlib functions.
- Decide per function: change the runtime contract to `T | null`, or document
  why the sentinel stays.
- Update signatures + runtime + docs together (this is a behavior change, so
  it needs conformance-case updates).

Files: `typescript/src/stdlib.ts`, `spec/builtins.json`, `docs/language.md`,
`spec/cases/`.

## Scope note

This is precision, not new type-system capability — no new schema constructs.
Keep each signature within the tractable fragment the shorthand gate emits.

## Landing checklist

- `fromEntries` projects the value type into `additionalProperties`.
- Object-producing builtins audited; bare `{"type":"object"}` reduced.
- `find`-family sentinel decisions made and, where changed, signatures +
  runtime + docs + conformance cases updated together.
- `builtins.test.ts` green.
