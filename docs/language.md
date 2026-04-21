# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.

## Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

### Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

### Arrays

Each element is evaluated recursively. `[1, { $fn: "add", $args: [2, 3] }]` evaluates to `[1, 5]`.

### Plain Objects

Each value is evaluated recursively (keys are not). `{ x: { $fn: "add", $args: [1, 2] } }` evaluates to `{ x: 3 }`.

### Function Call — `{ $fn, $args }`

Calls a function. `$fn` evaluates to a string (function name), a function body, or a variable that resolves to one. `$args` evaluates to an array (positional) or an object (named arguments).

```json
{ "$fn": "add", "$args": [3, 4] }
```

Nested calls — arguments can themselves be calls:

```json
{
  "$fn": "mul",
  "$args": [
    { "$fn": "add", "$args": [2, 3] },
    { "$fn": "sub", "$args": [10, 4] }
  ]
}
```

### Function Reference — `{ $fn }` (no `$args`)

Evaluates `$fn` and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions.

```json
{ "$fn": "double" }
```

### Variable Reference — `{ $var }`

Resolves a variable by name. Must be the only key in the object.

```json
{ "$var": "x" }
```

### Function Body — `{ $return, ... }`

Defines a function. Required key: `$return` (the expression to evaluate when called). Optional key: `$params` (array of strings). All other keys are **lazy local variables** — evaluated on first access.

```json
{
  "$params": ["n"],
  "remainder": { "$fn": "mod", "$args": [{ "$var": "n" }, 2] },
  "$return": { "$fn": "eq", "$args": [{ "$var": "remainder" }, 0] }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$fn": "gt", "$args": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. Must include a catch-all (use `[true, ...]` as the last branch) or the interpreter errors.

```json
{
  "$cond": [
    [{ "$fn": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$fn": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"],
    [true, "positive"]
  ]
}
```

### Property Access — `{ $get, $from }`

Both keys required. `$get` evaluates to a string key, numeric index, or array path. `$from` evaluates to the target object/array. Missing keys return `null`.

```json
{ "$get": "name", "$from": { "$var": "person" } }
```

Numeric index:

```json
{ "$get": 1, "$from": [10, 20, 30] }
```

Path (nested access):

```json
{ "$get": ["address", "city"], "$from": { "$var": "person" } }
```

Dynamic key (from variable or function result):

```json
{ "$get": { "$var": "fieldName" }, "$from": { "$var": "data" } }
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

## Function Bodies

A function body has `$return` and optionally `$params`. All other keys are lazy locals.

### Parameters — `$params`

Array of strings. Arguments are bound positionally.

```json
{
  "$params": ["a", "b"],
  "$return": { "$fn": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
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

Any key other than `$return` and `$params` defines a local variable. Locals are evaluated lazily (on first `$var` access) and can reference each other and `$params`.

```json
{
  "$params": ["x", "y"],
  "sum": { "$fn": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$fn": "mul", "$args": [{ "$var": "sum" }, 2] },
  "$return": { "$var": "doubled" }
}
```

### Named Arguments

`$args` can be an object instead of an array. Keys must match `$params` names. Not supported for functions with rest parameters. Missing keys default to `null`.

```json
{ "$fn": "greet", "$args": { "name": "world", "greeting": "Hello, " } }
```

## Closures

When a function body is returned as a value (not called), outer variables are captured by substitution. The interpreter walks the returned body and replaces `$var` references with their current values, respecting scope boundaries — inner `$params` and locals shadow outer names.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$fn": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$fn": "add", "$args": [10, { "$var": "y" }] }
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
    "$if": { "$fn": "lte", "$args": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$fn": "mul",
      "$args": [
        { "$var": "n" },
        { "$fn": "fact", "$args": [{ "$fn": "sub", "$args": [{ "$var": "n" }, 1] }] }
      ]
    }
  }
}
```

### Local Recursive Functions

Local variables that are statically-defined function bodies (i.e. the value has a `$return` key) are automatically available by name for string dispatch within their scope. This enables recursion without registering the function in the global registry.

```json
{
  "$params": ["n"],
  "fact": {
    "$params": ["x"],
    "$return": {
      "$if": { "$fn": "lte", "$args": [{ "$var": "x" }, 1] },
      "$then": 1,
      "$else": {
        "$fn": "mul",
        "$args": [
          { "$var": "x" },
          { "$fn": "fact", "$args": [{ "$fn": "sub", "$args": [{ "$var": "x" }, 1] }] }
        ]
      }
    }
  },
  "$return": { "$fn": "fact", "$args": [{ "$var": "n" }] }
}
```

Mutual recursion between local function bodies in the same scope also works:

```json
{
  "$params": ["n"],
  "isEven": {
    "$params": ["x"],
    "$return": {
      "$if": { "$fn": "eq", "$args": [{ "$var": "x" }, 0] },
      "$then": true,
      "$else": { "$fn": "isOdd", "$args": [{ "$fn": "sub", "$args": [{ "$var": "x" }, 1] }] }
    }
  },
  "isOdd": {
    "$params": ["x"],
    "$return": {
      "$if": { "$fn": "eq", "$args": [{ "$var": "x" }, 0] },
      "$then": false,
      "$else": { "$fn": "isEven", "$args": [{ "$fn": "sub", "$args": [{ "$var": "x" }, 1] }] }
    }
  },
  "$return": { "$fn": "isEven", "$args": [{ "$var": "n" }] }
}
```

Local function bodies can reference other variables from their enclosing scope (parameters and sibling locals). They can also shadow global registry functions of the same name within their scope. Local function names are scoped — they do not leak into parent or sibling scopes.

## Dynamic Dispatch

`$fn` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$fn": { "$var": "fnName" }, "$args": [3, 4] }
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

| Function   | Args                 | Description                       |
| ---------- | -------------------- | --------------------------------- |
| `length`   | `(arr)`              | length (works on strings too)     |
| `head`     | `(arr)`              | first element                     |
| `last`     | `(arr)`              | last element (null if empty)      |
| `tail`     | `(arr)`              | all but first                     |
| `concat`   | `(a, b)`             | concatenate two arrays            |
| `range`    | `(n)`                | `[0, 1, ..., n-1]`                |
| `slice`    | `(arr, start, end?)` | slice                             |
| `reverse`  | `(arr)`              | reversed copy                     |
| `includes` | `(arr, value)`       | contains check (works on strings) |
| `indexOf`  | `(arr, value)`       | index of value (-1 if missing)    |
| `flatten`  | `(arr)`              | flatten one level                 |

### Strings

| Function | Args         | Description               |
| -------- | ------------ | ------------------------- |
| `upper`  | `(s)`        | uppercase                 |
| `lower`  | `(s)`        | lowercase                 |
| `trim`   | `(s)`        | trim whitespace           |
| `strcat` | `(a, b)`     | concatenate two strings   |
| `split`  | `(s, sep)`   | split string              |
| `join`   | `(arr, sep)` | join array with separator |

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

| Function    | Args                    | Description                                                                      |
| ----------- | ----------------------- | -------------------------------------------------------------------------------- |
| `map`       | `(callback, arr)`       | map. Callback receives `(item, index)`.                                          |
| `filter`    | `(callback, arr)`       | filter. Callback receives `(item, index)`.                                       |
| `reduce`    | `(callback, init, arr)` | reduce. Callback receives `(acc, item, index)`.                                  |
| `find`      | `(callback, arr)`       | first match or `null`. Callback receives `(item, index)`.                        |
| `findIndex` | `(callback, arr)`       | index of first match or `-1`. Callback receives `(item, index)`.                 |
| `some`      | `(callback, arr)`       | any match. Callback receives `(item, index)`.                                    |
| `every`     | `(callback, arr)`       | all match. Callback receives `(item, index)`.                                    |
| `sort`      | `(comparator, arr)`     | sorted copy. Comparator receives `(a, b)`, returns number.                       |
| `sortBy`    | `(keyFn, arr)`          | sorted copy by key function. keyFn receives `(item, index)`.                     |
| `flatMap`   | `(callback, arr)`       | map then flatten one level. Callback receives `(item, index)`.                   |
| `groupBy`   | `(keyFn, arr)`          | group into object. keyFn receives `(item, index)`, must return string or number. |
| `mapValues` | `(callback, obj)`       | transform object values. Callback receives `(value, key)`.                       |
| `pipe`      | `(fns, init)`           | thread value through array of functions left-to-right.                           |

### Introspection

| Function | Args   | Description                                                                                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `arity`  | `(fn)` | returns parameter count. For rest params, excludes the rest param. `null` for unknown functions. Argument is a function name (string) or body. |

## HOF Argument Order

Higher-order functions take **callback first, data second**. This is consistent across all HOFs: `map(callback, arr)`, `filter(callback, arr)`, `reduce(callback, init, arr)`, etc.

## Patterns

### Calling a registered function

Register the function body in the function registry, call it by name:

```json
{ "$fn": "myFunction", "$args": [1, 2, 3] }
```

### Inline anonymous function

Use a function body directly as `$fn`:

```json
{
  "$fn": {
    "$params": ["x"],
    "$return": { "$fn": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] }
  },
  "$args": [5]
}
```

### Pipeline (filter → map → reduce)

Use local variables to chain steps:

```json
{
  "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "evens": { "$fn": "filter", "$args": [{ "$fn": "isEven" }, { "$var": "nums" }] },
  "doubled": { "$fn": "map", "$args": [{ "$fn": "double" }, { "$var": "evens" }] },
  "$return": { "$fn": "reduce", "$args": [{ "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{
  "$fn": "pipe",
  "$args": [[{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5]
}
```

### Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$fn": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
  }
}
```

### Object Transformation

Use `entries` → HOF → `fromEntries` to transform objects:

```json
{
  "pairs": { "$fn": "entries", "$args": [{ "$var": "obj" }] },
  "filtered": {
    "$fn": "filter",
    "$args": [
      {
        "$params": ["pair"],
        "$return": { "$fn": "gt", "$args": [{ "$get": 1, "$from": { "$var": "pair" } }, 3] }
      },
      { "$var": "pairs" }
    ]
  },
  "$return": { "$fn": "fromEntries", "$args": [{ "$var": "filtered" }] }
}
```

## Constraints

- `$var` must be the sole key in its object.
- `$get`/`$from` must be the only two keys.
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` must be the sole key; each entry must be a two-element array.
- `$literal` must be the sole key.
- `$fn`/`$args` allows exactly those two keys. `$fn` alone (reference) allows exactly one key.
- `$return` cannot coexist with `$fn` or `$args`.
- Named arguments (`$args` as object) are not supported for functions with rest parameters.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
