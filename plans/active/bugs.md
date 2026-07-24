# Soundness bug: `where`-local functions resolve one frame stale under recursion — plus a proposed `$let` lowering that removes the bug class

Tested against `main` @ `e9f76ef` (TypeScript implementation, the canonical one per AGENTS.md). Found while writing a Dijkstra implementation that silently returned wrong shortest-path distances.

## Summary

A where-local **function** binding, when called **by name from inside a nested lambda**, under recursion, resolves against the **previous activation's** scope. The result is silently wrong values with a characteristic one-frame lag — no error is raised. The trigger is narrow but natural (my first non-trivial program hit it), and for a language aimed at machine-generated programs, silent wrong answers are the worst failure mode.

- **Root cause:** `replaceVars` masks a function body's own bindings from `$var` substitution (`maskedGetVar`) but **not from name attachment** (`attachFns`/`localFnDefs`), combined with registry-dispatched calls inheriting the caller's attach context.
- **Point fix:** mask `localNames` out of `attachFns` when copying a body's entries — symmetric with `maskedGetVar`. One hunk in `src/eval/closures.ts`; full test suite passes (1,954 tests).
- **Design proposal:** stop lowering `where` to an immediately-invoked function and give the canonical JSON a first-class binding form (`$let`). This removes the entire bug class, cheapens every `where`, and cleans up checker diagnostics — with zero change to the `.jfn` authoring surface.

## Minimal reproduction

```jfn
// Run:      bun run src/cli.ts eval --file repro.jfn --function bad --args '[[1,2,3],[]]'
// Expected: [[1],[2],[3]]
// Actual:   [[1],[1],[2]]   <- frame N sees frame N-1's `cur`
{
  bad: (xs: any, acc: any) -> any =>
    if length(xs) == 0 then acc
    else (bad(tail(xs), concat(acc, [map((e) => f(e), [0])]))
          where { cur: head(xs), f: (e) => cur }),

  // Near-identical variants that are all CORRECT, isolating the trigger:

  // passing f to map by name (no wrapper lambda) works
  okPassByName: (xs: any, acc: any) -> any =>
    if length(xs) == 0 then acc
    else (okPassByName(tail(xs), concat(acc, [map(f, [0])]))
          where { cur: head(xs), f: (e) => cur }),

  // calling f directly in arg position (no lambda) works
  okDirectCall: (xs: any, acc: any) -> any =>
    if length(xs) == 0 then acc
    else (okDirectCall(tail(xs), concat(acc, [f(0)]))
          where { cur: head(xs), f: (e) => cur }),

  // lambda capturing the plain value `cur` (not a function binding) works
  okCaptureValue: (xs: any, acc: any) -> any =>
    if length(xs) == 0 then acc
    else (okCaptureValue(tail(xs), concat(acc, [map((e) => cur, [0])]))
          where { cur: head(xs) })
}
```

The trigger requires all of: (1) a where-local _function_ binding, (2) called _by name_ from a _nested_ function body, (3) under recursion dispatched _by name_ through the registry. Real-world instance (how I found it) — Dijkstra with a helper closure:

```jfn
step: (g, unvisited, dist, prev) =>
  ...
  step(g, rest,
    merge(dist, fromEntries(map((e) => [e.to, altOf(e)], improved))),  // <- altOf by name in a lambda
    ...
  ) where {
    cur:    ...,
    curDist: ...,
    altOf:  (e) => curDist + e.w,   // <- where-local function
    improved: filter((e) => altOf(e) < ..., edges)
  }
```

This silently returned shortest-path distance **5** for a graph whose true answer is **7**, with a distance map one relaxation step behind at every node.

## Root cause

Three interacting mechanisms:

**1. `where` lowers to an inline immediately-invoked function.** `expr where { locals }` desugars to:

```json
{ "$call": { "cur": ..., "f": ..., "$return": <expr> }, "$args": [] }
```

so the where-body is an _inline callee_, and inline callees are copied by `replaceVars` **in attach mode** (interpreter.ts, `ExpressionType.FunctionBody` → `replaceVars(..., localFnDefs = context.functions)`).

**2. Registry dispatch leaks the caller's attach context.** In `callFunctionInternal` (interpreter.ts), the registry-dispatch branch invokes the callee with the caller's context:

```ts
result = callJSONFunction(entry as FunctionBody, args, {
  functions,                       // caller's scopedFunctions — contains frame N's closed-over `f`
  localFns: context.localFns,      // contains "f"
  attachFns: context.attachFns,    // contains "f"
  ...
});
```

So when frame N recursively calls `bad` by name, frame N+1 executes with frame N's closed-over `f` present in `functions` and eligible in `attachFns`.

**3. `replaceVars` masks rebinding for `$var`s but not for attachment.** In the `FunctionBody` branch of `src/eval/closures.ts`, the body's own bindings are masked from variable substitution:

```ts
const maskedGetVar = (name) => (localNames.has(name) ? undefined : getVar(name));
```

…but the recursive copy of the body's entries passes `attachFns` and `localFnDefs` through **unmasked**. So while frame N+1's where-body node is being copied from the stable module AST, the nested map-lambda inside it calls `f` by name, `f` is in the (inherited, stale) attach set, and `attachFreeLocalFns` embeds **frame N's** closed-over `f` into the lambda — _at copy time_, before the enclosing where-body ever rebinds `f` for frame N+1.

When that lambda later escapes for real (as `map`'s argument), the attacher sees `f` already present in the body (`if (name in body ...) continue`) and skips — so the stale binding shadows the fresh per-activation one. `buildScope` for the lambda then registers the stale local `f`, producing the one-frame lag.

**Why the ok-variants don't trigger:** `map(f, [0])` passes `f` as a `$var`, which goes through the _correctly masked_ `maskedGetVar`; `f(0)` in direct call position resolves through the live registry at execution time; capturing plain `cur` is `$var` substitution, also masked. Only "nested body calling a rebound local function _by name_" walks the unmasked path.

Debug-trace evidence (frame 2's where-body copy, fresh from the _clean_ stable AST, already contaminated at copy time):

```
[closeover] f => {"$params":["e"],"$return":2}                         <- frame 2 closes f correctly
[escape]    {"$params":["e"],"$return":{"$call":"f",...},
             "f":{"$params":["e"],"$return":1}}                        <- but the escaping lambda carries frame 1's f
```

## Point fix

Mask the body's own `localNames` out of `attachFns` when copying its entries — exactly parallel to `maskedGetVar`. In `src/eval/closures.ts`, `replaceVars`, `FunctionBody` branch:

```diff
       const maskedGetVar =
         localNames.size > 0
           ? (name: string) => (localNames.has(name) ? undefined : getVar(name))
           : getVar;

+      // Names this body rebinds must be masked from attachment inside it,
+      // exactly as maskedGetVar masks them from $var substitution. Otherwise a
+      // nested lambda calling a rebound name gets the ENCLOSING scope's stale
+      // definition attached at copy time, shadowing the fresh per-activation
+      // binding (one-frame-stale results under recursion).
+      let maskedAttachFns = attachFns;
+      if (localNames.size > 0 && attachFns.size > 0) {
+        let needsMask = false;
+        for (const n of attachFns) if (localNames.has(n)) { needsMask = true; break; }
+        if (needsMask) {
+          const m = new Set<string>();
+          for (const n of attachFns) if (!localNames.has(n)) m.add(n);
+          maskedAttachFns = m;
+        }
+      }
+
       const newObject: Record<string, JSONType> = {};
       for (const [key, value] of Object.entries(expression)) {
         newObject[key] = replaceVars(
           value,
           maskedGetVar,
           localFns,
-          attachFns,
+          maskedAttachFns,
           localFnDefs,
           context,
         );
       }
```

Note the mask applies only to the _entry-copy recursion_; this body's own `attachFreeLocalFns` call (bottom of the branch) still uses the full `attachFns`, so escape capture, recursion, and mutual recursion are unaffected.

**Validation:**

- All repro variants return correct results (`[[1],[2],[3]]` etc.).
- The original Dijkstra (helper called by name in lambdas) now yields the textbook-correct distance map (`E: 7`).
- Full suite: **1,954 pass, 0 fail** (`bun test`).

A more thorough alternative worth considering: reset/scope `attachFns`/`localFns` at registry-dispatch boundaries in `callFunctionInternal`, since leaking the caller's binding metadata into a name-dispatched callee is the deeper enabler. The mask above is the minimal, locally-symmetric fix.

## Design proposal: a first-class binding node instead of the IIFE lowering

The point fix closes this bug, but the bug _class_ comes from encoding `where` as "immediately-invoked zero-arg function." That puts pure binding on the closure-capture path — `replaceVars`, escape attachment, registry context, call depth — none of which binding needs. Observed costs of the current encoding:

- Where-bodies travel the escaping-closure machinery every activation (where this bug lived).
- Every `where` consumes a call frame (counts against `maxCallDepth: 256`) and fuel for a call that isn't one.
- Checker paths are noisy: errors read `body.$args[0].$args[0].$return.$args[0]` instead of naming a binding.
- "IIFE that means let" is an encoding pun — awkward for canonical-form concerns like content addressing (`plans/content-addressing/`), where you want exactly one obvious lowering per construct.

### Proposed canonical form

```json
{ "$let": { "m": { "$call": "mean", "$args": [{ "$var": "xs" }] } }, "$in": { "$var": "m" } }
```

Semantics identical to today's where-locals: lazy, memoized, mutually-recursive, cycle-checked (i.e. `buildScope`'s letrec, minus params). The evaluator extends the environment chain in place — no copy, no attach, no frame, no fuel-as-call. The masking rule the fix adds by hand becomes _structural_: every binding node masks its names from both substitution and attachment, in one code path.

An alternative considered: generalize the function-body convention so _any_ `$`-tagged node may carry non-`$` keys as locals for that expression (uniform with `{$params, locals, $return}` today, and 1:1 with `expr where {…}` on any node). Rejected in favor of `$let` for one reason that matters here specifically:

### Why `$let` (closed) over extra-keys (open), given a shorthand-first authorship model

The authoring surface is clearly intended to be the `.jfn` shorthand (and the
token math is decisive — the repro above is ~90 chars of shorthand vs ~700
chars of canonical JSON, a 5–8× multiplier). If humans and LLMs author only
shorthand, the lowered JSON is effectively bytecode, and it should be optimized
as one:

- **Closed schemas everywhere.** With extra-keys, every node type is open-ended and a stray key silently becomes an unused local. With `$let`, validation stays strict — the right property for machine-generated, machine-validated programs.
- **Checkability.** A dedicated node gives the checker a clean anchor: `$let.m` in error paths.
- **Canonical stability.** One obvious lowering per construct; semantic equality and content addressing stay simple.
- **Unused-binding detection moves to the compiler**, where it belongs: the shorthand parser knows a `where` binding is never referenced and can warn at authoring time.

### Migration

- The shorthand does not change at all; only the lowering target of `where` does (parser + printer + evaluator + checker).
- The old IIFE encoding remains valid JSON and keeps evaluating; deprecate rather than break. (With the point fix applied, old programs are also _correct_ during the transition.)
- Wins: removes this bug class structurally; `where` becomes O(1) environment extension instead of a call; frees `maxCallDepth` headroom for actual recursion; cleaner diagnostics.

## Appendix: tooling notes from the same session (minor)

- Parse errors are terse where a hint would land: `parse error at 26:8: unexpected character '$'` for a malformed `where` could suggest `expr where { name: value, ... }`. Given LLM authorship, both syntax errors I made were TypeScript-pattern bleed-through (`$return =` inside `where`; `[node: string]` for map types) — parser errors that teach the correction would pay for themselves in retry tokens.
- The typechecker is already earning its keep: it caught a swapped `mapIndexed` callback (`(i, s)` vs `(s, i)`) statically, with a precise path, before evaluation.
