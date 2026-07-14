# Priority 2 — Bidirectional `check()` + structured diagnostics

Overview for §3 of `plans/recenter-plan.md`. Goal: make `check()` actually
push expected types structurally into composite literals (real bidirectional
checking), and expose diagnostics as machine-readable records. Together these
fix a whole family of filed findings and sharply cut repair-iteration count.

## Current state

The `synth`/`check` seam already exists in `checker.ts`, but `check()` is
essentially synth-then-subsume:

```578:586:typescript/src/check/checker.ts
function check(expr: JSONType, expected: Schema, ctx: CheckContext): void {
  // Un-annotated inline lambdas need contextual typing (later milestone); we
  // can't yet check their bodies against `expected`, so defer silently rather
  // than emit a spurious `any ⊄ (fn)` diagnostic.
  if (nodeKind(expr) === "body" && sigOf(expr as Record<string, JSONType>) === null) return;

  const actual = synth(expr, ctx);
  if (!isSubschema(actual, expected, ctx.defs)) reportMismatch(ctx, actual, expected);
}
```

The only real check-mode today is `inferLambdaReturn` at builtin call sites.
Everything else synthesizes then subsumes, which loses locality and never
propagates expectations into un-annotated lambdas.

## Part A — Make `check()` recurse structurally

Fill in check-mode cases in `check()` so the expected type is pushed inward
instead of always deferring to `synth`:

- **Objects** — ✅ done: push expected field types into each field; report
  field-level errors ("field `extra` not permitted", "required field `name`
  missing") instead of dumping both whole schemas.
- **Arrays**: push the expected element type into each element.
- **Branches**: push the expected type into `$if`/`$cond`/`$match` arms, so
  arms are checked (not synthesized-then-unioned) — this also kills the
  literal-union widening cosmetic (`if … then 10 else 20`).
- **Un-annotated lambdas**: push an expected `$fnType` into the lambda in any
  checked position, then check its body against the expected `$return`. This
  replaces the current silent-defer on line 582.
- **`do`-block IIFE**: an inline body callee should propagate its `$return`
  type (synthesize/check the body, return its return type) instead of falling
  through `bodyFnTypeSchema → true → sig === null` and erasing to `any`.

Findings this closes:

- Bare capability-record lambdas synthing to `true` (blocks `thermostat.jfn`'s
  `Device`): the field's expected `() -> Task` finally reaches the lambda.
- Object assignability errors dumping both whole schemas.
- Literal-union widening in branch results.
- `do`-block IIFE erasing to `any`.

Files: `typescript/src/check/checker.ts` (`check`, `checkBody`, the composite
synth cases it mirrors), `typescript/src/check/context.ts`
(`bodyFnTypeSchema` interaction), `typescript/src/check/subsumption.ts`
(reuse structural comparison to locate the mismatching field/element).

**Implementation notes (objects):**

- `check()` now recurses into an object *literal* whenever its expected type
  resolves (through `$ref`) to a single object schema, via `checkObjectLiteral`
  in `checker.ts`. A union / non-object / `any` expected still falls through to
  the exact synth-then-subsume comparison, so nothing regresses.
- Field-level diagnostics: a key the expected type forbids reports at that key's
  path (`Field "k" is not permitted…`); a required key the literal omits reports
  at the object (`Required field "k" is missing.`, with the expected field
  schema attached); a per-field type mismatch reports at the field's path and
  recurses, so nested literals pinpoint the deep field.
- Parity-exact with `objectSubsumes` for object literals (which always
  synthesize to closed objects with every key required) — pass/fail is
  unchanged, only diagnostic locality improves. Covered by the
  `check: bidirectional object literals (Part A)` block in
  `typescript/test/check/checker.test.ts`.
- Still open in Part A: arrays, `$if`/`$cond`/`$match` arms, contextual
  un-annotated lambdas, and the `do`-block IIFE `$return`.

## Part B — `jfn check --json`

Emit the `Diagnostic` records directly as JSON. Everything needed is already
stored on the record:

```19:26:typescript/src/check/context.ts
// A single type diagnostic, with a JSON-ish path to its location (§6).
type Diagnostic = {
  path: string[];
  message: string;
  severity: Severity;
  expected?: Schema;
  actual?: Schema;
};
```

- Add `--json` to the `check` command in `cli.ts` (distinct from the existing
  `--json` *input* flag — pick a non-colliding name or scope it, e.g.
  `--json-diagnostics` / reuse under an output-format flag).
- Serialize the full `Diagnostic[]` (stable `path`, `message`, `severity`,
  `expected`, `actual`).
- Keep prose output as the default.

Files: `typescript/src/cli.ts`.

## Part C — Related diagnostic fixes (same effort tier)

- **Overloaded-builtin failures report all failed overloads** (or the
  nearest), not just the first — `length(123)` never mentions the `string`
  arm today. Files: `typescript/src/check/builtin-rules.ts`.
- **Surface the swallowed type-parse error** in `looksLikeFuncLit` /
  `returnTypeEndsInFatArrow`: the try/catch currently reports a malformed
  return annotation as an unrelated error at the parameter colon. Files:
  `typescript/src/shorthand/parser.ts` (and/or `type-parser.ts`).

## Landing checklist

- `check()` pushes expectations into objects, arrays, branch arms, and
  un-annotated lambdas; object errors are field-level.
  - [x] Objects: field-level errors (extra key, missing required, per-field
    mismatch, nested pinpointing).
  - [ ] Arrays, branch arms, un-annotated lambdas.
- `thermostat.jfn` capability-record lambdas check against `() -> Task`.
- `do`-block IIFE returns its body's `$return` type, not `any`.
- `jfn check --json` emits `Diagnostic[]`.
- Overloaded-builtin failures list all/nearest arms.
- Malformed return annotations report at the annotation, not the param colon.
