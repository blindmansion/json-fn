# Performance & Data Optimization

json-fn is a tree-walking interpreter. Every expression — even a string literal
like `"X"` — passes through `evaluateExpression` and type dispatch. This means
the interpreter spends real time walking data structures that contain no
expressions at all. The optimization system addresses this by marking data as
**raw** so the evaluator can skip it.

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

## When you need `$literal`

`$literal` is for **constant data embedded directly in your JSON program**. The
automatic marking only covers function return values — it can't help with data
that lives in the expression tree itself, because that data is re-evaluated from
scratch every time the surrounding expression runs.

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

Every time this function is called, the evaluator walks `lines` — 8 subarrays of
3 integers each, 33 `evaluateExpression` calls — to produce the exact same array
every time. If this function is called 30,000 times (as in a minimax game tree),
that's ~1 million wasted evaluations.

Wrapping it in `$literal` tells the evaluator to return the value as-is and mark
it raw:

```json
"lines": { "$literal": [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]] }
```

Now `lines` is evaluated once (on first access, since local variables are lazy),
returns the raw-marked array, and every subsequent use — including closure
captures via `replaceVars` — skips it entirely.

**Use `$literal` when you have:**

- Lookup tables or configuration arrays inside function bodies
- Large constant objects (schemas, mappings, default values)
- Any data embedded in a function that's called in a loop or recursion

**Don't bother with `$literal` for:**

- Small constants in functions called a handful of times (the overhead of walking
  `{ score: -100, pos: -1 }` twice is negligible)
- Data that's passed in as a function argument (already handled by auto-marking
  if it came from another function)

`$literal` also serves as an escape hatch for **keyword collisions** — if your
data happens to have keys like `$fn`, `$var`, `$return`, etc., wrapping it in
`$literal` prevents the evaluator from misinterpreting it as an expression.

## When you need `raw()` (JavaScript API)

The `raw()` function is exported for host-level code that passes large data
structures into json-fn from JavaScript:

```typescript
import { callFunction, raw } from "json-fn";

const records = raw(loadRecordsFromDatabase()); // 10,000 records
callFunction("processRecords", [records], functions);
```

Without `raw()`, when `processRecords` captures `records` into a closure,
`replaceVars` walks the entire array — every record, every field — to check for
`$var` references that obviously aren't there. With `raw()`, that walk is
skipped.

**Use `raw()` when you're passing large datasets (hundreds or thousands of
objects) from JavaScript into json-fn.** For small inputs — a 9-element game
board, a configuration object with a few fields — the walk cost is negligible and
`raw()` adds nothing.

## How it works internally

All three mechanisms use the same underlying structure: a `WeakSet<object>` that
tracks which objects have been marked. The `WeakSet` is invisible to the marked
objects (no properties are added, no equality semantics change) and allows garbage
collection when objects are no longer referenced.

The evaluator checks the `WeakSet` in two places:

1. **`evaluateExpression`** — when processing an Array or Object expression type,
   it checks `isRaw()` first. If the value is marked, it's returned immediately
   without walking its elements/properties.

2. **`replaceVars`** — when capturing variables into a closure body, it checks
   `isRaw()` before walking into any object or array. If marked, the value is
   inlined as-is without traversal.

The cost of checking is a single `WeakSet.has()` call — effectively O(1).

## Summary

| Mechanism    | Scope                        | When to use                                      |
| ------------ | ---------------------------- | ------------------------------------------------ |
| Auto-marking | Function return values       | Automatic — no action needed                     |
| `$literal`   | Constants in JSON programs   | Hot-path constants, keyword collision prevention |
| `raw()`      | Host-level JavaScript inputs | Large datasets passed into json-fn               |
