# `$let` Phase 1: evaluator and closure model

This document expands Phase 1 of `plans/active/let.md` into an implementation
plan for the canonical TypeScript interpreter.

Phase 1 adds direct evaluation of canonical `$let` expressions and changes the
runtime closure representation to `$captures`. It does not change shorthand,
the checker, or the shared canonical fixtures wholesale. Those systems may
continue producing and accepting the old binding encodings until their later
phases, but the new evaluator behavior must be independently complete and
tested at this phase boundary.

## Deliverable

At the end of Phase 1:

- canonical `{ "$let": { ... }, "$in": ... }` expressions evaluate with lazy,
  memoized, mutually recursive, cycle-checked semantics;
- `$let` creates an expression scope, not a function call, and therefore does
  not consume call depth or call-shaped fuel;
- parameter binding, explicit binding scopes, and module initialization use
  separate entry points over shared low-level lazy-frame machinery;
- escaping JSON functions store attached local function definitions under
  `$captures`, never as newly added sibling keys;
- calling a JSON function restores registry metadata belonging to that
  function's definition rather than inheriting the caller's metadata;
- `$let` and `$captures` participate correctly in substitution, function-name
  scanning, transitive attachment, shadowing, and recursion;
- direct canonical-JSON evaluator tests cover the full Phase 1 matrix;
- the existing shorthand, checker, and legacy canonical fixtures still run.

Phase 1 is intentionally transitional. It adds the target evaluator model
without yet deleting every old input path.

## Non-goals

Do not include the following work in Phase 1:

- changing `where` or `do` lowering in `typescript/src/shorthand/parser.ts`;
- changing reconstruction in `typescript/src/shorthand/printer.ts`;
- adding the checker node or changing checker scope construction;
- rejecting all legacy function bodies with inline local keys;
- migrating all of `spec/cases/` or regenerating `spec/parse-cases/`;
- updating the public language and shorthand reference;
- porting Go, Python, or Rust.

The old zero-argument IIFE is still an ordinary valid call. During this phase
it also remains an encoding emitted by the old parser. No new code should
special-case it as `$let`.

## Runtime invariants

The implementation should preserve these invariants while the internals are
split:

1. A `$let` binding is evaluated only when its name is forced.
2. A forced binding is evaluated at most once per scope activation.
3. Every binding can refer to every sibling binding, including itself.
4. A value cycle reports the existing
   `Circular variable dependency detected: ...` error.
5. A binding can see its lexical parent, including function parameters.
6. A binding shadows an outer value and an outer function of the same name.
7. Function-valued siblings dispatch by name through the scope registry so
   recursive JSON is not embedded into itself.
8. An escaping function is self-contained JSON. Every non-persistent local
   function it still calls by name is represented under `$captures`.
9. Persistent module functions remain registry-backed and are not copied into
   `$captures`.
10. A registry-dispatched function receives the registry environment from its
    definition, never whichever local registry happened to call it.
11. Parameter defaults can see the function's own captures and other parameter
    bindings according to the existing parameter rules.
12. `$let` charges the normal one expression-node unit on entry. Each binding
    expression is charged only when forced. `$let` adds no invocation charge
    and does not increment `state.depth`.

## Target internal structure

### 1. One private lazy-frame engine, separate semantic entry points

The current `buildScope` in `typescript/src/eval/interpreter.ts` combines:

- materializing supplied, optional, defaulted, rest, and destructured params;
- evaluating function-body extra keys as lazy bindings;
- constructing a local function registry;
- tracking attachable function names;
- closing function-valued bindings over the resulting scope;
- initializing module scope.

Replace it with one private frame constructor and separate wrappers. Exact
names can follow local style, but their responsibilities should be equivalent
to:

```ts
type ScopeResult = {
  getVar: (name: string) => JSONType | undefined;
  functions: FunctionRegistry;
  localFns: ReadonlySet<string>;
  attachFns: ReadonlySet<string>;
};

createLazyFrame(input, parentContext, policy): ScopeResult
bindParameters(layout, args, context): ScopeResult
bindExpressionBindings(bindings, context): ScopeResult
initializeModuleBindings(module, context): ScopeResult
```

`createLazyFrame` owns the shared mechanics:

- pre-evaluated values;
- lazy expressions;
- memoization;
- the resolving-name stack and cycle error;
- parent `getVar` fallback;
- discovery and registration of function-valued bindings;
- non-attach `replaceVars` closure of those function definitions.

The wrappers determine policy:

- `bindParameters` populates parameter values/defaults and does not infer
  locals from arbitrary object keys;
- `bindExpressionBindings` treats every key in the explicit `$let` map as a
  binding and makes local function bindings attachable;
- `initializeModuleBindings` treats the module object as a persistent registry
  and makes its functions non-attachable.

Do not implement `$let` by fabricating a function body and calling the legacy
`buildScope`. The semantic entry points should remain distinct even if they
share the same private frame engine.

### 2. Temporary legacy function-body adapter

The parser still emits inline function-body locals in Phase 1, so they cannot
be rejected yet. Preserve them through a clearly named temporary adapter, for
example `bindLegacyFunctionFrame`.

This adapter matters because the current function frame allows parameter
defaults and inline locals to resolve through the same recursive `getVar`.
Blindly nesting a parameter frame outside a legacy-local frame can change that
behavior. The adapter should feed both parameter defaults and legacy bindings
to the private lazy-frame engine while the new target path remains:

1. seed the function's definition/capture registry;
2. bind parameters;
3. evaluate the structural `$return`;
4. let nested `$let` nodes create child binding scopes.

Mark the adapter for deletion in Phase 4. New `$let` tests must not use it.

### 3. Callee-owned registry environments

Clearing `localFns` and `attachFns` in the existing registry-dispatch branch is
necessary but not sufficient. It prevents stale caller metadata, but it would
also lose the sibling registry required when a recursive local function returns
a closure that calls another local function by name.

Associate each closed JSON function registered by a scope with the registry
environment in which that definition was created. A concrete implementation is
a module-private `WeakMap` keyed by `FunctionBody`:

```ts
type FunctionEnvironment = {
  functions: FunctionRegistry;
  localFns: ReadonlySet<string>;
  attachFns: ReadonlySet<string>;
};
```

Register this metadata after a binding scope has produced its closed local
function bodies and final registry. Do the same for closed module entries, with
an empty attachable set. The map is runtime metadata only:

- it is not serialized;
- it does not change canonical JSON;
- it cannot create JSON cycles;
- the key is the closed function body unique to the relevant activation.

When `callFunctionInternal` resolves a string to a JSON function body, invoke
that body with its recorded environment. Do not pass the caller's `getVar`,
`localFns`, or `attachFns`. If no owner entry exists, use the normal root
registry policy rather than caller-local metadata.

This is the structural fix for the stale-frame bug:

- a recursive call from a local scope to a module function restores the module
  function's module environment;
- a recursive call to a local function restores that local function's sibling
  registry;
- a direct function value restores serialized `$captures` as described below.

Keep the environment map close to registry construction and dispatch. A small
new `typescript/src/eval/function-environments.ts` is reasonable if keeping it
in `interpreter.ts` would make the scope split hard to follow.

### 4. `$captures` invocation model

`$captures` is an optional map on evaluator-produced function values:

```json
{
  "$params": ["x"],
  "$return": { "$call": "f", "$args": [{ "$var": "x" }] },
  "$captures": {
    "f": {
      "$params": ["value"],
      "$return": "<closed expression>"
    }
  }
}
```

On direct invocation of such a value, seed a capture scope before parameter
defaults or `$return` are evaluated. Capture names must be available:

- in registry call position;
- through `$fn`;
- through `$var`, matching the function-valued local behavior being replaced;
- while evaluating parameter defaults;
- while evaluating `$return`;
- for reattachment when a nested closure escapes.

Capture definitions are already closed. Register them without eagerly
evaluating them or recursively embedding sibling definitions. Treat capture
names as local and attachable for this invocation so a returned nested closure
can carry forward only the captured definitions it still references.

An in-memory registry environment takes precedence for a registry-dispatched
closed definition. `$captures` is the portable equivalent used when a function
has escaped that environment and is later invoked as a JSON value.

### 5. `$let` evaluation

Add a small `evaluateLet` helper called by the `ExpressionType.Let` switch arm:

1. create an explicit binding scope from `$let`;
2. evaluate `$in` in the returned context;
3. do not call `callFunctionInternal`;
4. do not directly charge fuel beyond the normal charge already performed by
   `evaluateExpression`.

The binding expressions remain unevaluated until `getVar` forces them.
Function-valued bindings are discovered structurally and registered before any
binding is forced, preserving recursion and mutual recursion.

## Canonical validation

Add `ExpressionType.Let` before generic object classification in
`typescript/src/eval/expression-type.ts`.

A valid let expression:

- is a non-array object;
- has both `$let` and `$in`;
- has no other keys;
- has a non-null, non-array object as `$let`;
- has at least one binding.

Classification validates the outer shape only. It must not eagerly evaluate or
recursively classify binding expressions, because an unused malformed binding
must remain lazy just as other unused bindings do. A binding expression is
classified when it is forced.

Reject at least these malformed shapes with stable, form-specific messages:

- `$let` without `$in`;
- `$in` without `$let`;
- non-object, null, or array `$let`;
- empty `$let`;
- an extra property;
- a mixed special-form object such as `$let` plus `$call`.

Use `Object.keys` for the exact two-key check. Unlike forms that deliberately
allow a comment key through `expressionKeyCount`, the canonical `$let` node is
specified as exactly `$let` and `$in`.

## Closure traversal rules

### `$let` in `replaceVars`

Handle `$let` before generic object recursion. Let `names` be
`Object.keys(node.$let)`. While traversing every binding expression and `$in`:

- mask `names` from `getVar`, so an outer value is not substituted for a
  recursively bound or shadowing name;
- mask `names` from `attachFns`, so an outer same-named function is not attached
  into a nested function before the new scope is activated;
- preserve literal dispatch for names whose binding expression is a function
  body by adding those names to the traversal's local-function set.

This masking applies to the whole recursive node, including every sibling
binding expression, because `$let` is letrec rather than sequential let.

### `$captures` in function-body traversal

`$captures` is structural runtime state, not an inline-local namespace:

- do not infer it as one legacy binding named `"$captures"`;
- treat its keys as bound function names while copying that function body;
- traverse capture definitions when scanning for transitive name references;
- keep traversal cycle-safe;
- preserve an existing capture map when adding newly required definitions.

`attachFreeLocalFns` should write:

```ts
body.$captures ??= {};
body.$captures[name] = definition;
```

It must no longer write `body[name] = definition`. Its duplicate checks should
look in `$captures` and in the body's actual bound names, not use `name in body`
as a proxy for both concepts.

The attachment queue still stores each definition once and scans attached
definitions transitively. Mutually recursive definitions appear as siblings in
one `$captures` map; they are not nested into one another.

### Existing function-body copying

During the transition, body-key inference must skip `$captures` everywhere it
currently skips `$return`, `$params`, `$sig`, `$types`, `$runtimeContract`, and
a string `$comment`. This applies to:

- temporary legacy-local discovery;
- `replaceVars` local-name masking;
- body-level function-name scanning.

Later phases delete the inference lists when function bodies become closed.

## File-by-file changes

### Required source changes

#### `typescript/src/types.ts`

- add `ExpressionType.Let`;
- add and export a `LetExpression` type;
- make evaluator-owned `$captures` explicit on `FunctionBody` while retaining
  its transitional index signature;
- optionally add a `FunctionCaptures` alias to avoid repeated casts.

No public export from `typescript/src/index.ts` is required unless tests or
downstream internal modules need the new named types.

#### `typescript/src/eval/expression-type.ts`

- classify and validate `$let`/`$in` before `isFunctionBody` and generic object
  classification;
- add the malformed-shape diagnostics described above;
- retain existing classification behavior for old IIFEs and legacy function
  bodies.

#### `typescript/src/eval/interpreter.ts`

- replace monolithic `buildScope` with the shared frame engine and semantic
  wrappers;
- add `evaluateLet`;
- add the `ExpressionType.Let` switch arm;
- make `callJSONFunction` seed `$captures`, bind parameters, and evaluate the
  structural `$return`;
- preserve old inline locals only through the temporary legacy adapter;
- change string registry dispatch to use the resolved body's owner environment,
  not caller `localFns`/`attachFns`;
- keep direct inline function calls free of the caller's lexical `getVar`.

#### `typescript/src/eval/closures.ts`

- add structural `$let` handling in `replaceVars`;
- mask let-bound names from substitution and attachment;
- make function-body copying understand `$captures`;
- update function-name scans for `$let` and `$captures`;
- change attachment output from sibling keys to `$captures`;
- merge captures transitively and cycle-safely;
- update comments that currently describe attachment as sibling locals.

#### `typescript/src/eval/program.ts`

- stop importing and calling the old `buildScope`;
- initialize module scope through the module-specific binding entry point;
- register module function owner environments with no attachable module names;
- keep module entry validation and stable name lookup unchanged.

#### `typescript/src/eval/internal-types.ts`

- update comments to describe definition-owned registry metadata;
- add a type or field only if the chosen owner-environment implementation needs
  one. Do not make caller propagation the new ownership mechanism.

#### `typescript/src/function-value.ts`

- no closed-schema rejection yet;
- if useful, add a small helper for reading a validated `$captures` map, but do
  not teach `isFunctionBody` to accept values without `$return`;
- keep authoring function bodies and evaluator-produced captured bodies in one
  runtime function-value category.

#### Optional new `typescript/src/eval/function-environments.ts`

- own the `WeakMap<FunctionBody, FunctionEnvironment>`;
- expose only registration and lookup;
- contain no serialization or language semantics.

This file is optional; the behavior is not.

### Required test changes

#### New `typescript/test/let-eval.test.ts`

Use hand-authored canonical JSON and `callFunction`. Do not parse shorthand in
this file. Cover:

- outer-shape validation;
- lazy unused bindings;
- memoization of a binding forced more than once;
- parent parameter capture;
- parameter and outer-local shadowing;
- nested `$let` shadowing;
- direct and indirect value cycles;
- recursive local function;
- mutually recursive local functions;
- `$var` and `$fn` access to function-valued bindings;
- an escaping closure whose exact JSON contains `$captures`;
- transitive and mutually recursive captures without cyclic JSON;
- a nested escaping lambda calling a rebound local function by name;
- the minimal stale-frame recursion from `plans/active/bugs.md`;
- the Dijkstra regression or a reduced graph case that preserves its trigger;
- direct `$captures` invocation after JSON stringify/parse;
- a capture referenced from a parameter default;
- `$let` fuel and call-depth behavior.

For memoization, supply a test-only host function that increments a counter and
return the same binding twice. Assert one host invocation. Do not infer
memoization only from equal pure values.

For serialization, stringify and parse the escaped function before calling it.
That ensures correctness comes from `$captures`, not the in-memory owner map.

#### `typescript/test/prepared-program.test.ts`

- strengthen the mutually recursive local-function test to inspect the escaped
  function shape;
- assert attached `even`/`odd` definitions live under `$captures`;
- assert they are not sibling body keys;
- retain the test that persistent module functions are not attached;
- add a serialize/parse/call assertion if that is not already covered in
  `let-eval.test.ts`.

#### Existing regression and parameter tests

Review and extend, without moving unrelated cases:

- `typescript/test/parameter-defaults.test.ts` for defaults that use serialized
  captures;
- `typescript/test/interpreter-performance-regressions.test.ts` for definition-
  owned registry dispatch and call-depth/perf assertions;
- `typescript/test/evaluate.test.ts` only if classification tests fit better
  there than in `let-eval.test.ts`.

#### Shared `spec/cases/`

Do not perform the Phase 4 bulk migration. Run the suite unchanged to prove the
temporary legacy adapter works.

Update a shared fixture in Phase 1 only if it asserts the exact JSON shape of an
escaping function whose attached local functions now move to `$captures`.
Do not rewrite ordinary inline locals or IIFE inputs yet merely because they
look old.

## Implementation sequence

Keep the branch testable in this order:

1. Add `LetExpression`, `ExpressionType.Let`, strict classification, and
   malformed-shape tests.
2. Extract the private lazy-frame engine while preserving all existing tests
   through the temporary legacy adapter.
3. Add the explicit expression-binding wrapper and `evaluateLet`; land basic
   lazy, recursive, shadowing, cycle, fuel, and depth tests.
4. Add callee-owned function environments and change registry dispatch; land
   the stale-frame and Dijkstra regressions with this step.
5. Add `$captures` attachment and invocation; update exact-shape tests.
6. Add `$let`/`$captures` traversal and transitive serialization tests.
7. Run the full TypeScript checks and inspect performance counters for
   accidental extra calls or closure-copy growth.

Avoid a midpoint where dispatch metadata is simply cleared without a
definition-owned replacement. Such a commit can make the original stale-frame
test pass while breaking recursive local functions that return closures.

## Simplifications delivered in Phase 1

These simplifications should be visible in the Phase 1 code, not deferred:

- `evaluateLet` has no call setup, argument validation, call-depth accounting,
  runtime-contract branch, or IIFE closure copy.
- parameter binding no longer scans a function body to discover bindings on
  the target path;
- module initialization no longer pretends a module object is a `FunctionBody`
  with an empty parameter layout;
- closure attachment has one storage location, `$captures`;
- registry dispatch no longer treats caller binding metadata as callee lexical
  state;
- `$let` introduces one explicit masking boundary in `replaceVars`;
- module non-attachment is a module policy rather than the accidental meaning
  of `attachFns === undefined`;
- tests can exercise local binding semantics without involving the shorthand
  parser or a synthetic call.

The old skip lists and legacy adapter remain temporarily, but new target paths
must not depend on them.

## Simplifications enabled now but deleted later

Track these as follow-up deletions rather than retaining them as permanent
architecture:

- `bindLegacyFunctionFrame` and arbitrary function-body local discovery:
  delete after parser/checker/fixtures use `$let`;
- parser `buildScope` and expression-level IIFE lowering: replace in Phase 3;
- printer recognition of IIFE-shaped `where`: replace in Phase 3;
- checker `bindingKeys`, open function-body scope construction, and
  IIFE-specific `where` handling: replace in Phase 2;
- structural-key skip lists used to distinguish locals from body metadata:
  delete when closed function-body validation lands;
- tests asserting attached local functions as sibling keys: replace with
  `$captures` expectations;
- the point-fix-only `maskedAttachFns` proposal in `plans/active/bugs.md`: the
  `$let` structural mask and definition-owned dispatch supersede it.

Phase 1 should leave explicit names or comments on temporary adapters so the
cleanup phase can find them without reconstructing why they exist.

## Verification

From `typescript/`:

```bash
bun run check
bun test
```

Also run focused tests during implementation:

```bash
bun test test/let-eval.test.ts
bun test test/prepared-program.test.ts
bun test test/parameter-defaults.test.ts
bun test test/interpreter-performance-regressions.test.ts
```

The Phase 1 acceptance checks are:

- all existing TypeScript tests pass with old shorthand lowering still active;
- every new canonical `$let` test passes without invoking the parser;
- malformed `$let` objects fail at their outer node;
- an unused binding is not evaluated;
- a repeatedly forced binding evaluates once;
- recursive and mutually recursive function bindings work both in scope and
  after escape;
- the stale-frame and Dijkstra regressions return correct values;
- an escaped closure survives JSON stringify/parse and calls its captures;
- capture maps contain no cyclic object graph;
- persistent module functions are absent from `$captures`;
- a capture used by a parameter default resolves;
- perf statistics show no additional `callFunctionInternal` or call depth for
  entering `$let`;
- binding-expression fuel is charged on first force only;
- no new attachment code writes a local function to an arbitrary function-body
  sibling key.

## Phase boundary handoff

Phase 2 can assume:

- `ExpressionType.Let` is stable;
- evaluator diagnostics identify malformed outer `$let` shapes;
- runtime letrec semantics are centralized in explicit binding machinery;
- function bodies may contain evaluator-owned `$captures`;
- function invocation and registry ownership no longer rely on caller scope.

Phase 2 must still add checker support before canonical `$let` emitted by the
parser can pass normal linked-module checking. Phase 3 then changes shorthand
lowering and printing. Phase 4 removes the temporary evaluator adapter,
migrates fixtures, closes the function-body schema, and updates public docs.
