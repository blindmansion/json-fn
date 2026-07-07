# Plan: Module scope (top-level `letrec`)

Status: **implemented in TypeScript** — Go / Python / Rust ports pending.

## Summary

Make a program's **top-level object a recursive, lazy binding scope** — the same
semantics function bodies already have for their locals — so that top-level
names (constants *and* functions) are visible via `$var` throughout the program,
not just callable via `$fn`.

Today a top-level definition is only reachable in **call position**. A bare
reference like `SIZE` (where `SIZE: mul(W, H)` sits at the top level) fails with
`Variable SIZE not found`, because the interpreter has no notion of a top-level
scope — the module object is inert data the host happens to register as a call
table. See the discovery writeup context: `examples/life.jfn` was written by an
AI given only `examples/chess.jfn`, and it naturally assumed module-level
constants (`W`, `H`, `SIZE`, `OFFSETS`) could be referenced as variables. They
could not; the example only runs after rewriting each constant as a nullary
function (`W: () => 20`, used as `W()`).

## Motivation

One syntactic form — an object mapping names to expressions — currently means
**two different things** depending on where it appears:

- **as a function body:** a lazy, order-independent, mutually-recursive scope
  whose names are `$var`-visible (see `docs/language.md` on locals);
- **at the top level:** inert data that the host spreads into a call-only
  registry (see `docs/shorthand-spec.md` §9, "Files and program shape").

That split is the wart. It forces a workaround idiom (nullary functions for
constants) to express, at the top level, something function bodies express
natively. This plan collapses the two: **an object-of-bindings is a scope,
everywhere.** The machinery for this already exists — it is exactly what
`callJSONFunction` does for a function body — so the change is mostly a refactor
plus one new host entry point.

### The single boundary rule

The one genuinely new question is how the module scope composes with the
host-supplied registry (stdlib + native builtins). We answer it with **one
rule**, and resist growing it into a module *system*:

> The module object is the **outermost lexical frame**; the host/stdlib registry
> is its **parent frame**. `$fn` and `$var` resolution are unchanged except that
> they now walk one additional frame.

## Current mechanics (TypeScript)

All references below are to `typescript/src/evaluate.ts` unless noted.

1. **`$fn` resolves against the registry**, `$var` does not. A `$var` miss with
   no lexical binder is a hard error:

```175:186:typescript/src/evaluate.ts
function resolveVar(
  varPath: string,
  getVar: (name: string) => JSONType | undefined,
  expression: JSONType,
): JSONType {
  const parsed = parsePath(varPath);
  const value = getVar(parsed.variable);
  if (value === undefined) {
    exprError(expression, `Variable ${parsed.variable} not found.`);
  }
  return parsed.path.length > 0 ? walkPath(value, parsed.path) : value;
}
```

2. **`callJSONFunction` is already a full lazy `letrec`.** It registers
   function-valued siblings into a `scopedFunctions` table (callable via `$fn`),
   exposes every sibling as a lazily-evaluated, memoized, cycle-checked `$var`
   via `getVar`, and closes local functions over that scope with `replaceVars`:

```428:439:typescript/src/evaluate.ts
  if (localFnKeys.length > 0) {
    for (const key of localFnKeys) {
      scopedFunctions[key] = replaceVars(fn[key]!, getVar, perf) as FunctionBody;
    }
  }

  return evaluateExpression(fn.$return, {
    functions: scopedFunctions,
    getVar,
    limits,
    state,
    perf,
```

3. **The finding that determines the whole shape:** a function resolved *by
   name* is invoked with a context that **deliberately omits `getVar`**, so
   every registry-resolved call starts a fresh lexical scope with no parent
   (this is what keeps json-fn lexically, not dynamically, scoped):

```307:314:typescript/src/evaluate.ts
      } else {
        result = callJSONFunction(entry as FunctionBody, args, {
          functions,
          limits: context.limits,
          state: context.state,
          perf,
        });
      }
```

   Consequence: seeding only the entry point's scope is **not enough** — the
   moment the entry calls another top-level function via `$fn`, that callee gets
   no parent scope and still cannot see module names. Module functions must
   therefore be **closures over the module scope**, which is precisely the
   `replaceVars` capture already applied to local functions (step 2).

## TypeScript plan

Purely additive: `callFunction` (`evaluate.ts:198`) stays intact, so no existing
caller changes behavior.

### 1. Extract a scope builder from `callJSONFunction`

Factor the scope-construction half of `callJSONFunction` (the local-fn
registration, param binding, the `getVar` closure, and the `replaceVars` capture
pass — roughly lines `362`–`432`) into a reusable helper:

```ts
function buildScope(
  fn: FunctionBody,
  args: JSONType[],
  context: EvaluationContext,
): { getVar: (name: string) => JSONType | undefined; scopedFunctions: FunctionRegistry } {
  /* ...existing lines 362–432, returning { getVar, scopedFunctions } instead of
     evaluating $return... */
}
```

`callJSONFunction` then becomes `buildScope(...)` followed by
`evaluateExpression(fn.$return, ...)`. This step is behavior-preserving and can
land on its own.

### 2. Add a program entry point

A module is a function body with no `$params` and no `$return`. Run it through
`buildScope` (no args), then invoke the chosen entry within the resulting scope:

```ts
export function callProgram(
  module: Record<string, JSONType>,
  entry: string,
  args: JSONType[],
  baseRegistry: FunctionRegistry, // stdlib + native builtins = the parent frame
  limits?: ExecutionLimits,
): JSONType {
  // resolve limits/state exactly as callFunction does today
  const { getVar, scopedFunctions } = buildScope(module as unknown as FunctionBody, [], {
    functions: baseRegistry,
    limits: resolved,
    state,
    perf,
  });
  // Fail fast: the entry must be a function *defined by the module*. Do not fall
  // back to `module[entry]` (an uncaptured body) and do not accept a bare
  // `scopedFunctions[entry]` — that table layers stdlib underneath, so a missing
  // entry that collides with a stdlib name (e.g. "map") would silently invoke
  // the builtin instead of erroring.
  const fn = scopedFunctions[entry];
  if (!Object.prototype.hasOwnProperty.call(module, entry) || fn === undefined) {
    throw new Error(`Program entry "${entry}" is not a function defined by the module`);
  }
  return callFunctionInternal(fn as FunctionDeclaration, args, {
    functions: scopedFunctions,
    getVar, // parent scope for the entry; module functions are already captured
    limits: resolved,
    state,
    perf,
  });
}
```

Notes:

- `scopedFunctions = { ...baseRegistry, ...capturedModuleFns }` realizes the
  boundary rule: module bindings shadow stdlib; stdlib is the parent frame.
- Each captured module function already had its free `$var`s substituted against
  the module scope, so calls *between* module functions (resolved via `$fn`
  against `scopedFunctions`) see module constants without needing `getVar`
  threaded through registry calls (step 3's constraint is satisfied).
- Recursive `$fn` self-calls (`stepN`, `settle`) remain names and resolve within
  `scopedFunctions`.
- The entry lookup **fails fast** rather than falling back to the raw module
  value. Because `scopedFunctions` layers the module over stdlib, membership must
  be checked against the module's own keys (not the merged table); otherwise a
  typo or a missing entry that shares a stdlib name would silently run the
  builtin, and a non-function constant would hand `callFunctionInternal` a value
  it cannot call.

### 3. Host wiring + example

- Export `callProgram` from `typescript/src/index.ts`.
- Rewrite the Life host `typescript/examples/life.ts` from
  `{ ...createStdlib(), ...module }` + `callFunction(functions.handleCommand, …)`
  to `callProgram(module, "handleCommand", [state, argv], createStdlib())`.
- Revert `examples/life.jfn`'s constants from nullary functions back to plain
  bindings (`W: 20`, `SIZE: mul(W, H)` / `W * H`, `OFFSETS: raw [...]`) and drop
  the `()` call sites. This becomes the regression example proving the feature.
- `typescript/examples/chess.ts` need not change (chess defines no top-level
  constants), but can optionally migrate to `callProgram` for consistency.

## Semantics and decisions

- **Eager-if-referenced, not lazy-on-first-use.** `replaceVars` forces a global
  the moment *any* captured function references it. Because `buildScope` captures
  **every** module function up front, this is stronger than "even on a code path
  that never runs": a referenced global evaluates on **every** program run
  *regardless of which entry is invoked* — `help` still forces `SIZE` if some
  other module function references it. This is **already** the semantics for
  local functions today, so it is consistent rather than new. Dead globals (those
  no captured function mentions) still never evaluate; referenced ones evaluate
  once per run. Worth documenting for anything impure (a global that calls `log`
  fires at load).
- **Load cost, especially for one-shot hosts.** In a CLI host, "load time" is
  every process invocation: `buildScope` re-runs its `replaceVars` capture over
  the whole module on each `callProgram`, and that structural walk is *not*
  fuel-metered (only the sub-evaluations it forces are). Two notes for hosts:
  (a) referenced globals evaluate once per program run, on every code path,
  including impure ones; (b) a stateful/long-lived host should build the module
  scope **once and reuse** the captured `scopedFunctions` across calls rather
  than calling `callProgram` per command. Note the reusable artifact is the
  captured function table (immutable, constants already inlined) — *not* the
  `getVar` closure, which closes over `CallState` (fuel/depth) and would leak
  counters if shared across runs.
- **stdlib layering / shadowing.** Module bindings shadow same-named registry
  entries. Identical in effect to today's host `{ ...stdlib, ...module }` spread,
  now expressed as the single boundary rule.
- **Lisp-2 preserved, with a syntactic shadowing asymmetry.** `$var` gains
  visibility of module *values*; `$fn` still resolves the function table. Module
  functions also become `$var`-visible as function values — consistent with how
  sibling function-locals already behave inside a body. The classification is
  **syntactic, not by runtime type**: only a binding whose value is literally a
  function body (has a `$return` key) enters `scopedFunctions`. So a module
  *constant* named `map` (e.g. `map: someExpr`, even if it evaluates to a
  function) shadows `$var map` but **not** `$fn map`, which still resolves stdlib
  `map`; a module *function* `map: (x) => …` shadows **both**. This is correct
  but surprising, so it must be stated explicitly and pinned by tests.
- **Cycles.** Module-level mutual recursion through `$var` trips the existing
  cycle detector; through `$fn` it is fine — identical to locals today.
- **Non-goal (hold the line):** multiple modules, `import`/`export`, re-exports,
  or shadowing policies. Those rebuild, one level up, the complexity this change
  removes. Keep it to a single outermost frame over the stdlib.

## Testing (TypeScript)

- `buildScope` refactor: existing suite must stay green (behavior-preserving).
- New unit tests for `callProgram`: top-level constant read via `$var`;
  top-level function reading a top-level constant; constant depending on another
  constant (`SIZE: mul(W, H)`); dead constant never evaluated; `$var` cycle
  detected; stdlib shadowing by a module binding.
- **Inner binders shadow module constants.** Module `W: 20` plus a function with
  a param (or local) named `W` must resolve to the param, not the module value —
  and the masking must hold for a *nested* inner function that reintroduces `W`,
  not just top-level params. (The `replaceVars` local-name masking already
  implements this; the test guards it against the collisions module scope makes
  common.)
- **Lisp-2 asymmetry (pin both directions).** A module *constant* named `map`:
  `$var map` sees the constant, `$fn map` still calls stdlib. A module *function*
  named `map`: both `$var map` and `$fn map` resolve the module function.
- **Module function passed as a value.** A module function used as an argument by
  name now works at top level (`map(cellGlyph, row)`), where previously only
  where-locals could do this. Test both the `$var` form (`cellGlyph`) and the
  `&cellGlyph` reference form, since they take different resolution paths.
- **Entry validation.** `callProgram` with an unknown entry, a non-function
  constant entry, and an entry name that collides with a stdlib function but is
  absent from the module all throw "not a function defined by the module" (no
  silent fallback to stdlib or to an uncaptured body).
- End-to-end: `examples/life.jfn` (reverted to plain constants) runs `show`,
  `step`, `settle`, `preset`, cell edits, and error paths.

## Docs to update once TS lands

- `docs/language.md`: introduce module scope alongside function-body locals;
  state the boundary rule.
- `docs/shorthand-spec.md` §9: replace "top-level object is inert data / calls
  resolve against those names" with "the file is the outermost `letrec` scope;
  the host supplies the parent (stdlib) frame and picks an entry point."
- `docs/host-integration.md`: document the `callProgram`-style entry point as the
  host contract (program value + entry name + args + base registry).

## Porting to Go / Python / Rust

The design is language-agnostic; only the entry-point plumbing differs. General
principles, in order:

1. **Confirm the same three facts** in each interpreter before porting:
   (a) `$fn` resolves the registry but `$var` does not; (b) the function-body
   evaluator already implements a lazy recursive scope with closure capture;
   (c) name-resolved calls start a fresh scope with no parent. The port is only
   correct if (b) is reused and (c) is satisfied by *capturing* module functions
   over the module scope (not by threading dynamic scope through calls).
2. **Extract the scope builder** from that interpreter's function-body evaluator,
   mirroring `buildScope`.
3. **Add the `callProgram` equivalent** as an additive entry point; keep the
   existing per-function call API intact.
4. **Layer** `moduleScope` over the host registry per the boundary rule.
5. **Reuse existing laziness + cycle detection**; do not reimplement.
6. Port the same test matrix; add the reverted `examples/life.jfn` run if the
   implementation has a host harness for it. In particular, the inner-binder
   shadowing and the Lisp-2 asymmetry are **observable semantics, not TS
   internals** — module scope makes those collisions common, so they belong in
   the shared conformance suite rather than as TS-only unit tests, to keep the
   ports from diverging.

Per-language plumbing notes:

- **Go:** entry point takes the module `map[string]any`, an entry name, args, and
  the base `FunctionRegistry`; return `{ getVar, scopedFunctions }` from the
  extracted builder.
- **Python:** mirror with a `call_program(module, entry, args, base_registry,
  limits=None)`; watch closure capture over the module dict.
- **Rust:** the borrow checker makes the captured-closure table the natural
  representation; build the module scope once and hand an `Rc`/owned map of
  captured function bodies to the entry call.

Land TypeScript first, stabilize the semantics and the test matrix, then apply
this list per implementation.
