# P4 + bare references: unified name resolution (TS plan)

Detailed implementation plan for two coupled changes, **TypeScript side only**.
The Rust/Go/Python mirrors and the `spec/cases` + `docs/shorthand-spec.md`
updates are deliberately out of scope here — do them once the TS shape is
validated (this is the same "change TS first, then port" cadence P1 used).

The two changes:

1. **P4 — variable-first name resolution.** A lexical binding (parameter,
   `where`-local, or module binding) of a name should shadow a same-named global
   (stdlib/host builtin), *consistently* whether that name is reached via operator
   desugaring (`+`→`add`, …), a direct call `f(x)`, or a bare reference.
2. **Bare registry names as references.** A bare identifier in value position
   that isn't a lexical binding but *is* a registered function resolves to that
   function reference (i.e. `map(length, xs)` == `map(&length, xs)`), instead of
   erroring with `Variable length not found`.

Both reduce to the same precedence rule, so they should land together.

---

## 1. Current behavior (measured)

Probed against the TS evaluator as of the P1 work (function-valued param calls +
expression-level `where`):

| Scenario | Result today | Shadows? |
| --- | --- | --- |
| top-level `add:(a,b)=>a-b`, `f:(x)=>x+1`, `f(10)` | `9` | ✅ yes |
| `where`-local `add:(a,b)=>a-b`, `f:(x)=>x+1`, `f(10)` | `9` | ✅ yes |
| **param** `add`, `f:(add,x)=>x+1`, `f(sub,10)` | `11` | ❌ **no** |
| **param** `map`, `f:(map)=>map(2)` (map is a fn) | uses **stdlib** `map` → error | ❌ **no** |
| `where`-local `length:(v)=>999`, `f:(x)=>length(x)` | `999` | ✅ yes |
| param `inc` (not a stdlib name), `f:(inc)=>inc(5)` | `6` | ✅ (P1 fallback) |
| `where`-local recursive `fact`, `f(5)` | `120` | n/a (registry dispatch) |
| bare stdlib name value: `f:()=>length` | **error** `Variable length not found` | — |
| bare user fn value: `f:()=>inc` | inlined fn body | — |

The split is crisp: **function-valued bindings shadow; parameters/value-locals
do not.** And bare registry names in value position are simply unreachable
without `&`.

---

## 2. Why the split exists (architecture recap)

Three facts about the evaluator explain everything above and constrain the fix.

**(a) Two homes for a name.** `buildScope` sorts a scope's members into two
places:

- `scopedFunctions` — a copy of the incoming registry (stdlib/host underneath)
  with the scope's *function-valued* members layered on top. This is what
  `callFunctionInternal` consults for a string callee.
- `evaluatedVars` / lazy `getVar` — parameters and every member as a lazily
  evaluated `$var`, chaining to the parent scope's `getVar`.

Function-valued bindings therefore live in the registry (so they shadow stdlib
by name); parameters live only in `getVar` (so the registry never sees them).

**(b) Registry-dispatched functions are called *without* a `getVar` parent.**
In `callFunctionInternal`, when a string callee resolves to a JSON function body
in the registry, it is invoked as:

```388:395:typescript/src/evaluate.ts
      } else {
        result = callJSONFunction(entry as FunctionBody, args, {
          functions,
          limits: context.limits,
          state: context.state,
          perf,
        });
      }
```

Note: no `getVar` is threaded in. A registry function's free variables were
already substituted at closure-creation time by `replaceVars`, so it needs no
enclosing lexical frame at call time. **This is the property that keeps local
recursion working** — and, as we'll see, is what makes a `getVar`-first flip
safe.

**(c) Closures capture free names at creation time via `replaceVars`.** When a
function body is returned/escapes, `replaceVars` walks it against the defining
scope's `getVar`, substituting free `$var`s and (after P1) free *callee*
identifiers. P1 made callee capture **registry-first**: it only captures a callee
when `functions[callee] === undefined`, so stdlib names and local function names
stay literal and keep dispatching through the registry.

---

## 3. Target semantics

One rule, applied at every site where a name is resolved:

> **Lexical-binding-first.** Resolve a name against the lexical scope chain first.
> If it resolves to a *function declaration*, use it. Otherwise fall back to the
> function registry (scoped local functions + stdlib/host). Only if both miss is
> it an error.

Consequences, made explicit:

- A **parameter or `where`-local bound to a function** shadows a same-named
  stdlib/operator — matching what module/`where` *function bindings* already do.
  Shadowing becomes uniform across operators, direct calls, and bare references.
- A lexical binding whose value is **not** a function declaration (e.g.
  `add: 5`) does **not** hijack a call position; resolution falls through to the
  registry. (Only function-valued lexical bindings shadow in call/operator
  position.)
- **Local function declarations keep dispatching through the registry**
  (recursion, mutual recursion, HOF-by-name) — see §4 for why the flip doesn't
  disturb them.
- A **bare registry name in value position** resolves to its name reference
  (`&`-free), because the registry fallback now applies in value position too.

This is "variable-first" as P1's note anticipated, phrased precisely: the axis is
*lexical function-valued binding* vs *registry*, not *`$var` node* vs *registry*.

---

## 4. TS implementation, site by site

There are exactly three resolution sites to touch. Operators need no dedicated
change — they desugar to named calls and inherit the call-site behavior.

### Site 1 — direct call resolution (`callFunctionInternal`)

Flip the string-callee branch from registry-first to lexical-first. Today
(post-P1):

```jfn
// registry-first: entry = functions[fn]; if undefined, try getVar fallback
```

Target:

```ts
if (typeof fn === "string") {
  // Lexical-first: a function-valued parameter/local shadows a same-named
  // global. Registry-dispatched functions are invoked without a getVar parent
  // (see §2b), so a local function's self/sibling references miss here and fall
  // through to the registry below — recursion is preserved.
  const lexical = context.getVar?.(fn);
  if (lexical !== undefined && isFnDeclaration(lexical)) {
    result = callFunctionInternal(lexical, args, context);
    raw(result);
    return result;
  }
  const entry = functions[fn];
  if (entry === undefined) {
    throw new Error(`Function ${fn} not found`);
  }
  // …existing builtin/external/JSON dispatch on `entry`…
}
```

Why this is safe for recursion and locals (the crucial part):

- **Local recursion / siblings.** A `where`-local function is called via the
  registry and (per §2b) runs with **no `getVar` parent**. Inside its body,
  `getVar("fact")` walks only its own params/locals → misses → returns
  `undefined` → we fall to `functions["fact"]` → registry dispatch. Unchanged.
- **Params shadowing.** A function called with a param `map` runs a `getVar`
  whose `evaluatedVars` contains `map`. Inside the body, `getVar("map")` returns
  the param function → used → shadows stdlib. Fixed.
- **Unshadowed operators/stdlib.** `getVar("add")` walks up to the module scope,
  finds no `add` binding, parent is `undefined` → returns `undefined` → registry
  stdlib `add`. Same result as today.
- **Module-level bindings.** `getVar("add")` at/under module scope finds the
  module `add` binding → shadows (already the case today; now via the lexical
  path instead of the registry copy, same value).

The `perf.functionCallCounts[fn]` accounting currently keyed on the string name
should move/duplicate so a lexically-resolved call still records under `fn`
(otherwise it'd count as `<inline>`). Minor.

### Site 2 — closure capture (`replaceVars`)

This is the subtle one. For param-shadowing to survive a function *escaping* its
defining scope, `replaceVars` must capture a free callee that resolves to a
*lexical function-valued binding* — but must **not** capture a *local function
declaration* (doing so re-inlines recursive bodies and breaks recursion; this is
exactly the 12-test regression seen during P1 before the registry-first guard).

Today's guard is `functions[callee] === undefined`, which is too coarse: it
refuses to capture a param named `map` (because stdlib `map` is in `functions`),
so `{ f:(map)=> (x)=> map(x) }` wouldn't shadow through the returned lambda.

Target guard: capture when the callee resolves via `getVar` to a function **and**
the callee is not a *scoped local function name*. That requires distinguishing
"stdlib/host registry entry" from "scoped local function" — which the flat
`functions` map can't do today. Options:

- **Option A (recommended): thread a `localFns: Set<string>` of scoped local
  function names.** `buildScope` already computes `localFnKeys`; accumulate them
  down the scope chain and pass to `replaceVars`. Capture rule becomes:

  ```ts
  if (idx === 0 && typeof callee === "string" && !localFns.has(callee)) {
    const captured = getVar(callee);
    return captured !== undefined && isFnDeclaration(captured) ? captured : item;
  }
  ```

  Masking already removes the current body's own params/locals from `getVar`, so
  free params of *enclosing* scopes are captured while the body's own recursive
  local names (in `localFns`) stay literal.

- **Option B (defer): leave `replaceVars` registry-first.** Accept a known gap:
  a parameter whose name collides with a stdlib builtin won't shadow *through an
  escaping closure* (direct, non-escaping use still works via Site 1). Document
  it. This keeps the change small; revisit if the corner actually bites.

Recommendation: ship **Option B** first to de-risk (it's a rare naming corner),
then follow with **Option A** once Site 1 + Site 3 are validated. Either way,
Site 2's guard must be decided consciously — it's the only place the "don't break
recursion" invariant can be violated.

### Site 3 — bare reference in value position (`resolveVar`)

`resolveVar` already checks `getVar` first, so it's lexical-first for free; we
only add the registry fallback:

```176:187:typescript/src/evaluate.ts
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

Target: thread `functions` in and, when `getVar` misses **and** there is no
trailing path, return the name if it's a registered function:

```ts
if (value === undefined) {
  if (parsed.path.length === 0 && functions[parsed.variable] !== undefined) {
    return parsed.variable; // bare registry name → function reference (== &name)
  }
  exprError(expression, `Variable ${parsed.variable} not found.`);
}
```

Call sites to update: the `VariableReference` case in `evaluateExpression`
(passes `context.functions`) and `evaluatePropertyAccess` (which also calls
`resolveVar`). The path guard keeps `length.foo` an error rather than
ref-then-walk.

### Site 4 — operators

No code change. `+`/`-`/`*`/… already desugar to `{ "$fn": ["add", …] }` etc.,
so they route through Site 1 and pick up lexical-first shadowing automatically.
This is what finally makes the operator case and the direct-call case *consistent*
(the stated P4 goal): both now shadow on function-valued lexical bindings and
both ignore non-function locals.

---

## 5. Invariants to preserve (regression checklist)

- Local recursion, mutual recursion, base cases (the "local function recursion
  via scoped registry" suite) — must stay green. This is the canary for Site 1
  and Site 2 mistakes.
- HOF-by-name (`map("inc", xs)` style, `&`-refs) unchanged.
- Unshadowed arithmetic (`n + 1`, `a * b`, unary `-`, `++`) unchanged and not
  measurably slower for the common path.
- Non-function local named like a builtin (`add: 5`) does **not** break the
  operator; falls through to stdlib.
- P1 behaviors intact: function-valued param calls (same-scope + curried
  `twice`/`compose`), expression-level `where`.

---

## 6. Risks & considerations

- **Perf.** Site 1 adds a `getVar` probe before every named call, including hot
  arithmetic. For unshadowed names this walks the scope chain to the module root
  and returns `undefined`. Likely negligible (a few property misses per call),
  but worth a quick benchmark on a numeric-heavy example (`life.jfn`) before/after.
  If it matters, a cheap mitigation is to skip the `getVar` probe when the name
  is known-registered *and* no lexical binding of it exists on the chain — but
  that reintroduces bookkeeping; don't pre-optimize.
- **Precedence coherence is the whole point.** After this change, Site 1/3/4 all
  agree: lexical function-valued binding first, registry second. Do not ship Site
  3 (bare refs) without Site 1, or the two positions disagree on shadowing.
- **Shadowing operators remains a footgun**, just a *consistent* one. P4's remit
  is consistency, not preventing shadowing; if we later want to forbid rebinding
  operator names, that's a separate authoring-lint decision (cf. the `cond`
  `else` policy), not an evaluator change.
- **`isFnDeclaration` treats any string as a callable ref.** A bare identifier
  bound to a non-function *string* value, used in call position, will be treated
  as a function name (consistent with the existing P1 fallback's looseness). Keep
  as-is for parity; note it when porting.

---

## 7. Test plan (TS)

Add `bun test` cases (co-located with the existing evaluate/scope tests):

1. Param shadows operator: `{ f:(add,x)=> x+1 }`, `f(sub, 10)` ⇒ uses the passed
   `add`.
2. Param shadows stdlib in direct call: `{ f:(map)=> map(2) }` with `map` a fn ⇒
   uses the param.
3. Param shadow survives an escaping closure (Option A only):
   `{ f:(map)=> (x)=> map(x) }` ⇒ param used after return.
4. `where`-local shadows (regression, already passes): `length`, `add`.
5. Local recursion / mutual recursion (regression): must stay green.
6. Bare registry name value: `{ f:()=> length }` ⇒ `"length"`;
   `map(length, xss)` ⇒ works.
7. Bare-name shadowing: local `length` var ⇒ local wins over stdlib in value
   position.
8. `length.foo` still errors (path guard).
9. Non-function local `add: 5` ⇒ `x+1` still uses stdlib `add`.

Then re-run the full suite + `bunx tsc --noEmit` + `oxlint`/`oxfmt`.

---

## 8. Sequencing

1. Site 3 + Site 1 + Site 4-by-inheritance, with Site 2 left registry-first
   (Option B). Land, validate, benchmark.
2. Update `docs/shorthand-spec.md` §4/§5 to state the unified precedence and that
   `&` is optional except for the computed `&(expr)` form.
3. Site 2 Option A (thread `localFns`) to close the escaping-closure param-shadow
   gap — only if we want full consistency.
4. Port to Rust/Go/Python; add `spec/cases/*.json` for the shadowing + bare-ref
   scenarios so all impls stay pinned.

---

## Out of scope (for this doc)

- Rust/Go/Python evaluator changes and `spec/cases` entries (step 4 above).
- Any parser change — bare-name resolution is intentionally evaluator-side; the
  parser can't know the host registry.
- Forbidding operator-name rebinding (separate authoring policy, if ever).
