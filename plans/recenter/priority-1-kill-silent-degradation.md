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

### 2. Missing-field access on a closed object → hard error — ✅ done

Accessing a field absent from a closed object silently types as `null`, which
masks typos. Make it an error when the object type is closed
(`additionalProperties: false` / no catch-all) and the key is not present.
Open objects and index-into-map types keep their current behavior.

Files: `typescript/src/check/checker.ts` (the index/member-access synth case,
near `checkIndexKey`), `typescript/src/check/schema.ts` (closed-object /
property-lookup helpers).

**Implementation notes:**

- `schema.ts` gained `isClosedMissingKey(target, key, defs)`: resolves through
  `$ref`s and reports whether reading literal string `key` off `target` is a
  *guaranteed* miss — a closed object (or a union whose **every** arm is one)
  that never declares the key. `any`/non-object/open/map targets and a present
  (even optional) key are all *not* misses, so they keep `projectField`'s
  permissive projection untouched.
- Key design call — **unions error only when no arm can supply the key.** A
  union where at least one arm declares the field keeps the honest `T | null`
  projection (the legitimate partial-arm / tagged-union read, already blessed by
  the `synth: field projection over a union` tests); it is *not* silent, so it
  isn't a §2 lie. Only a target where the access can *never* yield a real value
  (single closed object missing it, or all-arms-closed-missing) is the masked
  typo that errors.
- The check fires at the checker call site, not inside `projectField` — that
  helper is a pure schema op shared with flow narrowing and has no `ctx`.
  `checker.ts` gained `reportClosedMissing`, invoked from the `"get"` case for a
  literal string key and, folding left, for each string segment of a static
  `x.a.b` path (so the first segment that can never carry its key is the
  reported one). The narrowing early-return at the top of the `"get"` case still
  wins first, so a narrowed access never spuriously errors.
- Diagnostic: `Field "<key>" does not exist on a closed object type.`
  (`severity: "error"`, `actual` = the object type); path is the `$get` site.
- Tests: `typescript/test/check/checker.test.ts` → `describe("synth: missing
  closed-object field → hard error")` (10 cases). Full `bun run check` + `bun
  test` green (1035 pass); `jfn check` over all 19 `examples/*.jfn` surfaces no
  new closed-missing errors.

### 3. `requireTypedModuleFunctions: true` by default — ✅ done

The flag already exists and is wired in `checkModule`; today an un-annotated
top-level function is walked without a meaningful contract (`any` parameters
and return) and its value is `any`. Flip the default to on and thread a CLI
opt-out.

- Flip default in `CheckModuleOptions` handling in `module.ts`.
- Add a `--allow-untyped-functions` (or similar) escape hatch on
  `jfn check` for the soft-rollout period.
- Expect churn: existing untyped example/spec modules will start erroring.
  Triage — annotate them or opt them out — as part of landing.

Files: `typescript/src/check/module.ts`, `typescript/src/cli.ts`,
affected `examples/*.jfn` and `spec/cases/*`.

**Implementation notes:**

- `module.ts`: the guard flipped from `options.requireTypedModuleFunctions &&
  …` to `options.requireTypedModuleFunctions !== false && …`, so the default
  (option omitted) is now "require". `CheckModuleOptions` doc comment updated
  to describe the new default and the opt-out.
- `cli.ts`: `cmdCheck` gained a `--allow-untyped-functions` boolean flag
  (documented in `--help`) and now always passes an explicit
  `{ requireTypedModuleFunctions: !parsed.flags.has("allow-untyped-functions") }`
  to `checkModule`, rather than relying on the default.
- `checkExpr` (standalone-expression path) is untouched — the option is
  module-only, since a bare expression has no top-level bindings.
- Tests: `typescript/test/check/checker.test.ts` →
  `describe("checkModule: require typed module functions (on by default)")`
  (4 cases: default-on errors, `$sig`-annotated fn unaffected, `false` opt-out
  restores old behavior, nested `where`-locals/inline lambdas stay exempt).
  Full `bun run check` + `bun test` green (1039 pass).
- **Fallout triage (manual `jfn check` over `examples/*.jfn`, not run by
  `test-all.sh`):** 18 of 19 example files gained new
  `module-level function must declare a signature` errors — 309 total, purely
  additive (no other error/warning counts shifted, since an unsigned
  function's params still degrade to `any` rather than cascading new
  mismatches). Only `types.jfn` stayed clean. Three files that were fully
  clean before (`pipeline.jfn`, `report-workflow.jfn`,
  `thermostat-checked.jfn` — the last being the already-tightened thermostat
  rewrite) now have 1, 7, and 3 errors respectively, all from un-annotated
  `demo*`/entrypoint functions. `spec/cases/*` are per-case function bodies
  run through the evaluator conformance suite (`spec.test.ts`), not modules
  ever passed to `checkModule`/`jfn check`, so this pass produces no fallout
  there under current tooling. Triage (annotate or opt out per file) is
  deferred to the landing-checklist retriage item, not done in this pass.

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
- [x] Missing closed-object field errors; open/map access unaffected.
- [x] Untyped top-level functions error by default; opt-out flag works.
- [ ] Every remaining degrade emits a counted info diagnostic.
- [ ] `jfn check` prints a coverage/degradation summary.
- [ ] Retriage `examples/` and `spec/cases/` fallout; `test-all.sh` (TS scope)
  green. *(items 1-2 introduced no fallout; item 3 adds 309 new
  missing-signature errors across 18/19 `examples/*.jfn` files — not yet
  triaged. `spec/cases/*` are eval-only fixtures, never passed through
  `checkModule`, so no fallout there. TS scope (`bun run check` + `bun test`)
  is green regardless, since neither exercises `jfn check` over `examples/`.)*
