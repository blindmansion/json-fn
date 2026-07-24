# Design: `$let` as the single binding form — for `where` expressions _and_ function-body locals

Companion to the scoping-bug report (`json-fn-scoping-bug-and-let-lowering.md`). File references are to the TypeScript implementation @ `e9f76ef`.

## Goal

One canonical binding node:

```json
{ "$let": { "name1": <expr>, "name2": <expr> },
  "$in":  <expr> }
```

Bindings are lazy, memoized, mutually recursive, and cycle-checked — exactly the letrec semantics `buildScope` implements today. `$let` becomes the lowering target for **both** uses of `where` in the shorthand, and function bodies shrink to structural keys only:

```json
{ "$params": ["xs", "acc"],
  "$sig":    { ... },
  "$return": { "$let": { "cur": ..., "f": ... }, "$in": ... } }
```

The `.jfn` authoring surface does not change at all. `expr where { ... }` after a function arrow and `expr where { ... }` at expression level keep identical syntax; only what they compile to changes.

## Why: the current design has two lowerings for one construct, and one of them caused a soundness bug

Today the parser lowers the same shorthand construct two different ways:

- **Function-body `where`** inlines locals as extra keys on the body object. `src/shorthand/parser.ts:555-562`:
  ```ts
  const ret = this.parseExpr();
  const locals = this.eatKeyword("where") ? this.parseWhereBindings() : [];
  // A function body inlines its `where` locals directly (params + locals +
  // $return); no IIFE needed since this scope already exists.
  return this.buildScope(parsed.params, locals, ret, sig);
  ```
- **Expression-level `where`** wraps in an immediately-invoked zero-arg function (spec §8; `parser.ts:609`):
  ```json
  { "$call": { "cur": ..., "f": ..., "$return": <expr> }, "$args": [] }
  ```

The IIFE lowering routes pure binding through the closure machinery — `replaceVars` copying, escape attachment, registry dispatch context, a call frame against `maxCallDepth`, call-shaped fuel — and that is exactly where the one-frame-stale scoping bug lived (see the companion report). The inline-keys lowering has a different cost: **a function body is detected by the mere presence of `$return`** (`src/function-value.ts:3-5`):

```ts
export function isFunctionBody(value: unknown): value is FunctionBody {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "$return" in value;
}
```

so every object with `$return` is an open-schema scope whose arbitrary other keys are bindings. That forces skip-lists of structural keys in at least four places (`buildScope` in `src/eval/interpreter.ts:287-296`, `replaceVars`'s `localNames` computation in `src/eval/closures.ts:52-71`, `scanBodyLevelFnNameRefs` in `closures.ts:191-203`, and the checker), which must stay in sync by hand, and it makes data-vs-code classification depend on `raw`/`markEvaluated` WeakSet tagging (`src/utils.ts:69-90`) rather than structure.

`$let` gives both constructs one closed, explicit lowering.

## What `buildScope` actually does, and how it splits

`buildScope` (`src/eval/interpreter.ts:270-445`) currently performs three jobs:

1. **Param binding** — walks `layout.slots`, fills `evaluatedVars`, registers lazy defaults (`interpreter.ts:334-365`).
2. **Locals letrec** — the lazy, memoized, cycle-checked `getVar` over the body's extra keys (`interpreter.ts:367-425`).
3. **Function-name registration** — copies the registry (`scopedFunctions = { ...functions }`), inserts function-valued bindings, tracks `localFns`/`attachFns`, and closes each function binding over the scope with `replaceVars` in non-attach mode (`interpreter.ts:283-330`, `428-440`).

Job 1 is param-specific and stays with function calls. Jobs 2 and 3 are binding-specific and become the `$let` evaluator. Concretely:

- `callJSONFunction` (`interpreter.ts:447+`): validate args against `$params`, bind params into a fresh environment frame, evaluate `$return` in that frame. No letrec at the function-body level.
- New `evaluateLet(node, context)`: implement jobs 2 and 3 for `node.$let`, evaluate `node.$in` in the extended context. This is `buildScope` minus the slot-binding loop, so it is mostly code motion.

### Params need no special access mechanism

With the environment chain, `$let` bindings resolve free `$var`s through the enclosing `getVar` parent (`interpreter.ts:419-421` already falls through to `getVarParent`). A `$let` in `$return` position sees params the same way expression-level `where` sees enclosing locals today. Nothing new is required.

## Function-valued bindings keep the registry path — by design

The closure model is substitution-based: escaping closures are self-contained JSON (`replaceVars` substitutes free `$var`s at capture, `closures.ts:37-48`), which is what keeps closures serializable — a hard requirement for the durable-execution plans (suspend a continuation to JSON, resume elsewhere; `docs/durable-host.md`). Recursive and mutually recursive bindings cannot be eagerly substituted into themselves, which is why sibling function names stay literal and dispatch through `scopedFunctions`, with `attachFreeLocalFns` (`closures.ts:262-303`) re-attaching definitions when a closure escapes.

`$let` therefore keeps **two internal paths**, chosen per binding by `isFunctionBody(value)` exactly as `buildScope` chooses today (`interpreter.ts:297-300`):

- **Plain-value bindings**: lazy env-extension only. No registry copy, no attach eligibility, no `replaceVars` involvement.
- **Function-valued bindings**: registered into a scope-local registry, closed over with `replaceVars` (non-attach), eligible for `attachFreeLocalFns` on escape — the existing machinery, unchanged.

The rebinding mask that fixed the soundness bug (mask a scope's own names from `attachFns` when copying its interior — see the companion report's diff to `closures.ts:77+`) becomes structural: `$let` is the _only_ node that introduces names, so masking lives in exactly one place instead of being a property every body-shaped object must remember to enforce.

This also lets the registry-dispatch context leak be fixed properly. `callFunctionInternal`'s registry branch currently forwards the caller's `localFns`/`attachFns` into the callee (`interpreter.ts:181-192`) because a module function's _own_ nested locals ride on the same mechanism; once function-local binding is explicit `$let` inside the callee's `$return`, the callee can start from clean sets derived from its own structure, and the caller's binding metadata never crosses a name-dispatch boundary.

## The module top level stays as it is

`callProgram` (`src/eval/program.ts:124`) treats the top-level object as a registry of named entry points: module functions are deliberately registry-backed for the program's lifetime, excluded from attachment (`attachFns` is empty at root — `interpreter.ts:314-321` and the comment there about capture blow-up), and addressable by name. Content addressing (`plans/content-addressing/`) also wants stable per-name identity at this level. Lowering the module to one giant `$let` would entangle all of that for no benefit. The module remains the one special scope; `$let` covers everything inside it.

## Implementation plan

1. **Evaluator** (`src/eval/`): add `ExpressionType.Let` (`expression-type.ts`); implement `evaluateLet` by extracting jobs 2–3 from `buildScope`; slim `callJSONFunction`/`buildScope` to param binding. `replaceVars` gets a `$let` case: mask `Object.keys($let)` from both `getVar` and `attachFns` while copying `$let` values and `$in` (the one structural masking site), and run `attachFreeLocalFns` against the node on escape as the `FunctionBody` branch does today.
2. **Parser** (`src/shorthand/parser.ts`): both `where` sites lower to `$let`/`$in`. The function-body site (`:555-562`) emits `$params`/`$sig` + `$return: {$let, $in}` when locals exist; the expression site replaces the IIFE construction.
3. **Printer** (`src/shorthand/printer.ts`): print `$let`/`$in` as `expr where { ... }`; in `$return` position, fold into the function-body `where` form so round-tripping is stable.
4. **Checker** (`src/check/checker.ts`): a `$let` rule — check bindings in the letrec scope, check `$in` under the extended environment, report paths as `$let.<name>` (replacing today's `body.$args[0].$args[0].$return...` paths through the IIFE).
5. **Compatibility**: keep evaluating both legacy forms (bodies with extra keys; the IIFE pattern) behind the existing code paths, with the companion report's mask fix applied so legacy programs are also correct. Deprecate in the spec; a `to-json` flag or `jfn migrate` can rewrite stored programs.
6. **Spec & conformance** (`spec/`): specify `$let`; add conformance cases covering the bug-report repro matrix (nested-lambda name calls under recursion, mutual recursion in `$let`, cycle detection, shadowing) so the other three implementations port the semantics rather than the bug.
7. **Other implementations** (go/, python/, rust/): implement `$let` when they resync; the legacy-compat window keeps cross-implementation fixtures green meanwhile.

## What this buys

- **The bug class is removed structurally**: name introduction happens in one node with one masking rule, and binding never rides the call path, so no calling-context leak can contaminate it.
- **Cheaper `where`**: environment extension instead of a call — no frame against `maxCallDepth: 256` (headroom returns to real recursion), no call-shaped fuel, no `replaceVars` copy of the body per activation on the expression-`where` path.
- **Closed schemas**: `isFunctionBody` can eventually require exactly `$params`/`$sig`/`$types`/`$return`; stray keys become validation errors instead of silent unused locals — the right property for machine-generated programs.
- **One lowering per construct**: better for the checker, for diffs, and for content addressing.
- **Unchanged invariants**: substitution-based serializable closures, registry dispatch for recursion, durable-execution serialization, and the module model are all untouched.

## Open questions

- Should `$let` require at least one binding, or is `{"$let": {}, "$in": e}` legal (printer would just drop the `where`)? Suggest: legal but never emitted.
- Fuel model: charge per binding evaluation (as `getVar` evaluation already does implicitly) or a flat cost per `$let` entry? Suggest: no flat cost; laziness already meters actual work.
- Does `$sig`-style typing ever want per-binding annotations in `$let` (shorthand `where { m: number = mean(xs) }`)? Deferrable; the checker can infer today.
