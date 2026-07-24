# `$let` Phase 4: canonical migration and architectural cleanup

This document expands Phase 4 of `plans/active/let.md` into an implementation
plan for the canonical TypeScript implementation.

Phases 1–3 established native `$let` evaluation, `$captures`, checker letrec
scopes, and `$let`-based shorthand parsing and printing. Phase 4 is the point
where the transition ends. It migrates the remaining direct canonical JSON,
deletes the old binding model, closes the function-body schema, simplifies the
code that had to infer locals from arbitrary keys, and updates the reference
documentation.

The cleanup is not secondary to the migration. The reason for introducing an
explicit binding node was to make the implementation smaller and easier to
reason about. A Phase 4 result that merely converts fixtures while preserving
the old scans, branches, scope layers, and terminology has not delivered the
architectural goal.

## Current baseline

The relevant commits are:

- `871c394` — Phase 1 evaluator, `$captures`, and definition-owned function
  environments;
- `bc80fb0` — Phase 2 checker and explicit letrec type scopes;
- `d65d7c7` — checker shadowing corrections;
- `a156d49` — Phase 3 parser/printer cutover.

At this boundary:

- shorthand `where` and pure `do` bindings already emit `$let`;
- parser-produced function bodies are structural;
- the printer consumes `$let` and rejects historical body locals;
- direct canonical evaluator fixtures still contain the old representation;
- evaluator and checker adapters still interpret arbitrary function-body keys
  as locals;
- closure traversal still carries body-key skip lists for those adapters;
- tests and performance helpers still construct old bodies directly;
- `docs/language.md` and `docs/shorthand-spec.md` still describe the old model.

The TypeScript baseline is green:

```text
bun run check
bun test

2026 pass
0 fail
```

A structural scan of `spec/` found:

- 1,299 objects recognized as function bodies;
- 145 function bodies with non-structural sibling keys;
- those bodies occur in 26 `spec/cases/*.json` files;
- five call sites use the historical zero-argument binding-IIFE shape;
- no affected shared fixture has a parameter/default dependency on one of its
  inline locals;
- no affected shared fixture has a parameter/local name collision.

The last two facts are important. Moving body locals under `$return.$let`
changes their relationship to parameter defaults and parameter shadowing. The
shared fixture corpus is mechanically migratable only because it does not
exercise those ambiguous cases. The migration script must verify those
preconditions rather than assuming them.

## Deliverable

At the end of Phase 4:

- every canonical expression-local binding in shared fixtures and TypeScript
  tests uses `$let`;
- no binding-shaped IIFE remains;
- function bodies have a closed structural schema;
- evaluator and checker reject stray function-body keys;
- `callJSONFunction` has no legacy-body branch;
- the checker has no `bindingKeys`, `legacyFunctionBindings`, or legacy letrec
  layer;
- closure substitution and name-reference scanning operate on structural
  fields instead of skip lists;
- `FunctionBody` no longer has an open index signature;
- source, portable runtime, and module-only structural fields are distinguished
  explicitly;
- parser and printer retain only the Phase 3 `$let` model;
- docs describe `$let` as the sole expression-local binding form and describe
  the module registry separately;
- conformance coverage includes the final scoping, recursion, escape, and
  call-depth regressions;
- the production TypeScript source touched by this migration is materially
  smaller than at the end of Phase 3.

## Non-goals

Do not include:

- a compatibility evaluator or checker for old canonical JSON;
- a permanent `jfn migrate` command;
- quoted shorthand binding names;
- binding annotations;
- a redesign of lazy letrec, narrowing, or capture semantics;
- removing the module registry or lowering modules to `$let`;
- replacing serializable `$captures` with host-only closures;
- removing definition-owned function environments;
- changing generic user-authored IIFE behavior;
- porting Go, Python, or Rust;
- unrelated checker, evaluator, or shorthand refactors.

Breaking old direct canonical JSON is intentional after the repository-owned
data has been migrated.

## Cleanup standard and LOC goal

Use code size as a design signal, not as a quota that justifies obscure code.
Measure physical source lines before and after the phase for:

- `typescript/src/eval/interpreter.ts`;
- `typescript/src/eval/closures.ts`;
- `typescript/src/check/checker.ts`;
- `typescript/src/check/context.ts`;
- `typescript/src/check/builtin-rules.ts`;
- any new shared function-body structure module.

The Phase 3 baseline for the four largest migration files is:

```text
interpreter.ts   816
closures.ts      399
checker.ts      1398
context.ts       176
```

The pre-migration versions were smaller, but the new implementation also owns
real behavior that did not exist there: canonical `$let` validation,
serializable `$captures`, definition-owned dispatch, and checker support for
explicit recursive scopes. Comparing totals alone therefore overstates the old
system's simplicity.

Hard acceptance criteria:

1. Phase 4 must delete more production source than it adds.
2. The evaluator/checker/closure cleanup should remove roughly 100–130 net
   lines from the Phase 3 source baseline.
3. No new generic abstraction should exist solely to hide the same old
   key-inference loop.
4. Record the before/after counts in the implementation commit or PR.

If the result is not materially smaller, stop and inspect which old assumption
is still encoded. Likely causes are a surviving compatibility path, duplicated
body validation, or function parameters still being routed through the full
letrec engine.

## Invariants that must remain

Cleanup must preserve:

1. `$let` bindings are lazy, memoized, mutually recursive, and cycle-checked.
2. A nested `$let` shadows parameters, captures, and outer bindings.
3. Function-valued `$let` siblings dispatch recursively without cyclic JSON.
4. Escaping closures serialize required local functions under `$captures`.
5. `$captures` are visible to parameter defaults and `$return`.
6. Persistent module functions remain registry-backed and are not attached.
7. Registry dispatch restores the callee definition's environment.
8. A direct function value never inherits a caller's lexical variables.
9. Parameter defaults remain lazy and retain their existing parameter rules.
10. `$let` consumes expression fuel but no call frame or call-shaped fuel.
11. A genuine zero-argument IIFE remains a genuine function call.
12. `$raw` payloads remain opaque to migration, validation walks, substitution,
    and shorthand reconstruction.

## The final function-body model

Centralize the vocabulary for function-body fields. Do not keep independent
skip lists in evaluator, checker, closure, and printer code.

### Source structural fields

Authoring-level canonical function bodies may contain:

- `$return` — required;
- `$params` — optional;
- `$sig` — optional;
- `$comment` — optional and string-valued.

### Portable runtime structural fields

Evaluator-produced function values may additionally contain:

- `$captures` — serialized named function definitions;
- `$runtimeContract` — serialized evaluator-owned function boundary state.

`$captures` and `$runtimeContract` are not local-binding forms and are not
printable shorthand. They need explicit validation or rejection appropriate to
each boundary. In particular, the printer must not silently erase either.

### Module-only fields

`$types` is a module-root field. It is not a function-body field. Its presence
in old evaluator skip lists reflects the old open-schema architecture and must
not cause Phase 4 to bless it as permanent body metadata.

### Recognition versus validation

Keep a cheap discriminant that recognizes an object containing `$return` as a
function-body-shaped expression so malformed bodies receive function-specific
diagnostics. Add a separate structural validator rather than making malformed
bodies fall through as generic data.

The final validation rules are:

- `$return` is present;
- only the allowed source/runtime keys are present;
- `$comment`, when present, is a string;
- `$params` has a valid parameter layout;
- `$captures`, when present, is a non-null object of function bodies;
- `$runtimeContract`, when present, satisfies its existing internal reader;
- unknown ordinary and unknown reserved keys are errors.

The evaluator must validate both expression-position functions and functions
passed directly to `callFunction` or reached through a registry. The checker
must report one diagnostic at each stray key. The printer retains its stricter
authoring boundary.

## Canonical migration

### One-off script

Create a temporary Bun script, for example:

```text
typescript/scripts/migrate-canonical-let.ts
```

The script supports:

```text
--check   inventory and validate without writing
--write   rewrite the selected JSON files
```

It should accept explicit paths or globs, print per-file transformation counts,
and fail on an ambiguous shape. It is a repository migration tool, not a
product command, and is deleted before Phase 4 is complete.

Use parsed JSON and normal serialization/formatting. Do not perform textual
replacement.

### Walk rules

The walk is recursive and bottom-up, with two shape-aware exceptions:

1. Stop at canonical `$raw`; do not inspect or rewrite its payload.
2. Detect a historical binding IIFE before independently converting its callee
   body.

Walk arrays in order and object entries in insertion order.

### Historical body-local transform

For a function body:

```json
{
  "$params": ["x"],
  "a": "<expr-a>",
  "b": "<expr-b>",
  "$return": "<result>"
}
```

produce:

```json
{
  "$params": ["x"],
  "$return": {
    "$let": {
      "a": "<migrated-expr-a>",
      "b": "<migrated-expr-b>"
    },
    "$in": "<migrated-result>"
  }
}
```

Preserve binding order. Recursively migrate each binding expression and the
result.

If the old `$return` is already a `$let`, nest the new outer `$let`; do not
merge. The old body locals and the return expression's let have distinct scope
boundaries. Flattening can change shadowing and recursive references.

### Historical binding-IIFE transform

Transform only the exact old binding encoding:

```json
{
  "$call": {
    "a": "<expr-a>",
    "b": "<expr-b>",
    "$return": "<result>"
  },
  "$args": []
}
```

to:

```json
{
  "$let": {
    "a": "<migrated-expr-a>",
    "b": "<migrated-expr-b>"
  },
  "$in": "<migrated-result>"
}
```

Require:

- exact call shape;
- an empty argument array;
- a callee function body with at least one inline local;
- no meaningful parameters or signature;
- no runtime-only function metadata.

Do not rewrite a structural zero-argument function call. This distinction is
why the IIFE pass must run before generic function-body migration.

### Migration preconditions

Before rewriting a body, analyze its parameter layout and defaults.

Fail with a path and require manual handling when:

- an inline-local name collides with a bound parameter name;
- a parameter or destructured-field default refers to an inline local through
  `$var`, `$fn`, or a literal `$call`;
- a reserved unknown key appears;
- `$comment` is non-string;
- `$types` appears on a function body;
- the object is otherwise ambiguous between malformed syntax and an old local.

Why: old inline locals shared a function frame with parameter defaults, while a
new `$let` nested under `$return` is entered only after defaults are evaluated.
Also, old supplied parameters took precedence in the combined frame, while an
inner `$let` shadows parameters. A blind rewrite is not semantics-preserving in
those cases.

The current shared fixture inventory has no default/local dependencies or
parameter/local collisions, so these checks should pass there. Unit tests that
deliberately exercise old default/local behavior must be redesigned around the
new model, usually with an enclosing `$let` or evaluator-owned `$captures`.

### Scope of the data migration

Apply the script to:

- `spec/cases/*.json`;
- any other repository-owned canonical JSON discovered by the structural scan.

Migrate function-shaped expected values as well as executable inputs. Expected
escaping closures are canonical JSON and must describe the new shape.

Do not wrap module roots. Recursing into their named function entries is
correct; converting the module object itself to `$let` is not.

Examples are currently `.jfn` source rather than stored canonical JSON, so they
need parsing verification but no mechanical rewrite.

### Parse-case regeneration audit

`spec/parse-cases` is generated conceptually from each case's `source` field.
Phase 3 already updated the directly affected expectations. Phase 4 still runs
a full regeneration audit:

1. parse every non-error `source`;
2. replace its `expected` value in memory;
3. serialize and format all suites;
4. inspect the complete diff.

The expected diff is empty unless Phase 4 intentionally changes parser
validation. A non-empty diff is evidence of missed Phase 3 output or an
accidental parser change.

Do not run the canonical body migrator over parse expectations as a substitute
for regeneration.

### Script disposal

After:

- the migration diff has been reviewed;
- all migrated cases pass;
- postcondition scans return zero;

delete the script. Preserve the algorithm in this plan and git history, not as
a supported CLI.

## TypeScript test and performance-data migration

Direct TypeScript object literals are not covered by the JSON migration script.
Update them before deleting compatibility paths.

### Test constructors

Refactor helpers that currently emit:

```ts
{ $sig, $params, ...locals, $return: result }
```

to emit:

```ts
{
  $sig,
  $params,
  $return:
    Object.keys(bindings).length === 0
      ? result
      : { $let: bindings, $in: result },
}
```

Relevant starting points include:

- `typescript/test/check/checker.test.ts`;
- `typescript/test/check/chess.test.ts`;
- `typescript/test/check/builtins.test.ts`;
- `typescript/test/let-eval.test.ts`;
- `typescript/test/parameter-defaults.test.ts`;
- `typescript/test/module-scope.test.ts`.

Do not mechanically convert tests whose purpose was the legacy behavior. Keep
the useful semantic assertion and express it through the final model, or delete
it when the canonical `$let` suite already covers it.

### IIFE tests

Split old checker sections that mix two concerns:

- local-binding semantics move to direct `$let` tests;
- generic inline-call contextual typing remains on structural function bodies.

Retain coverage for parameterized and zero-argument real IIFEs, arity,
defaults, rest parameters, contextual return checking, and narrowing. Remove
comments and test names that call an IIFE the checker representation of
`where`.

### Performance fixtures

`typescript/perf/data.ts` and `typescript/perf/suites/closures.ts` still build
`{ $params, ...locals, $return }`. Convert those helpers and callers to
`$let`.

This is not only syntax churn. Run closure and recursion performance suites
before and after cleanup. The target path should avoid:

- one call frame for `where`;
- old function-frame local discovery;
- repeated closure scans over arbitrary body entries.

Keep benchmark scenarios equivalent enough to compare counts.

### Negative tests

After migration, old shapes should appear only in explicit rejection tests:

- evaluator rejects a regular stray key;
- evaluator rejects an unknown reserved key;
- checker reports the exact stray-key path once;
- printer rejects the same shapes;
- module roots with ordinary named entries remain valid.

Name these as invalid canonical function-body tests, not legacy compatibility
tests.

## Evaluator cleanup

### Delete the function-body adapter

In `typescript/src/eval/interpreter.ts`:

- delete `legacyFunctionBindings`;
- delete `bindLegacyFunctionFrame`;
- delete the `TODO(let-phase4)` branch in `callJSONFunction`.

The final invocation path is:

1. validate the structural function body;
2. read/enforce any runtime contract;
3. validate arguments;
4. seed `$captures`;
5. bind parameters and defaults;
6. evaluate `$return`.

There is no scan of body siblings and no merge of parameters with body locals.

### Re-evaluate the frame API

After deleting the adapter, inspect `createLazyFrame` based on its actual three
callers:

- parameter/default binding;
- expression `$let`;
- module initialization.

Keep one low-level lazy engine only where it removes real duplication. Its
policy should express the surviving distinction directly:

- `$let` function bindings are attachable;
- module function bindings are persistent and non-attachable;
- parameter defaults are parameter bindings, not body-local discovery.

Remove exported types or policy wrappers that no external caller needs. Do not
merge the semantic entry points merely to save lines.

### What remains

Do not remove or weaken:

- `evaluateLet`;
- lazy memoization/cycle detection;
- function-valued binding registration;
- `seedFunctionCaptures`;
- `function-environments.ts`;
- module-specific initialization;
- `localFns` versus `attachFns`.

`localFns` and `attachFns` are not duplicate sets: module functions are local
registry names but intentionally non-attachable.

## Checker cleanup

### Delete body-local discovery

In `typescript/src/check/context.ts`,
`typescript/src/check/checker.ts`, and
`typescript/src/check/builtin-rules.ts`:

- delete `bindingKeys`;
- delete `legacyFunctionBindings`;
- remove its export/import;
- remove the `legacyBindings` argument from `buildFunctionTypeScope`;
- remove all call-site scans in `checkBody`, `inlineCallBodyContext`, and
  `inferLambdaReturn`.

The function checker must never construct a letrec scope by subtracting
structural fields from a body.

### Simplify function scope construction

Today `buildFunctionTypeScope` routes legacy locals plus eager parameter types
through `buildLetrecTypeScope`. Once legacy bindings are gone, inspect whether
an empty lazy-binding map is still justified.

The desired structure is:

1. build the recursive capture type scope;
2. overlay eager parameter types with a small lexical environment extension;
3. check parameter defaults in that completed environment;
4. check the structural `$return`;
5. let an actual `$let` node create its own letrec type scope.

If an eager environment helper is clearer and smaller than invoking the full
letrec engine with no expression bindings, add it and remove the now-unused
`initialEager` parameter from `buildLetrecTypeScope`.

Keep:

- lazy and fact-keyed memoization for real `$let` and module constants;
- cycle recovery;
- named boolean guards;
- creation-site and forcing-site narrowing;
- `withoutShadowedNarrowings`;
- eager function signatures for recursive function bindings;
- module-specific scope construction.

### Closed-body diagnostics

Run structural validation before scope construction in `checkBody`.

For each unsupported key:

- report once at `at(ctx, key)`;
- do not add it to the term environment;
- do not recursively check it as a nested local function;
- continue checking supported fields where recovery is safe.

Update assertions that previously expected paths such as `main.helper` to the
canonical `main.$return.$let.helper` path.

## Closure cleanup

`typescript/src/eval/closures.ts` contains the largest remaining structural
assumption from the old model.

### `replaceVars`

For a structural function body, the names it binds directly are:

- names bound by `$params`;
- names in `$captures`.

They are not `Object.keys(body)` minus a skip list.

Remove:

- arbitrary body-key local-name discovery;
- special skips for `$types`;
- scanning body siblings for function-valued locals.

Continue to:

- mask parameters and captures from outer substitution;
- traverse defaults, `$return`, and capture definitions;
- keep `$let` as its own recursive masking boundary;
- attach referenced enclosing local functions to an escaping body.

### Function-name reference scans

Replace the generic body-entry loop in `scanBodyLevelFnNameRefs` with explicit
traversal of:

- parameter default expressions;
- `$return`;
- each valid `$captures` definition, transitively and cycle-safely.

No body-local expression keys remain.

### Attachment

`attachFreeLocalFns` remains necessary. Simplify its comments and bound-name
logic to talk about parameters and captures rather than “params and locals.”

Keep:

- transitive attachment;
- mutual-recursion cycle safety;
- value-size and fuel accounting;
- cached scans/counts for stable definitions;
- exclusion of persistent module functions.

Do not interpret the removal of inline body locals as permission to inline
recursive function definitions into one another.

## Type tightening

After source and tests use structural bodies, remove the open index signature
from `FunctionBody` in `typescript/src/types.ts`.

The type should name:

- `$return`;
- optional `$params`;
- optional `$sig`;
- optional `$comment`;
- optional `$captures`;
- optional internal `$runtimeContract`.

Use the most specific existing types that do not introduce import cycles.
Avoid replacing the index signature with widespread `as any` casts. If a
caller genuinely accepts arbitrary JSON, type that local boundary as a JSON
object and validate before treating it as `FunctionBody`.

Tightening is complete when parser construction, checker/evaluator access, and
tests compile without an escape hatch that recreates open bodies.

## Shared structural helpers

A small `typescript/src/function-body-structure.ts` is justified if it removes
the current repeated sets and validation logic. It may own:

- source field names;
- runtime-only field names;
- allowed structural field names;
- a pure shape analysis result used by throwing and diagnostic callers.

It must not:

- infer locals from unsupported keys;
- include `$types`;
- contain checker-specific diagnostics;
- contain shorthand rendering policy;
- conflate “recognized as body-shaped” with “valid body.”

The printer may retain a smaller printable subset, ideally derived from the
source field set plus explicit runtime-field rejection.

Do not centralize `$let` validation unless the resulting pure helper is
actually smaller and clearer across evaluator, checker, and printer. Their
error-handling contracts differ, so duplication of a few direct checks may be
preferable to a generic validation framework.

## Parser and printer audit

No Phase 4 representation change is expected in the shorthand layer.

Verify and keep:

- one `buildLet` constructor;
- one structural function-body constructor;
- `$let`-based pure-`do` lowering;
- `$let`-based `do` reconstruction;
- genuine IIFE rendering;
- `$captures` rejection;
- `$raw` opacity.

Search for and remove any surviving terminology or dead helper related to:

- `buildScope`;
- `objectLocals`;
- IIFE lowering of `where`;
- continuation sibling locals;
- non-`$` function-body scans.

If central structural validation makes printer code smaller, share the field
definitions but preserve printer-specific errors and printability rules.

## Documentation

### `docs/language.md`

Add or rewrite sections to specify:

- canonical `$let`/`$in` shape;
- exact two-key outer form and non-empty binding map;
- lazy, memoized, recursive, cycle-checked semantics;
- shadowing and parameter visibility;
- function-valued binding dispatch;
- structural function-body fields;
- `$captures` as runtime closure state, not authoring locals;
- closure substitution across `$let`;
- module root as a distinct persistent registry;
- call-depth and fuel behavior.

Delete statements that:

- every non-`$return`/`$params` body key is a local;
- function bodies and modules have the same shape;
- closures attach functions as sibling body keys;
- local scope is introduced by arbitrary function-body keys.

### `docs/shorthand-spec.md`

Update:

- `where` canonical examples to `$let`/`$in`;
- function-body `where` to `$return.$let`;
- leading and continuation pure `do` lowering to `$let`;
- printer reconstruction descriptions;
- text that currently says expression `where` uses an IIFE;
- text that currently says pure bindings become continuation body siblings.

The `.jfn` grammar does not change.

### Other docs

Search `docs/`, active plans, and test comments for stale descriptions. Update
reference material and directly misleading comments. Do not expand Phase 4
into a general README refresh; workspace guidance already identifies `docs/`
as the source of truth.

## Conformance and regression coverage

The migrated corpus provides broad compatibility coverage, but add explicit
canonical cases for the final model.

### Evaluation

Cover or retain:

- lazy unused binding;
- memoization;
- parent parameter capture;
- parameter and nested-let shadowing;
- direct and indirect value cycles;
- recursive and mutually recursive local functions;
- `$var` and `$fn` access to function-valued bindings;
- escaping and serialized closures with `$captures`;
- transitive and mutually recursive captures;
- captures used by parameter defaults;
- rebound local function names in nested lambdas;
- stale-frame and Dijkstra regressions;
- `$let` fuel and call-depth behavior;
- module functions excluded from captures.

Use shared `spec/cases` where portable. Keep host-counter memoization,
performance counters, and exact runtime metadata in TypeScript tests.

### Checking

Cover or retain:

- lazy recursive type lookup;
- creation-site and forcing-site narrowing;
- named guards;
- function-binding shadowing;
- cycle diagnostics;
- `$let.<name>` and `$in` paths;
- captures visible to defaults and return;
- malformed captures;
- stray body keys;
- real structural IIFEs;
- module entry and `$types` behavior.

### Structural negative matrix

Add aligned evaluator/checker/printer tests for:

- regular stray key;
- unknown `$` key;
- body-level `$types`;
- non-string `$comment`;
- malformed `$captures`;
- malformed `$runtimeContract` where that boundary accepts runtime bodies.

The parser cannot emit these shapes, but direct canonical JSON must fail
consistently.

## Implementation sequence

Keep the branch green in this order:

1. Record baseline tests, inventory, source LOC, and focused performance
   counters.
2. Write the migration script and land its `--check` assertions.
3. Migrate `spec/cases`, format, inspect hotspots, and run conformance tests
   while legacy adapters still exist.
4. Regenerate every parse-case expectation and confirm the audit is empty.
5. Migrate TypeScript test constructors, direct literals, and performance
   fixtures.
6. Add shared function-body field vocabulary and structural validation.
7. Enable evaluator/checker stray-key rejection.
8. Delete evaluator legacy body binding and simplify `callJSONFunction`.
9. Delete checker body-key discovery and simplify function scope construction.
10. Simplify closure substitution and name-reference scans.
11. Tighten `FunctionBody` and remove casts/indexing enabled only by open bodies.
12. Consolidate or delete redundant structural-key definitions.
13. Rewrite stale tests/comments and trim duplicate IIFE/local-binding coverage.
14. Update language and shorthand reference docs.
15. Add final conformance regressions.
16. Run focused and full verification plus performance comparisons.
17. Run postcondition scans and source LOC comparison.
18. Delete the migration script.

Migration, strict validation, and adapter deletion may be separate commits, but
do not leave a committed state that rejects repository fixtures before they are
migrated.

## File-by-file checklist

### Production source

`typescript/src/eval/interpreter.ts`

- delete legacy binding extraction/frame;
- simplify invocation;
- retain explicit parameter, `$let`, and module entry points;
- use closed-body validation.

`typescript/src/eval/closures.ts`

- remove body skip-list local discovery;
- traverse defaults/return/captures explicitly;
- retain `$let` masking and `$captures` attachment.

`typescript/src/eval/expression-type.ts`

- validate closed function-body shape;
- preserve function-specific diagnostics.

`typescript/src/check/context.ts`

- delete `bindingKeys`;
- move/remove duplicated structural sets;
- refresh old `buildScope` terminology.

`typescript/src/check/checker.ts`

- delete `legacyFunctionBindings`;
- remove legacy scope parameter/layer;
- add stray-key diagnostics;
- simplify eager parameter overlay;
- retain letrec and narrowing semantics.

`typescript/src/check/builtin-rules.ts`

- stop importing/scanning legacy locals;
- retain contextual structural lambda typing.

`typescript/src/check/module.ts`

- update stale local terminology;
- retain module-specific scope and `$types`.

`typescript/src/function-value.ts`

- distinguish body recognition from structural validation.

`typescript/src/types.ts`

- close `FunctionBody`.

`typescript/src/shorthand/parser.ts`

- audit only; no expected representation change.

`typescript/src/shorthand/printer.ts`

- share field vocabulary where useful;
- continue rejecting runtime-only/unrecognized body fields.

`typescript/perf/data.ts`, `typescript/perf/suites/closures.ts`

- stop constructing inline body locals;
- preserve comparable benchmark scenarios.

### Tests and fixtures

- `spec/cases/*.json` — mechanical migration plus review;
- `spec/parse-cases/*.json` — regeneration audit;
- `typescript/test/let-eval.test.ts` — remove legacy-body case;
- `typescript/test/let-check.test.ts` — final semantic matrix;
- `typescript/test/check/checker.test.ts` — split binding from real IIFE tests;
- `typescript/test/check/chess.test.ts` — structural helper;
- `typescript/test/check/builtins.test.ts` — structural callback helper;
- `typescript/test/parameter-defaults.test.ts` — replace old local/default setup
  with captures or enclosing `$let`;
- `typescript/test/module-scope.test.ts` — use `$let` inside function returns;
- `typescript/test/prepared-program.test.ts` — retain exact `$captures` checks;
- `typescript/test/parse-spec.test.ts` — retain no-historical-shape assertion;
- `typescript/test/print-spec.test.ts` — retain rejection/round-trip matrix.

### Documentation

- `docs/language.md`;
- `docs/shorthand-spec.md`;
- directly stale comments and active-plan cross-references.

## Verification

From `typescript/`:

```bash
bun run check
bun test
```

Focused suites:

```bash
bun test test/spec.test.ts
bun test test/parse-spec.test.ts
bun test test/print-spec.test.ts
bun test test/let-eval.test.ts
bun test test/let-check.test.ts
bun test test/prepared-program.test.ts
bun test test/parameter-defaults.test.ts
bun test test/interpreter-performance-regressions.test.ts
bun test test/check/checker.test.ts
bun test test/check/chess.test.ts
bun test test/check/builtins.test.ts
bun test test/cli-eval.test.ts
bun test test/cli-check.test.ts
```

Performance:

```bash
bun run perf
```

CLI smoke:

```bash
bun run src/cli.ts to-json \
  'double(n) where { double: (x) => x * 2 }'

bun run src/cli.ts to-shorthand \
  '{"$let":{"x":1},"$in":{"$call":"add","$args":[{"$var":"x"},2]}}'
```

Repository searches:

```bash
rg 'legacyFunctionBindings|bindLegacyFunctionFrame|bindingKeys' typescript/
rg 'TODO\(let-phase4\)' typescript/
rg 'objectLocals|buildScope' typescript/src typescript/test typescript/perf
rg 'IIFE.*where|where.*IIFE|binding IIFE' typescript/ docs/
rg '\.\.\.locals' typescript/test typescript/perf
```

Run a structural JSON audit rather than relying only on text searches. It must
report:

```text
function bodies with unsupported keys: 0
binding-shaped IIFEs: 0
```

Treat `$raw` as opaque and module roots as registries in that audit.

The root `./test-all.sh` is not a required green gate for this TypeScript-first
canonical cutover: lagging Go, Python, and Rust implementations may fail shared
`$let` fixtures until they port the feature. Run it only to record the expected
cross-implementation fallout, not to justify restoring old encodings.

## Acceptance checklist

- [ ] Shared canonical JSON contains no inline function-body locals.
- [ ] Shared canonical JSON contains no binding-IIFE encoding.
- [ ] Parse-case regeneration was performed and reviewed.
- [ ] Test and performance helpers cannot construct old bodies accidentally.
- [ ] Evaluator rejects every stray function-body key.
- [ ] Checker reports every stray function-body key once at its exact path.
- [ ] Printer still rejects non-printable runtime function state.
- [ ] `callJSONFunction` has one structural path.
- [ ] Checker function scope has captures plus parameters, not body-key letrec.
- [ ] Closure traversal names structural fields directly.
- [ ] `FunctionBody` has no open index signature.
- [ ] `$types` remains module-only.
- [ ] `$captures` survive JSON serialization and parameter-default lookup.
- [ ] Module functions remain persistent and non-attachable.
- [ ] Genuine IIFEs still evaluate, check, print, and round-trip as calls.
- [ ] `where` and pure `do` consume no synthetic call frame.
- [ ] Public docs describe only `$let` for expression-local binding.
- [ ] No Phase 4 compatibility TODO or helper remains.
- [ ] Production source has a meaningful net LOC reduction.
- [ ] TypeScript checks and all tests pass.

## Risks and review hotspots

### Mechanical migration is not universally semantics-preserving

Parameter/default dependencies and parameter/local collisions require manual
redesign. The migration script must reject them. Current shared fixtures are
clear, but direct TypeScript tests contain intentional old-model cases.

### Nested lets must not be flattened

An existing `$return.$let` is inner to the migrated body locals. Preserve that
scope boundary.

### IIFE detection can destroy real calls

Rewrite only the exact historical binding shape before generic body migration.
Keep explicit real-IIFE regression tests.

### Closure fixtures are shape-sensitive

Review `escaping-closures.json`, `local-recursion.json`, `scoping.json`,
`curry.json`, and exact expected function values manually. A green scalar result
does not prove serialized closure shape is correct.

### Strict validation can drift by boundary

Source, runtime, and module fields are intentionally different sets. A shared
helper should make those categories visible, not collapse them.

### Checker path changes are expected

Inline-body paths become `$return.$let.<name>`. Update exact diagnostic tests
deliberately and ensure `$in` remains the result path.

### Cleanup can accidentally remove required registry machinery

The old body-local adapter is temporary. `$captures`, `localFns`, `attachFns`,
and definition-owned environments are not. Preserve the tests that prove why
each remains.

## Phase completion

Phase 4 closes the transition. There is no legacy canonical input path after
this point.

The intended final architecture is:

```text
parameters/defaults ── function invocation frame
captures            ── serialized function registry state
$let                ── expression-local lazy recursive scope
module root         ── persistent named registry
```

Each construct has one syntax boundary, one evaluator entry point, and one
checker counterpart. Function bodies are records of structure, not scopes
whose meaning depends on subtracting a growing skip list.
