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

`.key` accesses a string property, `[N]` accesses a numeric index (for arrays), and `[key]` accesses a string key when the key is non-numeric. The first segment before any `.` or `[` is the variable name. Missing keys or path traversal into non-object values returns `null`.

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

### Function Body — `{ $return, ... }`

Defines a function. Required key: `$return` (the expression to evaluate when called). Optional key: `$params` (array of strings). All other keys are **lazy local variables** — evaluated on first access.

```json
{
  "$params": ["n"],
  "remainder": { "$fn": ["mod", { "$var": "n" }, 2] },
  "$return": { "$fn": ["eq", { "$var": "remainder" }, 0] }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$fn": ["gt", { "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. Must include a catch-all (use `[true, ...]` as the last branch) or the interpreter errors.

```json
{
  "$cond": [
    [{ "$fn": ["lt", { "$var": "n" }, 0] }, "negative"],
    [{ "$fn": ["eq", { "$var": "n" }, 0] }, "zero"],
    [true, "positive"]
  ]
}
```

### Short-Circuit And — `{ $and }`

Array of expressions evaluated left-to-right. Returns the first falsy value, or the last value if all are truthy. Short-circuits (stops evaluating after the first falsy result).

```json
{
  "$and": [
    { "$fn": ["gt", { "$var": "x" }, 0] },
    { "$fn": ["lt", { "$var": "x" }, 100] },
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
      [{ "$fn": ["lt", { "$var": "n" }, 0] }, "negative"],
      [{ "$fn": ["eq", { "$var": "n" }, 0] }, "zero"],
      [true, "positive"]
    ]
  }
}
```

Rules:

- The value **must be a string** to be recognized as a comment. Non-string values are treated as normal keys (and will typically cause "expression cannot have other properties" errors in expression forms).
- Allowed as a sibling key in any expression form (`$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`, `$or`, `$literal`, `$get`/`$from`, `$return`/`$params`/locals).
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
    "$if": { "$fn": ["lte", { "$var": "n" }, 1] },
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
      "$if": { "$fn": ["lte", { "$var": "x" }, 1] },
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

| Function | Args     | Description       |
| -------- | -------- | ----------------- |
| `eq`     | `(a, b)` | strict equality   |
| `neq`    | `(a, b)` | strict inequality |
| `gt`     | `(a, b)` | `a > b`           |
| `gte`    | `(a, b)` | `a >= b`          |
| `lt`     | `(a, b)` | `a < b`           |
| `lte`    | `(a, b)` | `a <= b`          |

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
| `includes` | `(arr, value)`       | contains check (works on strings)      |
| `indexOf`  | `(arr, value)`       | index of value (-1 if missing)         |
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

| Function | Args              | Description                                                          |
| -------- | ----------------- | -------------------------------------------------------------------- |
| `log`    | `(value, label?)` | logs `value` (with optional `label` prefix) and returns it unchanged |

`log` is the only function in the standard library with an observable side effect. It is intended for tap-style debugging:

```json
{ "$fn": ["map", { "$params": ["x"], "$return": { "$fn": ["log", { "$var": "x" }, "item"] } }, [1, 2, 3]] }
```

The output destination and format are **implementation-defined**. Host integrations may expose a hook to redirect logs (for example, to capture them into a buffer instead of writing to stdout).

> **Note: lazy locals.** Because non-`$return` keys in a function body are [lazy](#lazy-local-variables), a `log` call placed in an unreferenced local is never evaluated. To log inside a function body, either put the `log` call in the path of `$return`, or reference the debug local from `$return` so it actually runs.
>
> **Implementation status.** Currently available in the TypeScript implementation only.

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
        "$return": { "$fn": ["gt", { "$var": "pair", "$get": 1 }, 3] }
      },
      { "$var": "pairs" }
    ]
  },
  "$return": { "$fn": ["fromEntries", { "$var": "filtered" }] }
}
```

## Constraints

- `$var` must be the sole key, or paired only with `$get` for property access. The `$var` string may include dot/bracket path notation (e.g. `"person.name"`, `"items[0]"`).
- Variable names (in `$params` and as local keys in function bodies) must not contain `.` or `[`.
- `$get`/`$from` must be the only two keys (alternative property access form).
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` must be the sole key; each entry must be a two-element array.
- `$and` must be the sole key; value must be an array of expressions.
- `$or` must be the sole key; value must be an array of expressions.
- `$literal` must be the sole key.
- `$fn` as an array (function call) must be the sole key. `$fn` as a non-array (reference) must also be the sole key.
- `$return` cannot coexist with `$fn`.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
