# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.

## Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

### Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

### Arrays

Each element is evaluated recursively. `[1, { "$fn": ["add", 2, 3] }]` evaluates to `[1, 5]`.

### Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$fn": ["add", 1, 2] } }` evaluates to `{ "x": 3 }`.

### Function Call — `{ $fn: [...] }`

Calls a function. `$fn` is an array where the first element is the function (a name, body, or expression that resolves to one) and the remaining elements are arguments.

```json
{ "$fn": ["add", 3, 4] }
```

Nested calls — arguments can themselves be calls:

```json
{
  "$fn": ["mul", { "$fn": ["add", 2, 3] }, { "$fn": ["sub", 10, 4] }]
}
```

Zero-argument calls use a single-element array:

```json
{ "$fn": ["myFunction"] }
```

### Function Reference — `{ $fn }` (non-array)

When `$fn` is not an array, it evaluates the value and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions.

```json
{ "$fn": "double" }
```

### Variable Reference — `{ $var }`

Resolves a variable by name.

```json
{ "$var": "x" }
```

Dot/bracket notation accesses nested properties inline:

```json
{ "$var": "person.name" }
{ "$var": "items[0]" }
{ "$var": "data.items[1].name" }
```

`.key` accesses a string property, `[N]` accesses a numeric index (into an array, or into a string to get the character at that position), and `[key]` accesses a string key when the key is non-numeric. The first segment before any `.` or `[` is the variable name. Missing keys, out-of-bounds indices, or path traversal into non-object values return `null`.

For dynamic or computed keys, add `$get`. It evaluates to a string key, numeric index, or array path, and applies after any dot-notation path resolves:

```json
{ "$var": "person", "$get": "name" }
{ "$var": "items", "$get": 1 }
{ "$var": "person", "$get": ["address", "city"] }
{ "$var": "data.people[0]", "$get": "city" }
{ "$var": "data", "$get": { "$var": "fieldName" } }
```

**Variable name restriction**: Variable names (in `$params` and as local keys) must not contain `.` or `[`.

#### `{ $get, $from }` — Property Access on Expressions

For accessing properties on non-variable expressions (e.g. function results or literals), use `$get`/`$from`. `$from` evaluates to the target object/array.

```json
{ "$get": 0, "$from": { "$fn": ["concat", [10], [20]] } }
```

A numeric `$get` on a string returns the character at that index (`null` if out of bounds); a non-numeric `$get` on a string errors.

### Function Body — `{ $return, ... }`

Defines a function. Required key: `$return` (the expression to evaluate when called). Optional key: `$params` (array of strings). All other keys are **lazy local variables** — evaluated on first access.

```json
{
  "$params": ["n"],
  "remainder": { "$fn": ["mod", { "$var": "n" }, 2] },
  "$return": { "$eq": [{ "$var": "remainder" }, 0] }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$gt": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. If no condition matches, optional `$else` is evaluated and returned; without `$else`, the interpreter errors. Only the matched result or `$else` is evaluated.

```json
{
  "$cond": [
    [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$eq": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

`[true, ...]` still works as an explicit catch-all branch when you prefer to keep all branches inside the `$cond` array.

### Scalar Value Match — `{ $match, $cases, $else }`

Evaluates `$match`, then checks `$cases` left-to-right. Each case is a `[value, result]` pair; the first case value that is strictly equal to the matched value wins. `$match` and case values must evaluate to scalar JSON values (`null`, boolean, number, or string); arrays and objects are rejected instead of compared structurally. `$else` is required and is evaluated only if no case matches.

```json
{
  "$match": { "$var": "cmd" },
  "$cases": [
    ["show", { "$fn": ["showResult", { "$var": "state" }] }],
    ["reset", { "$fn": ["resetResult"] }],
    ["help", { "$fn": ["helpResult"] }]
  ],
  "$else": { "$fn": ["moveResult", { "$var": "state" }, { "$var": "argv" }] }
}
```

### Short-Circuit And — `{ $and }`

Array of expressions evaluated left-to-right. Returns the first falsy value, or the last value if all are truthy. Short-circuits (stops evaluating after the first falsy result).

```json
{
  "$and": [
    { "$gt": [{ "$var": "x" }, 0] },
    { "$lt": [{ "$var": "x" }, 100] },
    "in range"
  ]
}
```

Unlike the stdlib `and` function, `$and` does **not** evaluate all its operands — it is a language-level special form. It is also variadic (any number of operands).

### Short-Circuit Or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$fn": ["compute", { "$var": "x" }] }] }
```

### Comparison Shorthands — `{ $eq }`, `{ $neq }`, `{ $lt }`, `{ $lte }`, `{ $gt }`, `{ $gte }`

Each comparison shorthand takes an array of exactly two expressions, evaluates both, and returns a boolean. They are concise equivalents of the stdlib comparison functions.

```json
{ "$eq": [{ "$var": "status" }, "playing"] }
{ "$gte": [{ "$var": "score" }, 10] }
```

`$eq` and `$neq` use strict equality, not deep structural equality.

### Not Shorthand — `{ $not }`

Evaluates the expression and returns its logical negation using normal json-fn truthiness.

```json
{ "$not": { "$eq": [{ "$var": "status" }, "playing"] } }
```

### Literal — `{ $literal }`

Returns the value as-is without evaluating nested expressions. Use for constant data in hot paths or to prevent keyword collisions (data that happens to contain `$fn`, `$var`, etc. keys).

```json
{
  "$literal": [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8]
  ]
}
```

### Comments — `$comment`

A `$comment` key with a string value is ignored everywhere it appears as a sibling key in any expression form, and is stripped from plain-data objects. It survives JSON serialization, so unlike JSONC comments it round-trips through `parse → transform → stringify`.

```json
{
  "$comment": "classify a number by sign",
  "$params": ["n"],
  "$return": {
    "$cond": [
      [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
      [{ "$eq": [{ "$var": "n" }, 0] }, "zero"],
      [true, "positive"]
    ]
  }
}
```

Rules:

- The value **must be a string** to be recognized as a comment. Non-string values are treated as normal keys (and will typically cause "expression cannot have other properties" errors in expression forms).
- Allowed as a sibling key in any expression form (`$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`, `$or`, comparison shorthands, `$not`, `$literal`, `$get`/`$from`, `$return`/`$params`/locals).
- In plain data objects, `$comment` is stripped from the output. To preserve a literal `$comment` key in data, wrap with `$literal`.
- Inside `$literal`, the entire value is returned verbatim — `$comment` is preserved.
- Closures preserve `$comment` when a function body is returned as a value.

## Function Bodies

A function body has `$return` and optionally `$params`. All other keys are lazy locals.

### Parameters — `$params`

Array of strings. Arguments are bound positionally.

```json
{
  "$params": ["a", "b"],
  "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
}
```

Missing arguments default to `null`.

### Rest Parameters

A parameter starting with `...` collects remaining arguments into an array.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

Called with args `[1, 2, 3]`: `first` = `1`, `rest` = `[2, 3]`.

### Lazy Local Variables

Any key other than `$return` and `$params` defines a local variable. Locals are evaluated lazily (on first `$var` access) and can reference each other and `$params`. Key order within a function body does not affect evaluation — locals form a dependency graph resolved on demand, so the body behaves identically regardless of how a JSON parser orders the keys.

```json
{
  "$params": ["x", "y"],
  "sum": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$fn": ["mul", { "$var": "sum" }, 2] },
  "$return": { "$var": "doubled" }
}
```

## Closures

When a function body is returned as a value (not called), outer variables are captured by substitution. The interpreter walks the returned body and replaces `$var` references with their current values, respecting scope boundaries — inner `$params` and locals shadow outer names.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$fn": ["add", 10, { "$var": "y" }] }
}
```

The returned body is a valid function body that can be called subsequently.

## Scoping Rules

- `$params` and local variable keys create a scope within their function body.
- Inner scopes shadow outer scopes: if an inner function body has a `$param` or local named `x`, outer `x` is not substituted into it.
- Variables resolve by walking up the scope chain: params first, then locals in the current body, then the parent scope.

## Recursion

Functions can call themselves by name if registered in the function registry.

```json
{
  "$params": ["n"],
  "$return": {
    "$if": { "$lte": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$fn": ["mul", { "$var": "n" }, { "$fn": ["fact", { "$fn": ["sub", { "$var": "n" }, 1] }] }]
    }
  }
}
```

### Local Recursive Functions

Local variables whose values are function bodies (have a `$return` key) can be called by name within their scope. This enables recursion without registering in the global registry. Mutual recursion between sibling locals works too.

```json
{
  "$params": ["n"],
  "fact": {
    "$params": ["x"],
    "$return": {
      "$if": { "$lte": [{ "$var": "x" }, 1] },
      "$then": 1,
      "$else": {
        "$fn": ["mul", { "$var": "x" }, { "$fn": ["fact", { "$fn": ["sub", { "$var": "x" }, 1] }] }]
      }
    }
  },
  "$return": { "$fn": ["fact", { "$var": "n" }] }
}
```

Local function names can shadow global registry functions and do not leak into parent or sibling scopes.

## Dynamic Dispatch

The first element of `$fn` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$fn": [{ "$var": "fnName" }, 3, 4] }
}
```

Called with `["add"]` returns `7`. Called with `["mul"]` returns `12`.

## Standard Library

All functions listed below are available in the standard library.

### Arithmetic

| Function | Args     | Description              |
| -------- | -------- | ------------------------ |
| `add`    | `(a, b)` | `a + b`                  |
| `sub`    | `(a, b)` | `a - b`                  |
| `mul`    | `(a, b)` | `a * b`                  |
| `div`    | `(a, b)` | `a / b` (throws on zero) |
| `mod`    | `(a, b)` | `a % b`                  |
| `abs`    | `(a)`    | absolute value           |
| `neg`    | `(a)`    | `-a`                     |
| `floor`  | `(a)`    | floor                    |
| `ceil`   | `(a)`    | ceiling                  |
| `round`  | `(a)`    | round                    |
| `max`    | `(arr)`  | max of array             |
| `min`    | `(arr)`  | min of array             |

### Comparison

| Function  | Args     | Description                  |
| --------- | -------- | ---------------------------- |
| `eq`      | `(a, b)` | strict equality              |
| `neq`     | `(a, b)` | strict inequality            |
| `jsonEq`  | `(a, b)` | structural JSON equality     |
| `jsonNeq` | `(a, b)` | structural JSON inequality   |
| `gt`      | `(a, b)` | `a > b`                      |
| `gte`     | `(a, b)` | `a >= b`                     |
| `lt`      | `(a, b)` | `a < b`                      |
| `lte`     | `(a, b)` | `a <= b`                     |

`jsonEq` and `jsonNeq` compare arrays and objects recursively; object key order does not matter. They do not coerce types, so `true` is not `1` and `"1"` is not `1`.

### Logic

| Function | Args     | Description |
| -------- | -------- | ----------- |
| `not`    | `(a)`    | logical not |
| `and`    | `(a, b)` | logical and |
| `or`     | `(a, b)` | logical or  |

### Type Checking

| Function   | Args  | Description                           |
| ---------- | ----- | ------------------------------------- |
| `isNull`   | `(a)` | is null                               |
| `isBool`   | `(a)` | is boolean                            |
| `isNumber` | `(a)` | is number                             |
| `isString` | `(a)` | is string                             |
| `isArray`  | `(a)` | is array                              |
| `isObject` | `(a)` | is plain object (not array, not null) |

### Type Coercion

| Function | Args  | Description                        |
| -------- | ----- | ---------------------------------- |
| `str`    | `(a)` | to string (serializes non-strings) |
| `num`    | `(a)` | to number (throws if unparseable)  |

### Arrays

| Function   | Args                 | Description                            |
| ---------- | -------------------- | -------------------------------------- |
| `length`   | `(arr)`              | length (works on strings too)          |
| `head`     | `(arr)`              | first element                          |
| `last`     | `(arr)`              | last element (null if empty)           |
| `tail`     | `(arr)`              | all but first                          |
| `concat`   | `(...arrays)`        | concatenate arrays (variadic)          |
| `range`    | `(n)`                | `[0, 1, ..., n-1]`                     |
| `slice`    | `(arr, start, end?)` | slice                                  |
| `reverse`  | `(arr)`              | reversed copy                          |
| `includes` | `(arr, value)`       | strict contains check (works on strings) |
| `indexOf`  | `(arr, value)`       | strict index of value (-1 if missing)  |
| `flatten`  | `(arr)`              | flatten one level                      |
| `setAt`    | `(arr, idx, value)`  | new array with element at idx replaced |

### Strings

| Function | Args         | Description               |
| -------- | ------------ | ------------------------- |
| `upper`  | `(s)`        | uppercase                 |
| `lower`  | `(s)`        | lowercase                 |
| `trim`   | `(s)`        | trim whitespace           |
| `strcat` | `(a, b)`     | concatenate two strings   |
| `split`  | `(s, sep)`   | split string              |
| `join`   | `(arr, sep)` | join array with separator |

### Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall). Example: `"(?i)hello"`.

Match results are objects with `match` (full matched text), `index` (start position), `groups` (positional captures, `null` for unmatched optional groups), and `named` (named capture groups, empty object if none).

| Function     | Args                          | Description                                                |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| `reTest`     | `(pattern, str)`              | true if pattern matches anywhere in str                    |
| `reMatch`    | `(pattern, str)`              | first match object, or `null`                              |
| `reMatchAll` | `(pattern, str)`              | array of all non-overlapping match objects                 |
| `reReplace`  | `(pattern, replacement, str)` | replace all matches. `$0` = full match, `$1`/`$2` = groups |
| `reSplit`    | `(pattern, str)`              | split string by pattern                                    |

`reReplaceWith` is a higher-order variant listed under [Higher-Order Functions](#higher-order-functions).

### Objects

| Function      | Args          | Description                        |
| ------------- | ------------- | ---------------------------------- |
| `keys`        | `(obj)`       | array of keys                      |
| `values`      | `(obj)`       | array of values                    |
| `entries`     | `(obj)`       | array of `[key, value]` pairs      |
| `fromEntries` | `(pairs)`     | object from `[key, value]` pairs   |
| `merge`       | `(a, b)`      | shallow merge (b wins on conflict) |
| `hasKey`      | `(obj, key)`  | key exists check                   |
| `pick`        | `(obj, keys)` | select specified keys              |
| `omit`        | `(obj, keys)` | exclude specified keys             |

### Higher-Order Functions

Higher-order functions can invoke json-fn callbacks. The callback argument can be a function reference (`{ "$fn": "name" }`), an inline function body, or a string name.

| Function        | Args                       | Description                                                                      |
| --------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `map`           | `(callback, arr)`          | map. Callback receives `(item, index)`.                                          |
| `filter`        | `(callback, arr)`          | filter. Callback receives `(item, index)`.                                       |
| `reduce`        | `(callback, init, arr)`    | reduce. Callback receives `(acc, item, index)`.                                  |
| `find`          | `(callback, arr)`          | first match or `null`. Callback receives `(item, index)`.                        |
| `findIndex`     | `(callback, arr)`          | index of first match or `-1`. Callback receives `(item, index)`.                 |
| `some`          | `(callback, arr)`          | any match. Callback receives `(item, index)`.                                    |
| `every`         | `(callback, arr)`          | all match. Callback receives `(item, index)`.                                    |
| `sort`          | `(comparator, arr)`        | sorted copy. Comparator receives `(a, b)`, returns number.                       |
| `sortBy`        | `(keyFn, arr)`             | sorted copy by key function. keyFn receives `(item, index)`.                     |
| `flatMap`       | `(callback, arr)`          | map then flatten one level. Callback receives `(item, index)`.                   |
| `groupBy`       | `(keyFn, arr)`             | group into object. keyFn receives `(item, index)`, must return string or number. |
| `mapValues`     | `(callback, obj)`          | transform object values. Callback receives `(value, key)`.                       |
| `apply`         | `(fn, argsArray)`          | call `fn` with elements of `argsArray` as positional arguments.                  |
| `pipe`          | `(fns, init)`              | thread value through array of functions left-to-right.                           |
| `reReplaceWith` | `(pattern, callback, str)` | replace all regex matches via callback. Callback receives a match object.        |

### Introspection

| Function | Args   | Description                                                                                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `arity`  | `(fn)` | returns parameter count. For rest params, excludes the rest param. `null` for unknown functions. Argument is a function name (string) or body. |

### Debugging

| Function | Args              | Description                                                                                 |
| -------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `log`    | `(value, label?)` | passes `value` and optional `label` to the host-configured logger, then returns `value`      |

`log` is a tap-style debugging helper:

```json
{ "$fn": ["map", { "$params": ["x"], "$return": { "$fn": ["log", { "$var": "x" }, "item"] } }, [1, 2, 3]] }
```

By default, `log` is inert and produces no output. Host integrations may pass a logger when constructing the standard library to capture or emit logs. The output destination and format are host-defined.

> **Note: lazy locals.** Because non-`$return` keys in a function body are [lazy](#lazy-local-variables), a `log` call placed in an unreferenced local is never evaluated. To log inside a function body, either put the `log` call in the path of `$return`, or reference the debug local from `$return` so it actually runs.
>

## HOF Argument Order

Higher-order functions take **callback first, data second**. This is consistent across all HOFs: `map(callback, arr)`, `filter(callback, arr)`, `reduce(callback, init, arr)`, etc.

## Patterns

### Calling a registered function

Register the function body in the function registry, call it by name:

```json
{ "$fn": ["myFunction", 1, 2, 3] }
```

### Inline anonymous function

Use a function body directly as the first element of `$fn`:

```json
{
  "$fn": [
    {
      "$params": ["x"],
      "$return": { "$fn": ["mul", { "$var": "x" }, { "$var": "x" }] }
    },
    5
  ]
}
```

### Pipeline (filter -> map -> reduce)

Use local variables to chain steps:

```json
{
  "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "evens": { "$fn": ["filter", { "$fn": "isEven" }, { "$var": "nums" }] },
  "doubled": { "$fn": ["map", { "$fn": "double" }, { "$var": "evens" }] },
  "$return": { "$fn": ["reduce", { "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{ "$fn": ["pipe", [{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5] }
```

### Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] }
  }
}
```

### Dynamic Apply

Use `apply` to call a function with a dynamically constructed argument array:

```json
{ "$fn": ["apply", { "$var": "targetFn" }, { "$var": "collectedArgs" }] }
```

### Object Transformation

Use `entries` -> HOF -> `fromEntries` to transform objects:

```json
{
  "pairs": { "$fn": ["entries", { "$var": "obj" }] },
  "filtered": {
    "$fn": [
      "filter",
      {
        "$params": ["pair"],
        "$return": { "$gt": [{ "$var": "pair", "$get": 1 }, 3] }
      },
      { "$var": "pairs" }
    ]
  },
  "$return": { "$fn": ["fromEntries", { "$var": "filtered" }] }
}
```

## Execution Limits

Implementations enforce safety limits to keep evaluation bounded. Two of these are host-configurable; the third is always active.

### Circular Variable Dependencies

Lazy locals form a dependency graph resolved on demand. If resolving a local requires resolving itself — directly (`{ "x": { "$var": "x" } }`) or through a cycle (`a → b → a`) — evaluation errors instead of looping. The cycle is reported in the message, e.g.:

```
Circular variable dependency detected: a -> b -> a
```

This detection is always on and needs no configuration. It reports the first cycle reached, even when the cycle does not start at the first variable.

### Maximum Call Depth

Hosts may configure `maxCallDepth` to bound recursion depth (direct or mutual). Exceeding it errors:

```
Maximum call depth of 10 exceeded
```

Recursion that stays within the configured depth runs normally.

### Maximum Operations

Hosts may configure `maxOperations` to bound the total number of evaluation steps, catching expensive computations that are not necessarily deep (e.g. large `map`/`reduce` workloads). Exceeding it errors:

```
Maximum operations limit of 50 exceeded
```

When unset, `maxCallDepth` and `maxOperations` fall back to implementation-defined defaults. How limits are supplied is host-defined.

## Constraints

- `$var` must be the sole key, or paired only with `$get` for property access. The `$var` string may include dot/bracket path notation (e.g. `"person.name"`, `"items[0]"`).
- Variable names (in `$params` and as local keys in function bodies) must not contain `.` or `[`.
- `$get`/`$from` must be the only two keys (alternative property access form).
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` may have only `$cond` and optional `$else`; each entry must be a two-element array.
- `$match` must have `$match`, `$cases`, and `$else`; `$match` and case values must evaluate to scalar JSON values.
- `$and` must be the sole key; value must be an array of expressions.
- `$or` must be the sole key; value must be an array of expressions.
- `$eq`, `$neq`, `$lt`, `$lte`, `$gt`, and `$gte` must be the sole key; value must be an array of exactly two expressions.
- `$not` must be the sole key.
- `$literal` must be the sole key.
- `$fn` as an array (function call) must be the sole key. `$fn` as a non-array (reference) must also be the sole key.
- `$return` cannot coexist with `$fn`.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
