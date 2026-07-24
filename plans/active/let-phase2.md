# `$let` Phase 2: checker

This document expands Phase 2 of `plans/active/let.md` into an implementation
plan for the canonical TypeScript checker.

Phase 2 teaches the checker the evaluator model established in Phase 1:
canonical `$let` expressions introduce lazy recursive type scopes, function
bodies are checked through structural fields, and evaluator-produced
`$captures` are explicit function state. It does not change shorthand lowering
or migrate the shared canonical fixtures. A narrow legacy adapter may remain so
the old parser output continues to check until Phase 3, but new checker paths
and tests must use `$let`.

## Deliverable

At the end of Phase 2:

- canonical `{ "$let": { ... }, "$in": ... }` expressions synthesize and check
  as one expression whose result type is the type of `$in`;
- `$let` bindings use the checker's existing lazy, memoized, mutually recursive,
  cycle-checked type environment;
- creation-site and forcing-site narrowing facts continue to affect lazy
  bindings without stale memoized types;
- function-valued bindings enter the recursive environment through their
  declared `$fnType`, preserving recursive and mutually recursive lookup;
- diagnostics inside binding expressions are rooted at `$let.<name>`, while
  result diagnostics are rooted at `$in`;
- function checking has distinct structural handling for parameters,
  signatures, defaults, `$return`, and evaluator-produced `$captures`;
- `$captures` are visible to parameter defaults and `$return`, and malformed
  capture maps receive stable diagnostics;
- arbitrary function-body keys are no longer part of the target checker model;
- the IIFE checker handles genuine inline function calls, not a second
  checker-level encoding of local binding;
- direct canonical-JSON checker tests cover the full Phase 2 matrix;
- existing shorthand and fixtures continue to check through an explicitly
  temporary legacy-body adapter.

The important architectural result is that the checker creates a recursive type
scope at the same explicit expression boundary where the evaluator creates a
runtime binding scope.

## Non-goals

Do not include the following work in Phase 2:

- changing `where` or `do` lowering in `typescript/src/shorthand/parser.ts`;
- changing reconstruction in `typescript/src/shorthand/printer.ts`;
- migrating all of `spec/cases/` or regenerating `spec/parse-cases/`;
- deleting the evaluator's temporary legacy function-body adapter;
- exposing `$captures` in shorthand;
- adding binding annotations;
- changing the narrowing language or schema-subsumption rules;
- inferring full signatures for unannotated function bindings;
- porting Go, Python, or Rust.

The old zero-argument IIFE remains a valid call. It can still appear because the
Phase 2 parser emits it, but the new `$let` checker implementation must not
recognize an IIFE shape as local-binding syntax.

## Checker invariants

Preserve these invariants while extracting the new scope machinery:

1. A non-function binding's type is synthesized only when its name is looked
   up.
2. A binding is synthesized at most once for each distinct set of relevant
   narrowing facts.
3. Every binding can refer to every sibling binding, including itself.
4. A recursive value-type dependency reports the existing
   `Circular local type dependency: ...` diagnostic and recovers as `any`.
5. A binding sees the lexical parent environment, including function
   parameters.
6. A binding shadows an outer value, guard, or function of the same name.
7. Function-valued siblings are available eagerly through their declared
   `$fnType`; an unannotated function still follows the existing visible
   degradation policy.
8. Narrowing facts active when a `$let` scope is created dominate every later
   force of one of its bindings.
9. Narrowing facts active at a forcing site augment the creation-site facts.
10. A lazy binding is re-synthesized only when changed facts intersect its
    transitive free-variable set.
11. Named boolean guards introduced by `$let` participate in
    `factsFromCondition` exactly as legacy lazy locals do.
12. `$captures` are function bindings, not one expression binding named
    `"$captures"`.
13. Capture function types are available before parameter defaults are
    checked.
14. The module top level remains a persistent named registry and is not
    modeled as a `$let` expression.
15. Checking `$let` adds no synthetic parameter signature, call boundary, or
    IIFE-specific behavior.

## Current checker structure

The relevant code is concentrated in:

- `typescript/src/check/ast.ts`, where `nodeKind` performs a thin expression
  discriminant switch;
- `typescript/src/check/context.ts`, where `TypeEnv`, diagnostics, function-body
  helpers, and `bindingKeys` live;
- `typescript/src/check/checker.ts`, where `synth`, `check`, `checkBody`,
  `buildTypeScope`, and `iifeBodyContext` live;
- `typescript/src/check/module.ts`, where module scope and dangling `$ref`
  validation are assembled;
- `typescript/src/check/builtin-rules.ts`, where contextual callback typing
  currently calls `buildTypeScope`.

`buildTypeScope` currently combines four responsibilities:

1. binding parameters from a declared or injected signature;
2. scanning arbitrary function-body keys for local bindings;
3. creating the lazy letrec type environment;
4. checking nested function-valued bindings.

It also owns narrowing-sensitive memoization:

- `creationNarrowings` records facts at scope creation;
- `collectVars` and `freeVarsOf` determine which facts affect each binding;
- `memo` serves the no-relevant-facts path;
- `narrowedMemo` caches by stable serialization of relevant facts;
- `resolving` detects recursive value-type dependencies.

Phase 2 should preserve those mechanics, but move them behind an API whose
input is an explicit binding map rather than a function body.

## Target internal structure

### 1. One private lazy letrec engine, separate semantic entry points

Extract the lazy portion of `buildTypeScope` into a helper equivalent to:

```ts
type TypeScopeResult = {
  env: TypeEnv;
  guards: Record<string, JSONType>;
};

buildLetrecTypeScope(
  bindings: Record<string, JSONType>,
  eager: Record<string, Schema>,
  parent: TypeEnv | null,
  ctx: CheckContext,
  options: {
    reportUntypedFunctions: boolean;
    bindingPath: CheckContext;
  },
): TypeScopeResult
```

Exact names and argument grouping can follow local style. The responsibilities
matter more than this signature.

`buildLetrecTypeScope` owns:

- separating function-valued bindings from expression-valued bindings;
- eager `$fnType` registration for function bodies;
- visible degradation for unannotated function bindings when requested;
- named-guard construction;
- creation-site narrowing capture;
- transitive free-variable collection;
- plain and fact-keyed memoization;
- cycle detection;
- parent lookup;
- binding-relative diagnostic paths.

Keep distinct wrappers for distinct language scopes:

```ts
buildFunctionTypeScope(body, layout, parent, ctx, injectedSig?)
buildExpressionTypeScope(bindings, parent, ctx)
buildModuleTypeScope(moduleBindings, ctx)
```

- `buildFunctionTypeScope` seeds `$captures`, binds parameters, and prepares
  defaults. On the target path it does not infer locals from body siblings.
- `buildExpressionTypeScope` treats every key in `$let` as one recursive local
  binding and roots diagnostics under `$let`.
- `buildModuleTypeScope` retains the module's special top-level policy and
  forces top-level constants as it does today.

Parameters and `$let` bindings should not share a public semantic entry point.
Parameters are aligned eagerly to a signature and have default-expression
rules; `$let` bindings are inferred lazily from expressions. They may compose
over the same `TypeEnv` machinery without pretending to be the same construct.

### 2. Environment composition

For a structural JSON function body, construct the type environment in this
order:

1. lexical parent;
2. eager function captures from `$captures`;
3. parameter bindings aligned to the declared or injected signature;
4. the temporary legacy local frame, only when checking old parser output;
5. nested `$let` frames encountered while checking `$return`.

The concrete implementation can merge eager maps where shadowing behavior is
equivalent. The observable requirements are:

- parameters shadow an outer lexical name;
- a `$let` nested in `$return` shadows both parameters and captures;
- a capture is visible in parameter defaults and `$return`;
- a legacy inline local retains its current behavior until the adapter is
  deleted;
- sibling `$let` bindings see one another recursively.

Do not make `$let` part of `buildFunctionTypeScope`. A function creates its
parameter/capture frame; an actual `$let` node in `$return` creates its own child
frame when `synth` or `check` reaches it.

### 3. Temporary legacy function-body adapter

Phase 3 has not changed parser output yet, so Phase 2 cannot immediately reject
every old inline-local function body while keeping the branch testable.

Preserve old input through a clearly named adapter, for example:

```ts
legacyFunctionBindings(body): Record<string, JSONType>
buildLegacyFunctionTypeScope(bindings, parent, ctx): TypeScopeResult
```

The adapter may identify non-structural body keys, but the target
`checkBody`/`buildFunctionTypeScope` path must receive an explicit binding map;
it must not contain its own generic scan or treat the whole body as a scope.

The adapter must:

- skip all structural source keys;
- skip evaluator-owned `$captures`;
- preserve current parameter/default/local recursion while old shorthand still
  relies on it;
- use the same extracted letrec engine as `$let`;
- be marked for deletion after the Phase 3 parser cutover or in Phase 4 cleanup;
- never be used by new `$let` tests.

This is a phase-order bridge, not compatibility policy. No second binding model
should remain in the finished refactor.

## `$let` classification and validation

Add `"let"` to the checker `NodeKind` in
`typescript/src/check/ast.ts`. Test for either reserved key before `"body"` and
before the generic `"object"` fallback:

```ts
if ("$let" in o || "$in" in o) return "let";
```

`nodeKind` is deliberately a thin non-validating discriminant. Validate the
outer shape in the checker arm so malformed forms produce diagnostics rather
than being inferred as literal data.

A valid `$let`:

- is a non-array object;
- contains both `$let` and `$in`;
- contains exactly those two keys;
- has a non-null, non-array object as `$let`;
- has at least one binding.

Align the shape and diagnostic wording with
`typescript/src/eval/expression-type.ts` where practical. At minimum cover:

- `$let` without `$in`;
- `$in` without `$let`;
- scalar, null, or array `$let`;
- empty `$let`;
- an extra property;
- a mixed special-form object such as `$let` plus `$call`.

Validate only the outer node at classification/check time. Do not recursively
validate every binding expression merely because it appears in the binding
map. An unused binding remains lazy; its inner expression is classified when
the checker first forces its type.

## `$let` synthesis and checking

### Synthesis

The `"let"` arm in `synth` should:

1. validate the outer shape;
2. create a binding context rooted at `at(ctx, "$let")`;
3. build an expression letrec type scope over `node.$let`;
4. synthesize `node.$in` at `at(extendedContext, "$in")`;
5. return the synthesized `$in` schema.

Do not synthesize all non-function bindings eagerly. Function-valued bindings
may still be registered eagerly by signature and their bodies checked according
to the existing nested-function policy.

### Checked position

Add a structural `$let` case near the beginning of `check`, before generic
object checking and before the final synth-then-subsumes fallback:

1. validate and build the same letrec scope;
2. push the expected schema directly into `$in`;
3. check `$in` at `at(extendedContext, "$in")`.

This preserves precise result diagnostics. A return mismatch in:

```json
{
  "$let": { "x": 1 },
  "$in": { "$var": "x" }
}
```

belongs to `$in`, not to the enclosing `$let` object and not to an artificial
`$return`.

Share the scope-building path between `synth` and `check`; do not duplicate
memoization or cycle handling in the two arms.

## Lazy typing and narrowing

### Creation-site and forcing-site facts

Move the existing `buildTypeScope` behavior without semantic changes:

- snapshot `ctx.narrowings ?? {}` when the `$let` scope is created;
- merge forcing-site facts after creation-site facts;
- filter the merged facts to the binding's transitive free-variable set;
- use the plain memo when no relevant facts remain;
- use `narrowedMemo[name][stableStringify(relevantFacts)]` otherwise.

This is required for existing callback and bind-continuation narrowing behavior.
Extracting the helper must not accidentally make lazy locals use only the facts
from their first force.

### Named guards

Every non-function binding expression remains available through `ctx.guards`.
The `$let` map shadows same-named outer guards:

```ts
const guards = { ...ctx.guards, ...expressionBindings };
```

This keeps conditions such as a bare `$var` referring to a locally defined
boolean predicate connected to `factsFromCondition`.

### Free-variable collection

Teach `collectVars` about `$let` as a lexical boundary. For a nested `$let`:

- collect references from all binding expressions and `$in`;
- mask `Object.keys($let)` while traversing the entire recursive node;
- continue recording static access paths such as `move.from`;
- continue skipping `$raw` payloads.

The current implementation intentionally over-approximates nested lambda free
variables. It may keep doing so, but it must not treat a nested `$let`'s bound
names as dependencies on an outer variable of the same name. A small
scope-aware traversal API is preferable to special cases that mutate one
global set.

### Cycle diagnostics

Keep the current shared `resolving` stack and recovery behavior. For:

```json
{
  "$let": {
    "a": { "$var": "b" },
    "b": { "$var": "a" }
  },
  "$in": { "$var": "a" }
}
```

report one order-stable diagnostic equivalent to:

```text
Circular local type dependency: a -> b -> a
```

Root the diagnostic at the binding scope or the binding that closes the cycle,
consistently with the chosen path policy. Continue relying on module-level
diagnostic deduplication when the same lazy expression is visited under
multiple fact sets.

## Diagnostic paths

The extracted letrec helper must not hard-code `path: [name]`, as the current
`resolveLocal` does. Accept a binding-path context from the semantic wrapper.

Required path shapes:

- a binding expression: `... "$let", "<name>"`;
- the result expression: `... "$in"`;
- a malformed capture map: `... "$captures"`;
- a malformed capture entry: `... "$captures", "<name>"`;
- a parameter default: retain the existing `$params[...]` path;
- a module binding: retain its existing top-level path.

Examples:

```text
f.$return.$let.distance
f.$return.$in
f.$captures.helper
```

Use `at(at(ctx, "$let"), name)` and `at(ctx, "$in")` rather than constructing
fresh path arrays. This preserves the enclosing module/function path.

Tests should assert complete path arrays, not only message substrings, for at
least one binding error, one `$in` mismatch, one cycle, and each malformed
`$captures` shape.

## Structural function-body checking

### Target body schema

Function-body checking should reason about explicit structural fields:

- `$params`;
- `$sig`;
- `$return`;
- optional string `$comment`;
- optional evaluator-owned `$captures`.

Any other key is a legacy inline local during the transition and an error after
the legacy adapter is removed. Do not let `$types`, `$runtimeContract`, or
other metadata silently become permanent function-body structural fields
merely because an old evaluator skip list recognized them in another context.

Centralize the supported body-key set or validation helper so checker code does
not grow another collection of drifting skip lists. Keep module-root keys
separate from function-body keys.

### `$captures` validation

`$captures` is an optional map of names to function bodies. When present:

- the container must be a non-null, non-array object;
- every entry must be a function body;
- each capture with a declared signature contributes its `$fnType` eagerly;
- an unannotated capture follows the existing degradation policy;
- capture bodies are recursively checked at `$captures.<name>`;
- capture names are visible to sibling captures as required by the evaluator's
  recursive registry model;
- capture names are visible to parameter defaults and `$return`;
- `$captures` itself is never added to `guards` or lazy expression bindings.

Captured definitions are runtime closure state, but they can cross durable JSON
boundaries and therefore must be checkable as canonical input. The checker does
not inspect or model the evaluator's in-memory
`function-environments.ts` `WeakMap`.

### Parameter defaults

Keep parameter analysis and signature-shape validation unchanged. Change only
the environment in which defaults are checked:

1. validate and register captures;
2. bind all parameters;
3. create the completed function context;
4. check defaults through `checkParameterDefaults`;
5. check `$return`.

Add a regression where a default expression references a named captured
function. This proves the checker matches the Phase 1 invocation order.

### Nested function checks

Replace the final `for (const key of bindingKeys(body))` recursion in
`checkBody` with explicit recursion over:

- `$captures`;
- function-valued bindings inside a `$let`, when that `$let` is visited;
- temporary legacy bindings, inside the adapter only.

A function body should not need to scan itself again after its structural scope
has been built.

## Generic IIFE checking

The checker currently has an `iifeBodyContext` path motivated by the old
zero-argument-IIFE encoding of standalone `where` and leading pure `do`
bindings. Separate the generic behavior from that historical motivation.

Keep:

- contextual typing for a real unannotated inline function callee;
- parameter-layout and arity checks;
- synthesis of argument types in the caller's scope;
- checking parameter defaults and the structural `$return`;
- propagation of an expected result type into `$return` in checked position.

Remove:

- comments and tests that define IIFE as the checker representation of `where`;
- generic scanning of arbitrary body keys inside `iifeBodyContext`;
- any branch that depends on zero arguments or a where-shaped body;
- nested-local recursion through `bindingKeys(body)`.

The helper may remain if generic IIFE typing still needs it. Rename it if a
name such as `inlineCallBodyContext` better reflects the surviving behavior.
Its function-scope setup should reuse `buildFunctionTypeScope`, including
`$captures`, rather than rebuilding a second function environment.

Existing old-parser IIFEs can continue through the temporary legacy adapter
until Phase 3. New tests of binding semantics must use direct `$let` nodes, and
the retained IIFE tests must use structural bodies without inline locals.

## Module and contextual-callback integration

### Module scope

The module root remains an object of persistent named bindings. Refactor
`checkModule` to call the module-specific type-scope wrapper instead of
pretending the module is a parameterless function body.

Preserve:

- eager `$fnType` registration for top-level functions;
- required module-function signatures;
- lazy top-level constants;
- forcing of every top-level constant for diagnostics;
- contract-injected entry signatures;
- module diagnostic deduplication;
- the separate `$types` definition pool.

Do not lower the module root to `$let`, and do not apply the closed
function-body key set to module bindings.

### Dangling `$ref` walk

`walkSigRefs` already recursively walks ordinary term objects. Make its
`$let`/`$captures` behavior explicit in tests:

- signatures on function bindings inside `$let` are visited;
- signatures inside `$captures` are visited;
- `$raw` remains opaque;
- `$sig` schemas are inspected as schemas and not re-walked as term data.

No new type-definition scope is introduced by `$let`.

### Contextual builtin callbacks

`inferLambdaReturn` in `typescript/src/check/builtin-rules.ts` currently calls
`buildTypeScope` directly after stamping a contextual signature onto an inline
body. Route it through the function-specific scope helper so:

- contextual parameters retain their inferred schemas;
- captures are visible;
- defaults use the completed function environment;
- no arbitrary body-key scan exists on the target path.

Retain focused tests for callbacks to `map`, `filter`, `reduce`, and any
bind-continuation case that depends on creation-site narrowing.

## File-by-file changes

### Required source changes

#### `typescript/src/check/ast.ts`

- add `"let"` to `NodeKind`;
- classify the presence of `$let` or `$in` before `"body"` and generic object;
- keep `nodeKind` thin and put recoverable shape diagnostics in the checker;
- add direct node-kind tests.

#### `typescript/src/check/context.ts`

- ensure `$captures` is never returned by transitional `bindingKeys`;
- add or host the centralized structural function-body key set;
- keep module binding discovery separate from function-body structure;
- add helper types only where they reduce repeated casts for `$let` and
  `$captures`.

Do not make `bindingKeys` the permanent API for checking function bodies.

#### `typescript/src/check/checker.ts`

- extract the private lazy letrec type-scope engine from `buildTypeScope`;
- add expression, function, and module scope wrappers;
- parameterize lazy-binding diagnostic paths;
- preserve creation/forcing narrowing caches and cycle recovery;
- make `collectVars` scope-aware for nested `$let`;
- add `$let` validation and `synth`/`check` arms;
- seed and validate `$captures` before checking defaults and `$return`;
- refactor `checkBody` around structural fields;
- isolate temporary inline-local support in a named legacy adapter;
- remove where-specific assumptions from IIFE handling;
- export only helpers still required by `module.ts`, `builtin-rules.ts`, and
  tests.

#### `typescript/src/check/module.ts`

- initialize term scope through the module-specific wrapper;
- preserve top-level constant forcing and module-function checks;
- ensure dangling `$ref` traversal reaches signatures in `$let` and
  `$captures`;
- retain `$types` as a module-only definition pool.

#### `typescript/src/check/builtin-rules.ts`

- replace direct use of generic `buildTypeScope` with the function-specific
  contextual-body path;
- preserve argument-driven signature injection and callback return inference;
- add or retain a capture-aware contextual callback regression.

#### Optional shared function-body helper

A small module such as `typescript/src/function-body-keys.ts` is reasonable if
it prevents the evaluator, checker, and later printer from growing inconsistent
structural-key lists. If added, distinguish:

- canonical source fields;
- evaluator-owned `$captures`;
- module-only fields;
- temporary legacy exclusions.

Do not extract a generic helper that blesses historical skip-list entries as
part of the final function-body schema.

### Required test changes

#### New `typescript/test/let-check.test.ts`

Use hand-authored canonical JSON and `checkExpr`/`checkModule`. Do not parse
shorthand in this file. Cover:

- valid synthesis and checked-position behavior;
- every malformed outer `$let` shape;
- lazy unused bindings;
- repeated lookup and memoization behavior where observable;
- parent parameter visibility;
- outer-local and parameter shadowing;
- nested `$let` shadowing;
- direct and indirect value cycles;
- recursive and mutually recursive function bindings;
- `$var` and `$fn` access to function-valued bindings;
- creation-site narrowing through a lazy binding;
- forcing-site narrowing and fact-keyed re-synthesis;
- named boolean guards;
- binding, `$in`, and cycle diagnostic paths;
- evaluator-produced functions containing `$captures`;
- malformed capture containers and entries;
- captures referenced by defaults and `$return`;
- stray function-body keys on the closed target path;
- nested signatures under `$let` and `$captures`;
- a real structural IIFE to prove generic inline-call typing remains.

Use the canonical evaluator cases in `typescript/test/let-eval.test.ts` as the
behavioral matrix, but assert schemas and diagnostics rather than runtime
values.

#### `typescript/test/check/ast.test.ts`

- add valid and malformed reserved-key forms that classify as `"let"`;
- confirm a plain data object still classifies as `"object"`;
- confirm `$let` is recognized before any mixed special-form key.

#### `typescript/test/check/checker.test.ts`

- move or rewrite `buildTypeScope: lazy locals & cycles` cases against the
  explicit letrec helper or public `$let` behavior;
- rewrite the `do-block / where IIFE` binding tests as canonical `$let` tests;
- retain a small generic IIFE section for real inline calls;
- update complete diagnostic path expectations;
- keep temporary old-parser/legacy-body coverage clearly labeled.

#### `typescript/test/check/narrowing.test.ts`

- express named boolean guard cases through `$let`;
- retain creation-site and forcing-site narrowing regressions;
- add nested `$let` shadowing where an outer narrowed name is rebound.

#### `typescript/test/check/chess.test.ts`

- migrate representative lazy-local narrowing cases to
  `$return: { "$let": ..., "$in": ... }`, or duplicate them in
  `let-check.test.ts` during Phase 2 and leave bulk fixture migration for Phase
  4;
- preserve the difficult multi-step narrowing cases, not only small synthetic
  examples.

#### `typescript/test/check/builtins.test.ts`

- verify contextual callbacks still infer through the refactored function
  scope;
- include a callback function value with `$captures` if that is the smallest
  direct route through `inferLambdaReturn`.

#### `typescript/test/cli-check.test.ts`

- add one smoke test for user-visible `$let.<name>` and `$in` path formatting if
  unit tests only assert path arrays.

### Shared fixtures

Do not perform the Phase 4 bulk migration. Run existing suites unchanged to
prove the transitional legacy adapter works.

Update an individual shared fixture in Phase 2 only when it is the narrowest
way to test checker-visible `$captures` or canonical `$let`. Do not regenerate
parser expectations before Phase 3.

## Test matrix

### Core type behavior

- `$let { x = 1 } in x` synthesizes the literal schema for `1`;
- `$in` is checked directly against an expected schema;
- a binding can see a function parameter and an outer lexical value;
- a nested `$let` shadows an outer `$let`;
- an unused malformed or mismatched binding expression produces no inner
  diagnostic;
- forcing the same binding repeatedly reuses its memoized schema;
- a direct or indirect value-type cycle reports once and recovers.

### Function bindings

- a typed recursive function can reference itself;
- typed mutually recursive functions can reference each other;
- a function-valued binding is available through both function-reference and
  variable-reference paths supported by the checker;
- an unannotated local function produces the established degradation
  diagnostic at `$let.<name>`;
- a nested function body is checked under the environment where it is created.

### Narrowing

- a `$let` boolean guard narrows a referenced outer value;
- creation-site facts survive a callback or continuation boundary;
- forcing-site facts cause re-synthesis only when relevant;
- irrelevant facts reuse the plain memo;
- nested shadowing prevents an outer same-named fact from contaminating the
  inner binding;
- duplicate diagnostics from fact-keyed re-synthesis remain deduplicated.

### Function structure and captures

- a structural function body with only supported fields checks cleanly;
- each stray body key is diagnosed once on the closed target path;
- `$captures: null`, an array, or a scalar is rejected;
- a non-function capture entry is rejected at `$captures.<name>`;
- typed captures are visible from defaults and `$return`;
- mutually recursive captures contribute sibling function types without
  requiring cyclic JSON;
- nested capture bodies are recursively checked;
- capture signatures participate in dangling-reference validation.

### IIFE and module boundaries

- a parameterized unannotated inline function call remains contextually typed;
- a zero-argument structural IIFE remains valid without binding semantics;
- module functions remain eager typed registry entries;
- module constants remain lazy but are forced during full module checking;
- module `$types` remain outside term bindings;
- a `$let` inside a module function does not change module-level identity or
  signature requirements.

## Implementation sequence

Keep the branch testable in this order:

1. Add checker `"let"` classification and outer-shape diagnostics with focused
   AST/checker tests.
2. Add `$captures` to transitional skip logic immediately so current checker
   code cannot mistake it for a local binding.
3. Extract the private lazy letrec engine from `buildTypeScope` without changing
   existing behavior or diagnostic output.
4. Parameterize binding diagnostic paths and add expression/module/function
   wrappers around the engine.
5. Add `$let` synthesis and checked-position handling; land basic lazy,
   recursive, shadowing, cycle, and path tests.
6. Make free-variable collection `$let`-aware and land creation-site,
   forcing-site, named-guard, and nested-shadowing tests.
7. Add `$captures` validation/type seeding and refactor `checkBody` around
   structural fields; land default, return, recursion, and malformed-shape
   tests.
8. Isolate remaining arbitrary-key support in the temporary legacy adapter.
9. Refactor generic IIFE and contextual builtin callback setup to use the
   function-specific scope path; rewrite where-shaped checker tests to `$let`.
10. Refactor module initialization to its dedicated wrapper and verify
    dangling `$ref` traversal.
11. Run all TypeScript checks and inspect diagnostic-path diffs deliberately.

Avoid combining scope extraction, path changes, narrowing changes, and IIFE
test migration in one unverified step. The old `buildTypeScope` behavior should
first move intact; `$let` then becomes a new semantic caller of that machinery.

## Simplifications delivered in Phase 2

These simplifications should be visible in the Phase 2 checker:

- `synth` and `check` have one explicit local-binding node;
- lazy letrec construction accepts a binding map, not a function body;
- parameter scope, expression scope, and module scope have distinct entry
  points;
- binding diagnostics no longer lose their enclosing path;
- function checking names the structural fields it checks;
- `$captures` has one explicit validation and type-seeding path;
- contextual callbacks and IIFEs reuse function-scope construction;
- where-specific type checking no longer depends on a call-shaped encoding;
- checker scope boundaries mirror evaluator scope boundaries.

The temporary adapter remains, but target paths must not call `bindingKeys` to
discover function locals.

## Simplifications enabled now but deleted later

Track these as follow-up deletions:

- `legacyFunctionBindings` and its arbitrary body-key scan: delete after parser
  output and fixtures use `$let`;
- old tests whose only purpose is checking inline function-body locals: replace
  with canonical `$let` tests;
- parser-emitted binding IIFEs and printer inverse recognition: replace in
  Phase 3;
- transitional body index signatures and skip lists: tighten during final
  canonical cleanup;
- comments describing function-body siblings as the checker's term scope:
  replace with `$let`, parameter, capture, and module terminology.

Phase 2 should leave an explicit deletion marker on each temporary checker
adapter so cleanup does not require reconstructing why it exists.

## Verification

From `typescript/`:

```bash
bun run check
bun test
```

Also run focused tests during implementation:

```bash
bun test test/let-check.test.ts
bun test test/check/ast.test.ts
bun test test/check/checker.test.ts
bun test test/check/narrowing.test.ts
bun test test/check/chess.test.ts
bun test test/check/builtins.test.ts
bun test test/cli-check.test.ts
```

The Phase 2 acceptance checks are:

- canonical `$let` synthesizes and checks without invoking the parser;
- malformed outer `$let` objects produce stable checker diagnostics rather than
  object-literal types or exceptions;
- an unused binding is not recursively checked;
- a repeatedly forced binding reuses its cached type for the same relevant
  facts;
- recursive and mutually recursive bindings resolve in one environment;
- cycles report with stable names and paths;
- creation-site and forcing-site narrowing tests remain green;
- named boolean guards work through `$let`;
- binding diagnostics are under `$let.<name>` and result diagnostics under
  `$in`;
- `$captures` are never treated as ordinary locals;
- captures are available to defaults and `$return`;
- malformed captures and stray structural keys are diagnosed precisely;
- generic IIFEs and contextual builtin callbacks still check correctly;
- module scope, typed-entry requirements, and top-level constant forcing are
  unchanged;
- existing old-parser tests pass only through the clearly named transitional
  adapter;
- no new checker path interprets a zero-argument IIFE as `where`.

## Phase boundary handoff

Phase 3 can assume:

- `nodeKind` and the checker recognize canonical `$let` everywhere an
  expression is allowed;
- lazy recursive type-scope behavior is centralized behind explicit binding
  maps;
- function checking has structural parameter, signature, default, return, and
  capture handling;
- `$captures` are accepted and validated as durable runtime function state;
- generic IIFE and contextual callback checking no longer own local-binding
  semantics;
- checker tests no longer need IIFE-shaped bindings to exercise `where`
  behavior.

Phase 3 must still change shorthand parsing and printing. Once parser output no
longer contains inline function-body locals or binding IIFEs, the temporary
checker adapter can be deleted and closed function-body rejection can become
unconditional. Phase 4 then migrates remaining canonical fixtures, removes all
legacy scans and skip lists, and updates public language documentation.
