# Design: `$let` as the only local-binding form

Companion to the scoping-bug report in `plans/active/bugs.md`.

## Compatibility posture

There are no external consumers and no compatibility requirement. This is a
breaking canonical-form change:

- stored programs and fixtures are migrated in place;
- legacy function bodies with inline local keys are rejected;
- the old zero-argument-IIFE lowering remains an ordinary valid function call,
  but is no longer recognized as an encoding of `where`;
- the printer only needs to preserve the new canonical form;
- no compatibility evaluator, checker path, migration command, or deprecation
  window is required.

Internal fixture churn is desirable when it removes transitional machinery.
The TypeScript implementation remains canonical; the other implementations can
port `$let` when they next resynchronize rather than constraining this design.

## Goal and canonical form

Introduce one explicit local-binding node:

```json
{
  "$let": {
    "name1": "<expr>",
    "name2": "<expr>"
  },
  "$in": "<expr>"
}
```

Bindings are lazy, memoized, mutually recursive, and cycle-checked: the letrec
semantics currently embedded in `buildScope`.

`$let` is the only local-binding form inside expressions. It is the lowering
target for both uses of shorthand `where` and for pure bindings introduced by
`do` desugaring. Function bodies contain structural keys only:

```json
{
  "$params": ["xs", "acc"],
  "$sig": { "...": "..." },
  "$return": {
    "$let": {
      "cur": "<expr>",
      "f": "<expr>"
    },
    "$in": "<expr>"
  }
}
```

The `.jfn` authoring surface does not change. Only canonical JSON changes.

## Why

The parser currently gives one shorthand construct two unrelated canonical
forms:

- function-body `where` becomes arbitrary extra keys on a function body;
- expression-level `where` becomes an immediately invoked zero-argument
  function.

The IIFE path routes pure binding through closure copying, escape attachment,
registry-dispatch context, call-depth accounting, and call-shaped fuel. That is
where the one-frame-stale scoping bug in `plans/active/bugs.md` arose.

The inline-key path makes function bodies open-schema scopes. Evaluator,
closure, printer, and checker code must each infer which keys are bindings by
maintaining structural-key skip lists. Those lists can drift, and a data object
containing `$return` is difficult to distinguish structurally from executable
code.

An explicit `$let` makes binding introduction visible to every subsystem:

- evaluator scope creation occurs at one expression kind;
- closure masking occurs at one structural boundary;
- checker letrec construction occurs at one node;
- function-body schemas become closed;
- shorthand has one canonical lowering;
- binding no longer pretends to be a function call.

## Target evaluator structure

`buildScope` currently combines three responsibilities:

1. parameter and default binding;
2. lazy, memoized, cycle-checked local letrec binding;
3. registration and closing-over of function-valued local bindings.

Split these responsibilities rather than copying `buildScope`:

- `bindParameters(layout, args, context)` creates the parameter/default frame;
- a binding-scope helper creates lazy value bindings plus the local function
  registry for an explicit binding map;
- `evaluateLet(node, context)` uses that helper and evaluates `$in`;
- `callJSONFunction` validates arguments, binds parameters, and evaluates the
  structural `$return`;
- module initialization deliberately reuses the lower-level binding-scope
  helper for its special top-level registry.

Parameter defaults remain lazy and can refer through their function frame as
they do today. A `$let` nested in `$return` sees parameters through the parent
`getVar` chain; no parameter-specific behavior belongs in `$let`.

Do not retain a generic “extra keys on a function body are locals” path.
Function bodies are validated against their closed structural key set.

That structural set needs one evaluator-owned closure field in addition to
source fields. Escaping closures currently serialize attached local functions
as extra body keys; removing inline locals requires replacing that encoding,
not merely rejecting it. Use an explicit optional `$captures` registry on
runtime function values:

```json
{
  "$params": ["x"],
  "$return": "<expr>",
  "$captures": {
    "f": "<closed function body>",
    "g": "<closed function body>"
  }
}
```

`$captures` is serialized closure environment, not an authoring-level binding
form. The shorthand parser never emits it. A function call seeds name dispatch
from this map before evaluating defaults or `$return`, so captures are in scope
for the entire invocation without reopening the function-body schema.

## Function-valued bindings and serializable closures

The closure model remains substitution-based: escaping closures must be
self-contained JSON for durable execution. Recursive and mutually recursive
functions cannot be eagerly substituted into themselves, so sibling function
names continue to dispatch through a scope-local registry and are attached when
a closure escapes.

The binding-scope helper therefore retains two internal cases:

- plain values use only lazy environment extension;
- function bodies are registered by name, closed over with `replaceVars` in
  non-attach mode, and remain eligible for `attachFreeLocalFns` on escape.

`replaceVars` gets an explicit `$let` branch. While copying binding expressions
and `$in`, it masks `Object.keys($let)` from both variable substitution and
function attachment. Escaping function bodies store attached definitions in
their `$captures` map instead of arbitrary sibling keys. Name-reference scans
include parameter defaults and `$return`, recurse transitively through captured
definitions, and keep the capture map cycle-safe. This is the structural
version of the point fix in `plans/active/bugs.md`, not a compatibility patch
for open function bodies.

Registry dispatch must stop forwarding a caller's `localFns`/`attachFns` into
the callee. The callee begins with registry context appropriate to its own
definition, and nested `$let` nodes introduce their own local metadata. Include
this cleanup in the refactor rather than leaving the deeper source of the
scoping bug in place.

## The module top level remains the deliberate exception

The top-level module object is a registry of named entry points, not an
expression-local scope. Module functions remain registry-backed for the
program's lifetime, excluded from escape attachment, and addressable by stable
name. Content addressing also needs that per-name identity.

Do not lower a module to one giant `$let`. Reuse the same low-level binding
mechanics where useful, but keep module validation, lifetime, and attachment
policy explicit. `$let` is the only binding node inside expressions, not a
replacement for the module format.

## Implementation plan

Implement in evaluator → checker → parser order. Compatibility code may exist
temporarily between commits to keep work testable, but none remains in the
finished change.

### Phase 1: evaluator and closure model

1. Add a strict `ExpressionType.Let` classification for exactly `$let` and
   `$in`. Validate that `$let` is an object of binding expressions and reject
   malformed or mixed special-form shapes.
2. Split `buildScope` into parameter binding and reusable explicit-binding
   mechanics. Keep module-root policy separate from expression-local policy.
3. Implement `evaluateLet` with lazy memoization, mutual recursion, cycle
   detection, parent lookup, and function-valued sibling registration.
4. Replace closure attachment through arbitrary function-body keys with the
   explicit `$captures` registry. Make invocation expose captures to parameter
   defaults and `$return`, and preserve transitive recursion without embedding
   cyclic JSON.
5. Add structural `$let` handling to `replaceVars`, function-name reference
   scanning, and attachment. Mask the let-bound names from substitution and
   attachment while traversing the node's interior.
6. Reset local-function/attachment metadata at registry dispatch boundaries;
   let the callee's `$let` nodes establish their own metadata.
7. Add direct canonical-JSON evaluator tests before changing the shorthand:
   lazy unused bindings, memoization, parent capture, parameter capture,
   shadowing, value cycles, recursive and mutually recursive functions,
   escaping closures, nested lambdas calling rebound functions by name, and the
   Dijkstra regression from `plans/active/bugs.md`.
8. Verify that `$let` itself consumes ordinary expression fuel but does not add
   a call frame or call-shaped fuel. Binding expressions continue to be charged
   when lazily evaluated.

At this phase boundary the parser can still emit old forms temporarily. The new
evaluator behavior must already be independently testable with canonical JSON.

### Phase 2: checker

1. Add a `let` node kind before generic object classification.
2. Extract reusable letrec type-scope construction from `buildTypeScope`.
   Parameters and `$let` bindings should use separate entry points even if they
   share environment machinery.
3. Check every binding in the recursive environment and check `$in` in the
   extended environment. Preserve lazy-local memoization, cycle reporting,
   creation-site narrowing facts, forcing-site facts, and function-binding
   signatures.
4. Report binding diagnostics at `$let.<name>` and body-result diagnostics
   under `$in`.
5. Make function-body checking structural: parameters/signature/defaults,
   `$return`, and validation of evaluator-produced `$captures`, with no scan for
   arbitrary local keys.
6. Remove checker logic whose only purpose was interpreting a zero-argument
   IIFE as `where`. Generic checking of real user-authored IIFEs remains.
7. Add checker tests paralleling the evaluator matrix, especially recursive
   type lookup, narrowing through lazy bindings, cycles, shadowing, and clean
   diagnostic paths.

### Phase 3: parser, printer, and canonical cutover

1. Change function-body `where` to emit a structural function body whose
   `$return` is `$let`/`$in`.
2. Change expression-level `where` to emit `$let`/`$in` directly.
3. Change all pure bindings produced by `do` desugaring to `$let`, including
   leading pure bindings and pure bindings inside bind continuations. Function
   bodies produced for continuations remain structural.
4. Teach the printer to render `$let` as `expr where { ... }`. In `$return`
   position, fold it into the normal function-body `where` syntax.
5. Update do reconstruction to consume `$let`-wrapped pure bindings rather
   than inspecting non-structural function-body keys or leading-pure IIFEs.
6. Reject evaluator-produced functions containing `$captures` in the shorthand
   printer with a clear error. Runtime closure environments have no authoring
   syntax and remain JSON-serialized durable values.
7. Remove printer support and inverse-desugaring assumptions for legacy
   binding shapes.
8. Tighten function-body validation/classification to the closed set of
   supported source keys plus evaluator-owned `$captures`. Reject every other
   stray key instead of treating it as a local.

### Phase 4: fixture migration, cleanup, and documentation

1. Use a one-off script to recursively migrate function bodies in canonical
   JSON: move each body's non-structural bindings into `$return.$let`, preserving
   insertion order and leaving module-root bindings at the module root. This is
   straightforward and should cover most `spec/cases` and function parse
   fixtures.
2. Regenerate parser expectations from each shorthand parse-case input after
   the parser cutover, then review the diffs. This safely handles
   expression-level `where` and do forms that cannot be distinguished from an
   intentionally authored IIFE by inspecting old canonical JSON alone.
3. Do not keep the migration script as a product feature unless it proves
   independently useful; there is no `jfn migrate` requirement.
4. Delete the temporary legacy evaluator/checker paths, body-key skip lists,
   old IIFE-where helpers, and tests asserting old canonical forms.
5. Update `docs/language.md` and `docs/shorthand-spec.md` to specify `$let` as
   the sole expression-local binding form. Describe the module root separately,
   not as legacy `$let`.
6. Update conformance cases with the full scoping regression matrix. The new
   canonical fixtures may intentionally fail lagging Go, Python, and Rust
   implementations until those implementations port `$let`; do not retain old
   encodings to accommodate them.

### Final verification

- Run TypeScript formatting, typechecking, linting, unit tests, parse/print
  round trips, conformance tests, and relevant performance suites.
- Confirm no function body with non-structural local keys remains in TypeScript
  sources, examples' generated forms, or shared fixtures.
- Confirm no parser path emits a binding IIFE.
- Confirm `where` no longer consumes call depth.
- Confirm escaping closures round-trip through durable JSON with `$captures`,
  including captures referenced by parameter defaults.
- Confirm module functions retain stable registry identity and are never
  attached recursively into escaping closures.

## What this buys

- **The bug class is removed structurally.** Name introduction occurs at one
  node with one masking rule, and binding no longer rides the call path.
- **Evaluator responsibilities become explicit.** Parameter frames, local
  letrec scopes, and module registries have separate APIs and policies.
- **Checker behavior mirrors evaluation.** Recursive type environments are
  created exactly where runtime binding environments are created.
- **`where` is cheaper.** It consumes no call frame, call-shaped fuel, or
  per-activation IIFE closure copy.
- **Function bodies are closed schemas now, not eventually.** Stray keys are
  validation errors rather than silent locals.
- **Canonical form is singular.** Parsing, printing, diagnostics, diffs, and
  content addressing all see one representation of local binding.
- **Durable invariants remain.** Closures stay serializable, recursive function
  names remain registry-dispatched, and module identity remains name-based.

## Decisions and deferred work

- Require at least one `$let` binding. The parser never emits an empty `$let`,
  and rejecting it avoids a meaningless canonical node and print/parse
  ambiguity.
- Charge normal expression fuel for entering `$let` and for each binding
  expression only when forced. Do not charge call fuel or call depth.
- Binding annotations are out of scope. The checker infers local binding types;
  a future syntax such as `where { m: number = mean(xs) }` can be designed
  independently.
- Porting Go, Python, and Rust is out of scope for this TypeScript-first change.
  Their implementations should adopt the new canonical form rather than add
  compatibility shims.
