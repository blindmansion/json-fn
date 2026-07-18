# Evaluator and runtime reorganization

Status: active. Phases 0–5 completed 2026-07-18.

## Summary

The TypeScript evaluator is conceptually well separated from the checker and
shorthand frontend, but it is physically concentrated in
`typescript/src/evaluate.ts`. That file currently owns the public evaluation
API, execution state and limits, function dispatch, lexical scope construction,
expression evaluation, closure capture, property access, and expression
classification.

This refactor should create an `eval/` directory around the synchronous
interpreter while preserving the current public API and behavior. It should
extract genuinely independent concerns, but it should not split the mutually
recursive evaluator, function caller, and lazy scope builder merely to reduce
line count.

The refactor also needs a clear architectural boundary:

> The evaluator accepts canonical JSON plus a function registry and
> synchronously returns JSON.

Async capabilities, environment policy, task persistence, file loading, CLI
behavior, and registry construction are embedding concerns outside the
evaluator.

The TypeScript implementation is the canonical and only implementation in scope
for this reorganization.

## Goals

- Give synchronous evaluation a clear `src/eval/` home comparable to `check/`
  and `shorthand/`.
- Reduce `evaluate.ts` into focused modules with explicit dependency direction.
- Preserve `callFunction`, `callProgram`, `prepareProgram`, and
  `createPerfStats` as the stable public evaluator API.
- Consolidate duplicated execution setup shared by the three entry paths.
- Keep expression evaluation, call dispatch, and lazy scope construction
  together while they remain one recursive component.
- Make the evaluator/embedding boundary explicit for future runtime work.
- Use `blast` for safe module/declaration moves, import rewrites, graph
  inspection, and impacted-test selection.
- Keep every stage behavior-preserving and independently verifiable.

## Non-goals

- Changing language semantics or canonical JSON forms.
- Changing evaluator public signatures.
- Reworking the checker or attempting to share its scope implementation with
  the evaluator.
- Bringing the Go, Python, or Rust implementations to parity.
- Redesigning the task/effects model.
- Splitting `stdlib.ts` solely because it is large.
- Introducing a generic `runtime/` directory that mixes interpreter mechanics,
  task semantics, and host integration.
- Fixing package publication or the root `typescript/index.ts` stub as part of
  this refactor.

## Current architecture

### Synchronous evaluator

`typescript/src/evaluate.ts` is approximately 1,400 lines:

- lines 51–123: performance and value helpers;
- lines 127–349: `callFunction`, `callProgram`, and `prepareProgram`;
- lines 351–493: interruption, limits, metering, and call dispatch;
- lines 496–709: lazy scope construction and JSON function invocation;
- lines 711–872: recursive expression evaluation;
- lines 874–1116: closure capture and local-function attachment;
- lines 1118–1244: property access and call preparation; and
- lines 1246–1410: expression classification and shape validation.

Only `src/index.ts` and `src/host.ts` import `evaluate.ts` directly. Tests,
examples, and the CLI primarily use the public `src/index.ts` barrel.

### Task and host boundary

The existing effects stack already defines a useful separation:

- `task.ts` is the pure, synchronous task kernel;
- `host.ts` is the async capability trampoline and persistence boundary;
- `effects.ts` describes and materializes effect declarations;
- `environment.ts` validates operator-owned environment configuration; and
- `runtime-contract.ts` enforces typed boundaries.

`prepareProgram` is the intended bridge from `host.ts` into synchronous
evaluation. It prepares module scope once and shares execution state across task
hops.

### Shared infrastructure

Several root modules are intentionally shared:

- `types.ts` contains canonical JSON/AST types as well as evaluator internals;
- `params.ts` is used by shorthand, checker, and evaluator;
- `definition-pool.ts` is shared by checker and runtime paths; and
- schema/value checking currently lives under `check/` even though
  `runtime-contract.ts`, `effects.ts`, and `environment.ts` also use it.

The baseline graph has two existing cycles:

- `params.ts` ↔ `utils.ts`: `params.ts` uses `exprError`, while `utils.ts` uses
  parameter analysis for `getArity`; and
- `builtins.ts` → `check/builtin-types.ts` → `effects.ts` → `builtins.ts`.

Neither cycle passes through `evaluate.ts`. This refactor must not add another
cycle; the existing cycles can be addressed separately after the evaluator
layout is stable.

## Architectural boundary

### Evaluator-owned

The following belong in `eval/`:

- execution entry for a canonical function or module;
- expression classification and dynamic shape errors;
- recursive expression evaluation;
- function dispatch across names, JSON function bodies, builtins, and native
  host functions;
- lexical/module scope, lazy variables, and parameter binding;
- closure capture and escaping local-function attachment;
- execution limits, interruption, fuel, depth, and value-size accounting; and
- evaluator recognition of runtime-contract wrapper bodies.

### Outside the evaluator

The following should remain outside `eval/`:

- shorthand parsing and printing;
- static checking and diagnostics;
- standard-library and registry construction;
- task construction, stepping, and in-language handling;
- async capability execution;
- environment/effect configuration and file loading;
- task serialization and admission analysis; and
- CLI input/output and command routing.

### Gray areas

`runtime-contract.ts` is a boundary service. The evaluator must recognize its
serializable function wrappers, but schema resolution and contract construction
do not belong in the expression walker.

`params.ts` is language-wide syntax/semantics infrastructure, not evaluator
internals. It should remain shared during this refactor.

`task.ts` implements language semantics but is deliberately layered on top of
the generic evaluator through builtins and callbacks. It should not move into
`eval/`.

## Target layout

The initial target is:

```text
typescript/src/
  eval/
    index.ts
    program.ts
    interpreter.ts
    execution.ts
    expression-type.ts
    closures.ts
    property-access.ts
  check/
  shorthand/
  task.ts
  host.ts
  effects.ts
  environment.ts
  runtime-contract.ts
  params.ts
  types.ts
  index.ts
  cli.ts
```

Responsibilities:

- `eval/index.ts` — evaluator barrel and compatibility surface.
- `eval/program.ts` — `callFunction`, `callProgram`, `prepareProgram`, shared
  execution initialization, and module-entry validation.
- `eval/interpreter.ts` — the mutually recursive evaluation component:
  `evaluateExpression`, function dispatch, JSON function invocation, and
  `buildScope`.
- `eval/execution.ts` — resolved limits, interruption checks, fuel/depth/value
  accounting, usage synchronization, and performance-stat construction.
- `eval/expression-type.ts` — validating dynamic expression classification.
- `eval/closures.ts` — free-variable substitution, local-function reference
  collection, and escaping-function attachment.
- `eval/property-access.ts` — property access over already-evaluated keys and
  targets, including diagnostics.

`interpreter.ts` may remain several hundred lines. Its size is acceptable if its
contents continue to form one strongly connected semantic component.

Evaluator-only types such as `EvaluationContext`, `ResolvedLimits`,
`CallState`, and `EvaluatedFunctionCall` may move to an
`eval/internal-types.ts` later. That move is not required for the first pass and
should not be combined with the structural extraction unless it clearly
improves dependencies.

## Dependency direction

The desired value-dependency direction is:

```text
index / cli
  -> host / environment / eval / check / shorthand

host
  -> eval / task / environment / runtime-contract

eval/program
  -> eval/interpreter / eval/execution / shared types and definitions

eval/interpreter
  -> eval/execution / eval/closures / eval/expression-type
     / eval/property-access / params / runtime-contract

check
  -> shared types / params / definitions / environment declarations

shorthand
  -> shared types / params / schema
```

The evaluator must not import `host.ts`, `task.ts`, `effects.ts`,
`environment.ts`, the checker entry points, or shorthand.

## Refactor tooling

The `blast` package at `/Users/nick/repos/active/blast` provides compiler-aware
import analysis and codemods. It should be run from `typescript/`, where paths
resolve against the target project.

### Baseline graph

Before editing, capture:

- the import graph and existing cycles;
- call-graph cohesion for `evaluate.ts`;
- file metrics; and
- test topology for evaluator-related files.

For example:

```bash
cd typescript

blast -e 'import { buildImportGraph, findCycles } from "blast";
const graph = await buildImportGraph({
  include: ["src", "test", "examples"],
  tsconfigPath: "tsconfig.json",
});
console.log(findCycles(graph));'
```

Call-graph and metrics inspection may use `buildCallGraph`,
`moduleCallCohesion`, `fileMetrics`, and `godFiles`. Test selection may use
`buildTestTopology` and `impactedTests`.

Store or paste the baseline output into the implementation PR description; it
does not need to become a tracked generated artifact.

### Module relocation

Use `moveModules` for whole-file moves because it rewrites both the moved file's
own relative imports and all consumers:

```bash
cd typescript

blast -e 'import { moveModules } from "blast";
console.log(await moveModules(
  [{ from: "src/evaluate.ts", to: "src/eval/interpreter.ts" }],
  { scope: ["src", "test", "examples"], dryRun: true },
));'
```

Review the dry run before applying the same operation without `dryRun`.

### Declaration extraction

`moveDeclaration` is appropriate for self-contained top-level declarations
such as the classifier or performance factory. Always dry-run it first.

Do not use declaration moves mechanically for a tightly coupled group if the
result is a chain of back-imports. In particular, extraction of execution
setup, the recursive interpreter component, and closure capture needs manual
review even if `blast` performs the initial text movement.

After each extraction:

1. format the changed files;
2. run TypeScript checks;
3. inspect `findCycles`;
4. inspect the changed import edges; and
5. run the impacted tests followed by the full TypeScript suite at the phase
   boundary.

## Implementation phases

### Phase 0: Characterize and freeze behavior

1. Run:

   ```bash
   cd typescript
   bun run check
   bun test
   ```

2. Capture the `blast` import graph, cycles, call cohesion, file metrics, and
   test topology.
3. Add focused characterization tests where coverage is currently indirect:
   - `prepareProgram.invokeEntry`;
   - `prepareProgram.call`;
   - shared fuel usage across prepared calls;
   - deadline refresh behavior used by host hops; and
   - `serializeTask`/`hydrateTask` round trips if host reorganization will
     follow.
4. Record these invariants:
   - `prepareProgram` retains one mutable state/limits object across hops;
   - `raw()` uses one process-wide marker module;
   - module functions are not attached to escaping closures;
   - nested local functions are attached transitively and cycle-safely; and
   - public exports and error messages remain unchanged.

#### Phase 0 record (2026-07-18)

The pre-change baseline was green:

- `bun run check` completed with no type, lint, or formatting errors;
- `bun test` passed 1,574 tests across 25 files; and
- no evaluator source files had been moved or edited.

The `blast` baseline reported:

- 74 import-graph nodes and 296 edges across `src`, `test`, and `examples`;
- the two pre-existing cycles documented under **Shared infrastructure**;
- 39 function nodes in `evaluate.ts`, with 56 intra-module call edges, 29
  outgoing call edges, and module cohesion of approximately 1.436;
- 1,411 physical lines, 1,170 code lines, 47 functions, a longest function of
  165 lines, and maximum nesting depth 5 in `evaluate.ts`; and
- 25 test files and 35 subject files in the test topology. Ten existing test
  files transitively reached `evaluate.ts`; the only topology-uncovered source
  files were `src/check/builtin-types.ts` and `src/cli.ts`.

`test/prepared-program.test.ts` now directly freezes:

- `prepareProgram.invokeEntry` module-scope evaluation and exact missing-entry
  diagnostics;
- `prepareProgram.call` with an escaping closure;
- omission of persistent module functions from escaping closure attachments;
- transitive, cycle-safe attachment of mutually recursive nested local
  functions;
- cumulative fuel across calls made by one prepared program;
- deadline refresh between host hops;
- `serializeTask`/`hydrateTask` JSON round trips and restoration of the shared
  process-wide `raw()` marker; and
- exact rejection messages for non-task serialization and hydration.

These tests establish the intended invariants without exposing evaluator
internals. The public exports remain unchanged, and the existing suite continues
to freeze the broader evaluator error surface.

### Phase 1: Establish the `eval/` boundary

1. Move `src/evaluate.ts` to `src/eval/interpreter.ts` with `moveModules`.
2. Add `src/eval/index.ts`.
3. Keep `src/evaluate.ts` temporarily as a compatibility re-export:

   ```typescript
   export {
     callFunction,
     callProgram,
     prepareProgram,
     createPerfStats,
   } from "./eval";
   ```

4. Update `src/index.ts` and `host.ts` to use the new evaluator barrel.
5. Do not change function bodies in this phase.

The compatibility file protects untracked deep imports and makes the structural
move independently reviewable. It can be removed only after deciding whether
deep `src/evaluate` imports are supported.

#### Phase 1 record (2026-07-18)

The evaluator implementation now lives in `src/eval/interpreter.ts`, with
`src/eval/index.ts` as the internal barrel. `src/index.ts` and `host.ts` import
through that barrel, while `src/evaluate.ts` preserves the previous deep-import
path as a compatibility re-export. No evaluator function bodies changed.

The post-move verification was green:

- `bun run check` completed with no type, lint, or formatting errors;
- `bun test` passed 1,582 tests across 26 files; and
- the import graph retained only the two pre-existing cycles documented under
  **Shared infrastructure**, with no cycle involving `eval/`.

### Phase 2: Extract leaf concerns

Extract modules in dependency order:

1. `expression-type.ts`
   - `getExpressionType`;
   - `classifyExpressionType`; and
   - scalar/object shape validation used only during classification.

2. `property-access.ts`
   - `describeTarget`;
   - `keyHint`; and
   - a pure access function receiving evaluated target and key.

   The recursive evaluation of `$get` and `$from` remains in
   `interpreter.ts`.

3. `execution.ts`
   - `createPerfStats`;
   - interrupt checks;
   - fuel and size guards;
   - result accounting; and
   - shared resolved-limit/state creation.

4. `closures.ts`
   - `replaceVars`;
   - local-function reference collectors;
   - node counting; and
   - `attachFreeLocalFns`.

   Pass the execution context or narrow metering operations into closure
   helpers. Do not create a reverse import from `closures.ts` to
   `interpreter.ts`.

After this phase, inspect the graph. The expected direction is
`interpreter -> leaf modules`, with no leaf importing the interpreter.

#### Phase 2 record (2026-07-18)

The four leaf concerns now live under `src/eval/`:

- `expression-type.ts` owns expression classification and its validation;
- `property-access.ts` owns pure access behavior and diagnostics, while
  `interpreter.ts` still evaluates `$get` and `$from`;
- `execution.ts` owns performance-stat creation, limit resolution, mutable
  execution state, usage/deadline synchronization, and metering guards; and
- `closures.ts` owns substitution, function-value recognition, reference
  collection, and transitive local-function attachment.

The dependency graph has the intended direction: `interpreter.ts` imports all
four leaf modules, `closures.ts` imports only the narrower metering operations
from `execution.ts`, and no leaf imports `interpreter.ts`. The graph retains only
the two pre-existing cycles documented under **Shared infrastructure**.

The extraction reduced `interpreter.ts` from 1,170 to 665 code lines. The new
leaf modules contain 153 code lines (`expression-type.ts`), 89
(`property-access.ts`), 84 (`execution.ts`), and 196 (`closures.ts`).
Post-extraction call cohesion is approximately 1.091 for `interpreter.ts`, 1.333
for `closures.ts`, 0.667 for `property-access.ts`, 0.5 for
`expression-type.ts`, and 0.25 for `execution.ts`.

Verification remained green:

- `bun run check` completed with no type, lint, or formatting errors; and
- `bun test` passed 1,582 tests across 26 files.

### Phase 3: Separate program APIs from the recursive interpreter

Move the public entry functions into `eval/program.ts`:

- `callFunction`;
- `callProgram`;
- `prepareProgram`; and
- shared module-entry validation.

Consolidate their repeated setup into an internal execution/session factory
that owns:

- resolved execution limits;
- mutable depth/fuel state;
- usage synchronization;
- performance stats;
- deadline initialization and refresh; and
- merged runtime definitions.

Keep public signatures and returned `prepareProgram` operations unchanged.

The manual design goal is one setup path with three thin public adapters, not a
new public class hierarchy.

#### Phase 3 record (2026-07-18)

The public evaluator APIs now live in `src/eval/program.ts`.
`callFunction`, `callProgram`, and `prepareProgram` share a private session
factory that owns resolved limits, mutable execution state, usage
synchronization, performance statistics, deadline refresh, and merged runtime
definitions. Program-oriented adapters additionally share module-scope setup
and one module-entry validator.

`interpreter.ts` now exports only the two internal operations needed by the
program layer: recursive function invocation and scope construction. The
dependency direction is `program.ts -> interpreter.ts`; the interpreter does
not import the program layer. The existing public barrel and compatibility
re-export preserve all public import paths and signatures.

Verification remained green:

- `bun run check` completed with no type, lint, or formatting errors;
- `bun test` passed 1,582 tests across 26 files; and
- the import graph retained only the two pre-existing cycles documented under
  **Shared infrastructure**, with no cycle involving `eval/`.

### Phase 4: Reassess the recursive core

Use `buildCallGraph`, `callCycles`, and `moduleCallCohesion` after the leaf
extractions.

Keep these together in `interpreter.ts` by default:

- `evaluateExpression`;
- `evaluateFunctionCall`;
- `callFunctionInternal`;
- `callJSONFunction`;
- `callExternalFunction`; and
- `buildScope`.

Split any of them further only if the resulting dependency graph is acyclic,
the module has a clear independent contract, and it does not require a mutable
late-bound operations table merely to bypass ESM cycles.

Reducing line count alone is not sufficient justification.

#### Phase 4 record (2026-07-18)

The post-extraction call graph supports keeping the recursive core together.
`interpreter.ts` contains 15 named function nodes with 18 intra-module call
edges, 30 outgoing call edges, and module cohesion of 1.2. `callCycles`
identifies one recursive component containing `callFunctionInternal`,
`callJSONFunction`, `evaluateExpression`, `evaluateFunctionCall`, and
`evaluatePropertyAccess`.

`buildScope` is also part of the same semantic component even though the static
cycle analysis does not place it in that strongly connected component:
`callJSONFunction` constructs the scope, while the scope's lazy `getVar`
callback re-enters `evaluateExpression`. Moving either side would therefore
introduce a back-import, require late-bound evaluator operations, or obscure
the lazy-scope contract.

No further split has a sufficiently independent contract. In particular,
property-access operand evaluation and function-call preparation recurse
directly into `evaluateExpression`, while native and JSON function dispatch are
small branches of the same call boundary. Phase 4 therefore makes no code
changes; the recursive core remains in `interpreter.ts` by design.

Verification remained green:

- `bun run check` completed with no type, lint, or formatting errors;
- `bun test` passed 1,582 tests across 26 files; and
- the import graph retained only the two pre-existing cycles, with no cycle
  involving `eval/`.

### Phase 5: Clean shared internals

After the evaluator layout is stable:

1. Break the `params.ts` ↔ `utils.ts` cycle by moving `exprError` to a small
   shared error module or moving `getArity` out of `utils.ts`.
2. Consider moving evaluator-only context/state types from `types.ts` into
   `eval/internal-types.ts`.
3. Consolidate the duplicated structural function-value predicates currently
   used by evaluator and task code.

These are dependency cleanups, not prerequisites for establishing `eval/`,
unless the graph shows they block an extraction.

#### Phase 5 record (2026-07-18)

The shared-internals cleanup is complete:

- `exprError` now lives in the dependency-light `expression-error.ts`.
  `utils.ts` retains a compatibility re-export, while `params.ts` imports the
  helper directly. This removes the `params.ts` ↔ `utils.ts` cycle.
- Evaluator-private `EvaluationContext`, `ResolvedLimits`, and `CallState` types
  moved from the general `types.ts` module to `eval/internal-types.ts`. Public
  execution configuration and reporting types remain in `types.ts`.
- Structural checks for inline function bodies and callable function
  declarations are centralized in `function-value.ts`. The evaluator, task
  kernel, stdlib, runtime-contract layer, CLI, and arity helper now share those
  predicates.

This phase did not change public exports from `src/index.ts` or evaluator
behavior. Verification completed successfully:

- `bun run check` completed with no type, lint, or formatting errors;
- `bun test` passed 1,582 tests across 26 files; and
- `blast` reports that the parameter/utility cycle is gone. The only remaining
  import cycle is the pre-existing
  `builtins.ts` → `check/builtin-types.ts` → `effects.ts` → `builtins.ts`
  cycle, with no cycle involving `eval/`.

### Phase 6: Optional embedding-layer follow-up

This should be a separate reviewable change after the evaluator refactor.

Split `host.ts` by responsibility:

```text
src/host/
  index.ts
  run-task.ts
  environment-runtime.ts
  task-serialization.ts
  required-capabilities.ts
```

Potentially organize `effects.ts` and `environment.ts` together under an
`environment/` directory, but keep declarations usable by both checker and
host.

Before moving runtime contracts, consider extracting schema/value semantics from
`check/` into a shared `schema/` area. Runtime contracts and environment
validation already depend on them, so their current path understates their
ownership.

Do not call this combined area `runtime/`: host execution, environment
declarations, task semantics, and synchronous evaluation have different
dependency and portability constraints.

## Verification

Every phase must run:

```bash
cd typescript
bun run check
bun test
```

Focused verification while iterating:

```bash
bun test test/spec.test.ts
bun test test/evaluate.test.ts test/signal.test.ts test/runtime-contract.test.ts
bun test test/module-scope.test.ts test/parameter-defaults.test.ts
bun test test/strict-parameter-runtime.test.ts
bun test test/environment.test.ts test/effect-manifest-validation.test.ts
bun test test/example-environments.test.ts
bun test test/cli-eval.test.ts test/cli-check.test.ts
```

Important behavioral coverage includes:

- the shared conformance cases for core evaluation, closures, limits,
  parameters, and in-language effects;
- TypeScript-only module scope and entry validation;
- parameter defaults through all three evaluator APIs;
- runtime-contract wrappers;
- signal and timeout behavior;
- environment/task execution; and
- CLI routing through function, expression, module, and environment modes.

Run `./test-all.sh` from the repository root before removing the compatibility
re-export or merging the optional embedding-layer follow-up.

## Acceptance criteria

- `src/eval/` clearly owns synchronous evaluation.
- Existing public imports from `src/index.ts` continue to work unchanged.
- `callFunction`, `callProgram`, `prepareProgram`, and `createPerfStats` retain
  their signatures and behavior.
- `prepareProgram` preserves shared limits, state, metering, and deadline
  semantics across task hops.
- `interpreter.ts` imports leaf evaluator modules; leaf modules do not import
  `interpreter.ts`.
- No new import cycles are introduced.
- Closure capture, module scope, execution limits, contracts, tasks, and CLI
  tests pass unchanged.
- `bun run check`, `bun test`, and the final repository-wide checks pass.
- The final module graph is inspected with `blast`, and any remaining cycles are
  documented rather than accidental.
- Host/environment reorganization, if undertaken, is kept separate from the
  evaluator extraction.

## Deferred follow-ups

- Fix the package entrypoint: `typescript/package.json` currently points
  `"module"` at the root `typescript/index.ts` stub rather than the actual
  `src/index.ts` public barrel.
- Extend shared conformance infrastructure to cover `callProgram` module-scope
  behavior.
- Add direct persistence tests for suspended workflows as part of the durable
  orchestration work.
- Reassess whether shared schema/value code should remain under `check/`.
