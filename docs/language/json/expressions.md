# Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

## Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

## Arrays

Each element is evaluated recursively. `[1, { "$call": "add", "$args": [2, 3] }]` evaluates to `[1, 5]`.

## Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$call": "add", "$args": [1, 2] } }` evaluates to `{ "x": 3 }`.

## Function Call — `{ $call, $args }`

Calls a function. `$call` is the callee (a name, body, or expression that resolves to one) and `$args` is the array of arguments. Both keys are required; `$args` may be empty.

```json
{ "$call": "add", "$args": [3, 4] }
```

Nested calls — arguments can themselves be calls:

```json
{
  "$call": "mul",
  "$args": [
    { "$call": "add", "$args": [2, 3] },
    { "$call": "sub", "$args": [10, 4] }
  ]
}
```

Zero-argument calls use an empty `$args` array:

```json
{ "$call": "myFunction", "$args": [] }
```

## Function Reference — `{ $fn }`

`$fn` evaluates its value and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions. `$fn` is never an array — an array `$fn` is a pre-split artifact and is rejected.

```json
{ "$fn": "double" }
```

## Variable Reference — `{ $var }`

Resolves a variable by name. `$var` must be the sole key, and its value is a plain variable name looked up directly in scope — there is no dot/bracket path notation and no `$get` sibling.

```json
{ "$var": "x" }
```

## Let Binding — `{ $let, $in }`

Introduces an expression-local recursive scope. The outer object has exactly
the two keys `$let` and `$in`; `$let` is a non-empty object mapping names to
binding expressions, and `$in` is the result expression evaluated in that
scope.

```json
{
  "$let": {
    "sum": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
    "doubled": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] }
  },
  "$in": { "$var": "doubled" }
}
```

Bindings are lazy, memoized after their first use, order-independent, and
mutually recursive. An unused binding is not evaluated. Forcing a direct or
indirect value cycle is an error. In variable lookup, a `$let` binding shadows
same-named function parameters, captures, enclosing bindings, and module
entries throughout every binding expression and `$in`.

The checker applies one source-level rule to every binding:

- the binding must be lexically reachable from `$in`, including through
  transitive `$var`, named `$call`, and `$fn` references;
- a reachable named function must declare a complete signature, and its body
  must satisfy that signature;
- a reachable value binding is checked wherever it is referenced.

An unreachable binding produces one unused-binding error and its contents are
not checked, avoiding cascades. These checking rules do not change runtime
laziness: unchecked canonical expressions still do not evaluate unused
bindings.

A binding whose literal value is a function body is also callable by its
binding name and shadows a same-named module or host/stdlib function in call
position. A non-function binding does not hide a callable registry entry. This
supports recursive and mutually recursive local functions while keeping their
JSON definitions acyclic:

```json
{
  "$let": {
    "even": {
      "$sig": {
        "required": [{ "type": "integer" }],
        "optional": [],
        "returns": { "type": "boolean" }
      },
      "$params": ["n"],
      "$return": {
        "$if": { "$call": "eq", "$args": [{ "$var": "n" }, 0] },
        "$then": true,
        "$else": { "$call": "odd", "$args": [{ "$call": "sub", "$args": [{ "$var": "n" }, 1] }] }
      }
    },
    "odd": {
      "$sig": {
        "required": [{ "type": "integer" }],
        "optional": [],
        "returns": { "type": "boolean" }
      },
      "$params": ["n"],
      "$return": {
        "$if": { "$call": "eq", "$args": [{ "$var": "n" }, 0] },
        "$then": false,
        "$else": { "$call": "even", "$args": [{ "$call": "sub", "$args": [{ "$var": "n" }, 1] }] }
      }
    }
  },
  "$in": { "$call": "even", "$args": [10] }
}
```

## Non-null assertion — `{ $nonnull }`

Evaluates `$nonnull` and returns its value when non-null. If the value is
`null`, evaluation fails. `$nonnull` must be the sole key.

```json
{ "$nonnull": { "$var": "x" } }
```

The checker removes `null` from the operand's inferred type. In shorthand this
is written as the postfix operator `x!`.

## Checked type ascription — `{ $as, $type }`

Evaluates `$as` exactly once, validates the result against the schema in
`$type`, and returns the validated value. A failed contract raises a
`RuntimeContractError`. Both keys are required and no sibling properties are
allowed.

```json
{
  "$as": { "$var": "value" },
  "$type": { "$ref": "#/$defs/Score" }
}
```

The checker gives the expression exactly the declared type without requiring
the operand's inferred type to be a subtype. In shorthand this is written
`value checked as Score`. This is a checked assertion, not a conversion: for
example, `"1" checked as integer` fails rather than producing `1`.

Refinements are intentionally opaque to arithmetic. For example, if
`Score = integer & min(0)`, arithmetic involving a `Score` produces `integer`;
the checker does not infer that the result still satisfies `min(0)`. Postfix
`!` only removes `null`; use `expression checked as Score` to validate a computed
result and establish the refinement explicitly.

Data values pass through a successful ascription unchanged. Ascribing a
function type installs a serializable contract wrapper that validates eventual
arguments and return values.

## Property Access — `{ $get, $from }`

All property access uses `$get`/`$from`. `$from` evaluates to the target and `$get` evaluates to the key read from it:

```json
{ "$get": "name", "$from": { "$var": "person" } }
{ "$get": 1, "$from": { "$var": "items" } }
{ "$get": ["address", "city"], "$from": { "$var": "person" } }
{ "$get": { "$var": "fieldName" }, "$from": { "$var": "data" } }
{ "$get": 0, "$from": { "$call": "concat", "$args": [[10], [20]] } }
```

`$get` evaluates to one of:

- a **string** key — reads an object property (`null` if the key is missing);
- an **integer** index — reads an array element, or a Unicode code point from
  a string (`null` if out of bounds);
- an **array** — a static path walked segment by segment, applying the per-segment rules above at each step.

The accepted key depends on the target at each step. Objects reject non-string
keys, while arrays and strings reject non-integer indices. Property access does
not coerce keys: use an explicit conversion such as
`{ "$get": { "$call": "str", "$args": [1] }, "$from": { "1": "one" } }`
(`object[str(number)]` in shorthand) when a numeric value is intended to name an
object property.

String indices count Unicode code points, not UTF-16 code units or
user-perceived grapheme clusters. For example, `"a😀b"[1]` is `"😀"` and
`length("a😀b")` is `3`. String `slice` offsets and string `indexOf` results use
the same unit; `split(string, "")` returns one element per code point.

`$from` may be any expression: a variable, a function result, a literal, or another `$get`/`$from` chain (nest them to walk deeper). A missing path segment returns `null`; traversal into a present `null` value errors, as does a `$get` whose target is not an object, array, or string. `$get`/`$from` must be the only two keys.

## Function Body — `{ $return, ... }`

Defines a function. `$return` is required. Author-written bodies may also
contain `$params` (an ordered array of parameter **slots** — see
[Parameters](functions.md#parameters--params)), `$sig`, and a string-valued `$comment`.
No other source fields are allowed; expression-local bindings belong in a
`$let` under `$return`.

```json
{
  "$params": ["n"],
  "$return": {
    "$let": {
      "remainder": { "$call": "mod", "$args": [{ "$var": "n" }, 2] }
    },
    "$in": { "$call": "eq", "$args": [{ "$var": "remainder" }, 0] }
  }
}
```

When a function body appears in expression position (not as the top-level target of a call), it is treated as a closure — outer variables are substituted into it.

## Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

## Multi-branch Conditional — `{ $cond }`

Array of `[condition, result]` pairs. First truthy condition wins. If no condition matches, optional `$else` is evaluated and returned; without `$else`, the interpreter errors. Only the matched result or `$else` is evaluated.

```json
{
  "$cond": [
    [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

`[true, ...]` still works as an explicit catch-all branch when you prefer to keep all branches inside the `$cond` array.

## Scalar Value Match — `{ $match, $cases, $else }`

Evaluates `$match`, then checks `$cases` left-to-right. Each case is a `[value, result]` pair; the first case value that is strictly equal to the matched value wins. `$match` and case values must evaluate to scalar JSON values (`null`, boolean, number, or string); arrays and objects are rejected instead of compared structurally. `$else` is required and is evaluated only if no case matches.

```json
{
  "$match": { "$var": "cmd" },
  "$cases": [
    ["show", { "$call": "showResult", "$args": [{ "$var": "state" }] }],
    ["reset", { "$call": "resetResult", "$args": [] }],
    ["help", { "$call": "helpResult", "$args": [] }]
  ],
  "$else": { "$call": "moveResult", "$args": [{ "$var": "state" }, { "$var": "argv" }] }
}
```

## Short-Circuit And — `{ $and }`

Array of expressions evaluated left-to-right. Returns the first falsy value, or the last value if all are truthy. Short-circuits (stops evaluating after the first falsy result).

```json
{
  "$and": [
    { "$call": "gt", "$args": [{ "$var": "x" }, 0] },
    { "$call": "lt", "$args": [{ "$var": "x" }, 100] },
    "in range"
  ]
}
```

Unlike the stdlib `and` function, `$and` does **not** evaluate all its operands — it is a language-level special form. It is also variadic (any number of operands).

## Short-Circuit Or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
```

Comparison and negation have **no dedicated expression forms**. Comparisons (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`) and logical negation (`not`) are ordinary [standard-library functions](standard-library.md#comparison) called via `$call`/`$args`:

```json
{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }
{ "$call": "gte", "$args": [{ "$var": "score" }, 10] }
{ "$call": "not", "$args": [{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }] }
```

`eq` and `neq` are **structural** (deep) equality — the only equality json-fn has (see [Standard Library → Comparison](standard-library.md#comparison)).

## Raw — `{ $raw }`

Returns the value as-is without evaluating nested expressions: the payload is
a JSON value, not json-fn syntax. Use `$raw` to preserve data that would
otherwise be interpreted as expression syntax (keys such as `$fn`, `$var`, or
`$call`) or to keep a literal `$comment` entry. Shorthand has no keyword for
it: the parser infers the boundary around static JSON containing quoted
`$`-prefixed keys (see the [shorthand spec](../shorthand-spec.md)). Quotation is
not a fuel escape hatch: a `$raw` payload charges the same deterministic fuel
as evaluating the equivalent plain constant literal (see
[Execution limits](../../runtime/execution-limits.md)).

```json
{
  "$raw": [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8]
  ]
}
```

## Comments — `$comment`

A supported `$comment` key with a string value is ignored when it appears as a
sibling key and is stripped from plain-data objects. It survives JSON
serialization, so unlike JSONC comments it round-trips through
`parse → transform → stringify`.

```json
{
  "$comment": "classify a number by sign",
  "$params": ["n"],
  "$return": {
    "$cond": [
      [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
      [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"],
      [true, "positive"]
    ]
  }
}
```

Rules:

- The value **must be a string** to be recognized as a comment. Non-string values are treated as normal keys (and will typically cause "expression cannot have other properties" errors in expression forms).
- Allowed as a sibling key in expression forms that use the common comment
  rule (`$call`/`$args`, `$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`,
  `$or`, `$raw`, `$get`/`$from`, and function bodies). A `$let` expression is
  the exception: its outer object has exactly `$let` and `$in`.
- In plain data objects, `$comment` is stripped from the output. To preserve a literal `$comment` key in data, wrap with `$raw`.
- Inside `$raw`, the entire value is returned verbatim — `$comment` is preserved.
- Closures preserve `$comment` when a function body is returned as a value.

