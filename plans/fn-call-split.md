# Split the call/reference `$fn` form → `$call` + `$fn`

Status: **design sketch**, nothing implemented. Scopes one bullet of
`plans/core-form-simplification.md` (the "Split the call/reference `$fn` form"
candidate) into an executable migration.

## 1. Decision

Adopt the **fully split** direction: give calls and references distinct keys.

- **Call:** `{ "$call": <callee>, "$args": [ <arg>, … ] }`
- **Reference:** `{ "$fn": <callee> }` (unchanged key, now always non-array)

Rejected alternative — the `{ $fn, $args? }` form (callee always in `$fn`,
presence of `$args` marks a call). It removes the positional/`Array.isArray`
slicing but keeps a *within-key* discriminant ("does `$args` exist"), and leaves
a value / result-of-application distinction that differs by one optional key —
the same footgun the parent plan complains about. The full split makes
node-kind a pure key dispatch, uniform with `$var` / `$if` / `$cond` / `$match` /
`$and` / `$or`, and aligns syntactic kind with semantic kind (a reference's type
is a `$fnType`; a call's type is the callee's return).

Naming note: `$call` holds the callee (the thing being called), `$args` holds
the argument list. `$fn` is retained for the reference because that key already
means "a function value" in the surface (`&name`). No new reference key.

## 2. Canonical JSON, before → after

```jsonc
// call, with args
{ "$fn": ["add", 3, 4] }              →  { "$call": "add", "$args": [3, 4] }
// zero-arg call (the one-bracket footgun today)
{ "$fn": ["f"] }                      →  { "$call": "f", "$args": [] }
// computed / expression callee
{ "$fn": [{ "$var": "g" }, 1] }       →  { "$call": { "$var": "g" }, "$args": [1] }
// IIFE (inline lambda applied)
{ "$fn": [{ "$params": […], "$return": … }, 5] }
                                      →  { "$call": { "$params": …, "$return": … }, "$args": [5] }
// reference — unchanged
{ "$fn": "double" }                   →  { "$fn": "double" }
{ "$fn": <expr> }                     →  { "$fn": <expr> }
```

Invariants after migration:

- `$call` is always paired with `$args` (an array, possibly empty). A call node
  is exactly `{ $call, $args }` (+ optional `$comment`); no other keys.
- `$fn` is **never** an array. Any array-valued `$fn` is a pre-migration artifact
  and should fail validation.
- `$raw` payloads are literal data and are **never** rewritten.

## 3. Interpreter changes (TypeScript — canonical, land first)

All in `typescript/src/`. This is where the split actually pays off; the
positional `[0]`-callee / `[1..]`-args logic disappears.

- **`types.ts`** — `FunctionCall` becomes `{ $call: JSONType; $args: JSONType[] }`;
  `FunctionReference = { $fn: JSONType }` stays. `ExpressionType.FunctionCall` /
  `FunctionReference` enum members are unchanged.
- **`evaluate.ts`**
  - `classifyExpressionType`: dispatch `"$call" in json` → `FunctionCall`,
    `"$fn" in json` → `FunctionReference`. Delete the `Array.isArray(json.$fn)`
    sub-branch. Validate a call has exactly `$call` + `$args` (array) and nothing
    else; a reference has exactly `$fn`.
  - `evaluateFunctionCall`: read `fnCall.$call` for the callee and `fnCall.$args`
    for the arguments. Removes `fnArray[0]` / `slice(1)`.
  - `replaceVars`: replace the `idx === 0 && …` array special-case with direct
    handling — capture a free string callee from `$call`, then map
    `replaceVars` over `$args`. This is the marquee cleanup (evaluate.ts
    ~lines 878-888).
  - `collectLocalFnRefs`: read the callee from `$call` instead of `fnVal[0]`
    (evaluate.ts ~lines 920-923).
  - `FunctionReference` evaluation is unchanged (`fnRef.$fn`).
- **`shorthand/parser.ts`** — every place that currently emits
  `{ $fn: [callee, ...args] }` emits `{ $call: callee, $args: [...args] }`:
  the call rule (~L205), the zero-arg-scope IIFE for `where`/`do` leading pures
  (~L471, L712 → `{ $call: scope, $args: [] }`), the `bind` spine (~L732), the
  `handle` call (~L744), the `fncall` helper (~L913), and `pushArg` (~L918, now
  appends to `$args`). The **reference** emitters (`&name`, `&(expr)`, ~L327/330)
  keep emitting `{ $fn: … }`.
- **`shorthand/printer.ts`** — `renderObject` dispatches calls on `$call`
  (render `callee(args)`) and references on `$fn` (render `&…`). `renderFn`
  splits into a call renderer (reads `$call`/`$args`) and the existing reference
  branch. `tryRenderDo` / `collectDo` match on `$call === "bind"` / arg
  positions in `$args` instead of `fn[0]` / `fn[1..]`.
- **Internal node builders** (they construct call nodes directly, so they must
  switch too):
  - `task.ts` — the `pure` / `bind` / `handle` spine builders and the
    `{ $fn: [stepResume, …] }` applications (~L96-190).
  - `host.ts` — the effect-call recognizer that inspects `value.$fn` as an array
    (~L176-178) now inspects `$call`/`$args`.
- **`cli.ts`** — update the `to-shorthand` help example (~L51).

Round-trip guarantee (`parse ∘ print = id`) must still hold; the printer change
is the inverse of the parser change.

### 3.1 Redundant logic to delete (the whole point of the split)

Verified against the current code — each item is dead weight the value-shape
overload forced, and should be **removed**, not just re-keyed:

1. **Positional callee/args slicing (`evaluate.ts` `evaluateFunctionCall`).**
   Today: `const fnExpr = fnArray[0]!` plus a manual `for (let i = 1; i <
   fnArray.length; i++)` arg loop. After: callee is `fnCall.$call`, args are
   `fnCall.$args.map(evaluateExpression)`. Deletes the index loop and the `[0]!`
   non-null assertion on an unchecked slot.
2. **The `idx === 0` capture guard (`evaluate.ts` `replaceVars`, ~878-889).**
   The whole `fnArr.map((item, idx) => idx === 0 ? capture : recurse)` collapses:
   capture the callee once from `$call`, then `$args.map(replaceVars)`. No more
   position-in-array coupling; the marquee cleanup.
3. **Array-walk callee extraction (`evaluate.ts` `collectLocalFnRefs`,
   ~920-926).** `fnVal[0]` + "recurse the whole array (callee included)" becomes
   an explicit `$call` check + recurse `$args`. The callee string is no longer
   re-scanned as if it were a node.
4. **The value-shape sub-dispatch (`evaluate.ts` `classifyExpressionType`,
   ~1245-1258).** Delete the nested `if (Array.isArray(json.$fn)) … else if
   (typeof json.$fn === "string" || "object")`. Two flat key branches replace it
   (`$call` → call, `$fn` → reference), and the awkward `typeof === "object"`
   arm — which only existed because arrays *are* objects and had to be excluded
   by the preceding `isArray` — is gone.
5. **A latent bug disappears for free.** Today `{ "$fn": [] }` classifies as a
   *call* (any array), then `fnArray[0]!` yields `undefined` as the callee — a
   silent malformed state no guard catches. Post-split it's structurally
   impossible: a call always has a `$call` value. Likewise the `["f"]`-vs-`"f"`
   one-bracket footgun the parent plan calls out simply cannot be expressed.
6. **Printer branch + slicing (`printer.ts` `renderFn`, ~123-160).** The leading
   `if (!Array.isArray(fn)) { …reference… }` guard and `head = fn[0]; args =
   fn.slice(1)` go away: `renderObject` dispatches reference vs call by key, and
   the call renderer reads `$call`/`$args` directly.
7. **Do-spine offset arithmetic (`printer.ts` `tryRenderDo`/`collectDo`,
   ~222-254).** The `!Array.isArray(fn)` guards drop, and the callee-occupies-
   slot-0 arithmetic simplifies: `fn.length !== 3 || fn[0] !== "bind"` →
   `$args.length !== 2 || node.$call !== "bind"`, and `k = fn[2]` → `$args[1]`.
   The mental "+1 for the callee slot" model is eliminated.
8. **`length > 0` guard (`host.ts` effect scan, ~176-187).** `Array.isArray(fn)
   && fn.length > 0` then `fn[0]`/`fn[1]` becomes `"$call" in value` then
   `value.$call`/`value.$args[0]`; the emptiness guard is unnecessary because a
   call always carries a callee.
9. **`pushArg` reaches the right list (`parser.ts`, ~916-922).** Appending a
   flattened `++` operand pushes onto `$args` and guards on `$args` being an
   array, instead of mutating the shared callee+args `$fn` array.
10. **Type-level disjointness (`types.ts`).** `FunctionCall` (`$call`/`$args`)
    and `FunctionReference` (`$fn`) no longer share a key discriminated only by a
    runtime `Array.isArray`; the `as FunctionCall` / `as FunctionReference` casts
    become structurally sound rather than shape-assumed.

## 4. Codemod (mirrors the property-access migration in `typescript/scripts/`)

Reuse the exact structure that worked last time: one **shared pure transform**
plus **per-corpus driver scripts** that are dry-run by default, validate
aggressively, write compact JSON, and rely on `oxfmt` afterward to reflow to
canonical style (so untouched files stay byte-identical — no diff churn).

### 4.1 Shared transform — `scripts/fn-split-transform.ts`

Analogous to `canon-transform.ts`. A single deep rewriter:

```ts
// { $fn: [callee, ...args] }  →  { $call: toNew(callee), $args: args.map(toNew) }
// { $fn: <non-array> }        →  { $fn: toNew(value) }   (reference, key kept)
// $raw payloads               →  returned untouched
// everything else             →  recurse structurally
export function toSplitForm(value: JSONType): JSONType
```

Plus predicates for the validators:

- `hasLegacyFnCall(value)` — true if any `$fn` is array-valued (outside `$raw`).
  Drives "would migrate" detection and the post-transform "none remain" check.
- `isLegacyFnCall(node)` — a single array-`$fn` node, used to skip expected-diff
  subtrees in the "only call nodes changed" assertion.

Carry any `$comment` sibling onto the rewritten call, exactly as
`canon-transform.ts` does for `$var`.

### 4.2 Driver scripts (one per corpus)

Each takes `--write`, prints a summary, defaults to dry run:

- **`scripts/migrate-examples-fncall.ts`** (model: `migrate-examples.ts`) —
  rewrite `examples/*.json`. Validate: (a) no array-`$fn` remains, (b) transform
  is idempotent, (c) every node that isn't a legacy call is byte-identical
  before/after (the `collectUnexpectedChanges` walk, skipping `isLegacyFnCall`
  subtrees and `$raw`).
- **`scripts/migrate-spec-cases-fncall.ts`** (model: `migrate-spec-cases.ts`) —
  rewrite `body` / `functions` / `expected` on every case in `spec/cases/*.json`.
  Unlike the access migration, this split removes **no** behavior, so **drop no
  cases** — a pure shape rewrite. (Double-check for any case asserting the
  removed `["f"]`-vs-`"f"` bracket footgun or "function calls cannot have other
  properties" wording that now needs re-phrasing for `$call`/`$args`.)
- **`scripts/migrate-parse-cases-fncall.ts`** (model: `migrate-parse-cases.ts`) —
  rewrite each case's `expected` in `spec/parse-cases/*.json`; `source`
  (shorthand) is unchanged since **surface syntax does not change**, only its
  lowering target. Keep the faithfulness cross-check: re-parse `source` with the
  live parser and assert it equals the migrated `expected`.

### 4.3 Corpus scale

`$fn` appears in ~40 spec suites and the two normative docs; most occurrences are
calls, so the bulk of the churn is mechanical and fully covered by the transform.
Do **not** hand-edit these — regenerate via the scripts so the change is
auditable and reproducible.

## 5. Ordering

1. Land the **TS interpreter + parser + printer + internal builders** together
   (§3) behind the new canon. TS must build and its unit tests pass.
2. Run **`migrate-parse-cases-fncall.ts`** — its cross-check requires the updated
   parser to already emit `$call`/`$args`. Then `migrate-spec-cases-fncall.ts`
   and `migrate-examples-fncall.ts`. Apply with `--write`, then `bun run fix`
   (oxfmt reflow + spec-case format).
3. `bun test` + `bun run check` green.
4. Update **docs** (§6).
5. Other implementations (Go / Python / Rust) are known out-of-spec; update only
   if explicitly asked. The shared conformance suites now encode the target for
   whenever they're reconciled.

## 6. Docs to update

- **`docs/shorthand-spec.md`** — §2 overview table (`$fn` → `$call`/`$fn`), §4
  "Function calls and references" (the core before/after; the reference `&`
  subsection keeps `$fn`), §6 "operators lower to stdlib `$fn` calls" →
  `$call` calls, §5/§7/§8/§9 inline JSON examples. Supersede the note in §5 that
  predates this split if present.
- **`docs/language.md`** — the `$fn` reference sections and every embedded JSON
  example (72 occurrences); split into a `$call` (call) entry and a `$fn`
  (reference) entry.
- **`plans/core-form-simplification.md`** — mark this candidate as "spec'd →
  see `plans/fn-call-split.md`".

## 7. Non-goals / notes

- **No surface-syntax change.** `f(x)`, `&f`, method chains, `do`/`where`/`with`
  sugar all parse identically; only the JSON they lower to changes. Existing
  `.jfn` files need no edits.
- **Batch with sibling core-form work.** The parent plan sequences several
  breaking JSON-layer removals (comparator nodes, property-access collapse). This
  one is independent of those but shares the same codemod harness and the same
  "shorthand output changes in lockstep" discipline; land it in the same batch to
  amortize one breaking JSON bump.
- **Effects internals** (`task.ts`, `host.ts`) construct call nodes at runtime,
  so they are behavior, not corpus — covered by §3, verified by the effects spec
  suites (`effects-lib`, `effects-handle`, `effects-constructors`).
