# Performance & Data Optimization

json-fn is a tree-walking interpreter. Every expression — even a string literal
like `"X"` — passes through `evaluateExpression` and type dispatch. This means
the interpreter spends real time walking data structures that contain no
expressions at all. The optimization system addresses this with raw values and
a fuel-preserving cache for constant expression subtrees.

## What happens automatically

Every function return value is automatically marked as raw data. This happens at
the call boundary in the evaluator — after any function (JSON function, builtin,
or external JS function) returns, its result is marked. The cost is a single
`WeakSet.add()` per call, and it's a no-op for primitive returns (numbers,
strings, booleans, null).

This means:

- Arrays returned by `map`, `filter`, `range`, `flatMap`, etc. are raw.
- Objects returned by `reduce` callbacks, `groupBy`, etc. are raw.
- Closures returned by higher-order functions are raw (and this is safe — their
  captured variables were already resolved by `replaceVars` before they were
  returned).
- Any data that flows through a pipeline of function calls accumulates raw marks
  at each stage.

When a raw-marked value later appears in an expression position (as an element in
an `$fn` array, or captured into a closure by `replaceVars`), the evaluator
recognizes it and returns it immediately without walking its contents.

**You don't need to do anything to benefit from this.** It handles the most common
case: data produced by one function flowing into the next.

Pure arrays and objects embedded in a program are also cached automatically.
Their first evaluation proves that every child is constant and records both the
original object identity and the number of expression nodes visited. Later
evaluations return that identity without walking or rebuilding the subtree.
They still charge the original node count, so fuel usage does not depend on
whether the same program object was evaluated earlier in the process.

Values substituted into escaping closures are marked raw as well. Substitution
therefore does not turn host data with expression-shaped keys such as `$call`
or `$var` into executable syntax.

## When you need `$raw`

`$raw` is for data embedded directly in a JSON program that must be inert from
its first evaluation. It is especially important when data has keys that would
otherwise classify it as expression syntax.

Consider a function that checks win conditions against a fixed set of lines:

```json
{
  "$params": ["board", "player"],
  "lines": [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ],
  "$return": { "$fn": ["some", "checkLine", { "$var": "lines" }] }
}
```

On first use, the evaluator walks `lines` — 8 subarrays of 3 integers each, 33
`evaluateExpression` calls — and caches the constant subtree. Later calls skip
that work automatically.

Wrapping it in `$raw` tells the evaluator to return the value as-is and mark
it raw:

```json
"lines": { "$raw": [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]] }
```

Now the first access also skips the contents. Every subsequent use — including
closure captures via `replaceVars` — remains O(1).

**Use `$raw` when you have:**

- Data with keys such as `$call`, `$var`, or `$return`
- A large constant whose first-evaluation cost matters
- A value that must be explicitly documented as inert data

**Don't bother with `$raw` for:**

- Ordinary constant arrays and objects; repeated evaluation is cached
- Data passed through function arguments and captured into closures; substituted
  values are marked automatically

`$raw` also serves as an escape hatch for **keyword collisions** — if your
data happens to have keys like `$fn`, `$var`, `$return`, etc., wrapping it in
`$raw` prevents the evaluator from misinterpreting it as an expression.

## When you need `raw()` (JavaScript API)

The `raw()` function is exported for host-level code that needs to declare a
value inert before it enters json-fn:

```typescript
import { callFunction, raw } from "json-fn";

const records = raw(loadRecordsFromDatabase()); // 10,000 records
callFunction("processRecords", [records], functions);
```

Closure substitution now marks captured data automatically, so `raw()` is
usually unnecessary for performance. It remains useful for expression-shaped
host data, especially objects that are structurally indistinguishable from
function bodies (for example an object with a `$return` key).

Use `raw()` when host data has expression keyword collisions or when the host
wants to make the inert-value boundary explicit.

## How it works internally

Explicit raw values and evaluated function results use weak identity sets.
Automatically discovered constant subtrees use a separate
`WeakMap<object, number>` whose value is their stable evaluation fuel cost. The
side tables are invisible to marked objects (no properties are added and
equality semantics do not change) and allow garbage collection when objects are
no longer referenced.

The evaluator checks the `WeakSet` in two places:

1. **`evaluateExpression`** — explicitly inert raw data is checked before
   expression classification, keeping expression-like keys inert. Ordinary
   arrays and objects then check the evaluated-value set and constant cache.
   Constant-cache hits charge the recorded descendant fuel before returning.

2. **`replaceVars`** — captured data values are raw-marked when substituted, and
   already-raw subtrees are never traversed. Function declarations are excluded
   so nested closure capture and local-function attachment remain active.

The cost of checking is a single `WeakSet.has()` call — effectively O(1).

## Summary

| Mechanism      | Scope                        | When to use                                 |
| -------------- | ---------------------------- | ------------------------------------------- |
| Auto raw       | Returns and captured values  | Automatic                                   |
| Constant cache | Pure data in program trees   | Automatic; preserves first-evaluation fuel  |
| `$raw`         | In-program inert data        | Keyword collisions or cold-path savings     |
| `raw()`        | Host-level JavaScript values | Explicit inert boundary / keyword collision |
