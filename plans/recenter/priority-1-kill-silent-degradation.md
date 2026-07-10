# Priority 1 — Kill silent degradation everywhere

Overview for §2 of `plans/recenter-plan.md`. Goal: make the checker
incapable of silently claiming clean when it never actually checked. Every
`→ any` / `→ top` path is either turned into a hard error or made visible via
coverage reporting, so an agent harness can distinguish "checked and passed"
from "wasn't checked at all."

## Why this is first

Small, self-contained, and the biggest trust win. Most changes are localized
guards in the checker rather than new machinery. `jfn check` reporting
`No type errors` on a module the checker never really walked is the single
most damaging failure mode for the agent repair loop.

## Work items

### 1. Dangling `$ref` → hard error — ✅ done

A `$ref` to an undeclared type name currently resolves to top, so
`f: () -> Reprot => true` checks clean. Add a declare-before-use pass over all
`$ref`s reachable from the module.

- Resolve `$ref`s against the merged pool (`builtins.$defs` + module `$types`)
  the same way the checker does at runtime.
- Only *undefined* names error. Keep the intentional `type X = any` alias
  (a name that exists in `$types` but resolves to `true`/`any` is fine).
- Cover `$ref`s in `$sig` params/returns, `$fnType` nodes, `$types` bodies,
  and inline annotations — not just top-level bindings.

Files: `typescript/src/check/module.ts` (new pass in `checkModule`),
`typescript/src/check/schema.ts` (ref resolution/walk helpers),
`typescript/src/check/subsumption.ts` (confirm current resolve-to-top site).

**Implementation notes:**

- `schema.ts` gained `collectSchemaRefs(schema, into)` — a *structural* walk over
  the tractable fragment (`$ref`, `$fnType`, `anyOf`/type-array, array `items`,
  tuple `prefixItems`/rest, object `properties` + map `additionalProperties`). It
  deliberately does **not** descend into `const`/`enum` literal payloads or opaque
  (out-of-fragment) schemas, so a data value carrying a `$ref`-shaped key is never
  mistaken for a type reference.
- `module.ts` gained `checkDanglingRefs`, run at the *top* of `checkModule` (before
  the body walk, so structural errors lead the stream). Types live in exactly two
  positions (per `docs/type-syntax-spec.md` §1), so the pass collects from just
  those rather than blindly scanning term data: the `$types` pool bodies, and every
  `$sig` found by a term-tree walk (`walkSigRefs`) that reaches top-level bindings,
  nested `where`-locals, and inline lambdas (skipping `$raw` payloads).
- The undefined check is `!(name in defs)` against the merged pool, so a
  defined-but-top alias (`type X = any`) is silent by construction — no special
  case needed. `resolveRef`'s permissive missing-def→top behavior was left intact
  (subsumption still depends on it mid-check); detection is a separate up-front pass.
- Diagnostic message: `reference to undefined type "<Name>"`; path is the schema
  root (`["$types", <Def>]` or `[...bindingPath, "$sig"]`).
- Tests: `typescript/test/check/checker.test.ts` → `describe("checkModule: dangling
  $ref → hard error")` (5 cases). Full `bun run check` + `bun test` green (1025
  pass); no dangling-ref fallout across `examples/` (pre-existing `check` failures
  there are unrelated type errors, not from this pass).

### 2. Missing-field access on a closed object → hard error

Accessing a field absent from a closed object silently types as `null`, which
masks typos. Make it an error when the object type is closed
(`additionalProperties: false` / no catch-all) and the key is not present.
Open objects and index-into-map types keep their current behavior.

Files: `typescript/src/check/checker.ts` (the index/member-access synth case,
near `checkIndexKey`), `typescript/src/check/schema.ts` (closed-object /
property-lookup helpers).

### 3. `requireTypedModuleFunctions: true` by default

The flag already exists and is wired in `checkModule`; today an un-annotated
top-level function has its body unchecked and its value is `any`. Flip the
default to on and thread a CLI opt-out.

- Flip default in `CheckModuleOptions` handling in `module.ts`.
- Add a `--allow-untyped-functions` (or similar) escape hatch on
  `jfn check` for the soft-rollout period.
- Expect churn: existing untyped example/spec modules will start erroring.
  Triage — annotate them or opt them out — as part of landing.

Files: `typescript/src/check/module.ts`, `typescript/src/cli.ts`,
affected `examples/*.jfn` and `spec/cases/*`.

### 4. Unknown callee / unknown var — keep degrade, but count + report

These stay as `any` (removing them is out of scope) but must stop being
invisible. Emit an info-tier diagnostic at each site: "expression degraded to
`any` because <reason>."

- Requires an info/`note` severity tier — see coverage reporting below.

Files: `typescript/src/check/checker.ts` (var + call synth cases),
`typescript/src/check/context.ts` (`Severity`).

### 5. Coverage reporting

`jfn check` should report how much of the module was actually checked so a
harness can gate on "fully checked," not just "zero errors."

- Add an `info`/`note` tier to `Severity` in `context.ts` (currently only
  `error` | `warning`).
- Emit one info diagnostic per degradation site (unknown callee/var,
  builtin-absent fallback, any remaining `→ any` path) with a stable reason
  string.
- Summarize in the CLI: count of degradation sites; a non-zero count means
  "not fully checked" even when there are no errors.

Files: `typescript/src/check/context.ts` (`Severity`, `report`),
degradation sites across `checker.ts` / `builtin-rules.ts`,
`typescript/src/cli.ts` (summary line + exit-code policy).

## Out of scope (handled elsewhere)

- `handle` degradation → §6 (annotated `handle`).
- IIFE / `do`-block scope-object call erasing to `any` → §3 (check-mode
  recursion), not fixed here.

## Landing checklist

- [x] Dangling `$ref` errors; `type X = any` alias still clean.
- [ ] Missing closed-object field errors; open/map access unaffected.
- [ ] Untyped top-level functions error by default; opt-out flag works.
- [ ] Every remaining degrade emits a counted info diagnostic.
- [ ] `jfn check` prints a coverage/degradation summary.
- [ ] Retriage `examples/` and `spec/cases/` fallout; `test-all.sh` (TS scope)
  green. *(item 1 introduced no fallout; TS scope green.)*
