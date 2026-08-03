# json-fn Language Reference

json-fn is a JSON-structured expression language. Programs are JSON values evaluated by a tree-walking interpreter. All expressions are valid JSON.

## Expression Types

Every JSON value is an expression. The interpreter determines its type by shape:

### Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

### Arrays

Each element is evaluated recursively. `[1, { "$call": "add", "$args": [2, 3] }]` evaluates to `[1, 5]`.

### Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$call": "add", "$args": [1, 2] } }` evaluates to `{ "x": 3 }`.

### Function Call — `{ $call, $args }`

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

### Function Reference — `{ $fn }`

`$fn` evaluates its value and returns the result (a string name or function body) without calling it. Used to pass functions as values to higher-order functions. `$fn` is never an array — an array `$fn` is a pre-split artifact and is rejected.

```json
{ "$fn": "double" }
```

### Variable Reference — `{ $var }`

Resolves a variable by name. `$var` must be the sole key, and its value is a plain variable name looked up directly in scope — there is no dot/bracket path notation and no `$get` sibling.

```json
{ "$var": "x" }
```

### Let Binding — `{ $let, $in }`

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

### Non-null assertion — `{ $nonnull }`

Evaluates `$nonnull` and returns its value when non-null. If the value is
`null`, evaluation fails. `$nonnull` must be the sole key.

```json
{ "$nonnull": { "$var": "x" } }
```

The checker removes `null` from the operand's inferred type. In shorthand this
is written as the postfix operator `x!`.

### Checked type ascription — `{ $as, $type }`

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

### Property Access — `{ $get, $from }`

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

### Function Body — `{ $return, ... }`

Defines a function. `$return` is required. Author-written bodies may also
contain `$params` (an ordered array of parameter **slots** — see
[Parameters](#parameters--params)), `$sig`, and a string-valued `$comment`.
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

### Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

### Multi-branch Conditional — `{ $cond }`

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

### Scalar Value Match — `{ $match, $cases, $else }`

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

### Short-Circuit And — `{ $and }`

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

### Short-Circuit Or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
```

Comparison and negation have **no dedicated expression forms**. Comparisons (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`) and logical negation (`not`) are ordinary [standard-library functions](#comparison) called via `$call`/`$args`:

```json
{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }
{ "$call": "gte", "$args": [{ "$var": "score" }, 10] }
{ "$call": "not", "$args": [{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }] }
```

`eq` and `neq` are **structural** (deep) equality — the only equality json-fn has (see [Standard Library → Comparison](#comparison)).

### Raw — `{ $raw }`

Returns the value as-is without evaluating nested expressions: the payload is
a JSON value, not json-fn syntax. Use `$raw` to preserve data that would
otherwise be interpreted as expression syntax (keys such as `$fn`, `$var`, or
`$call`) or to keep a literal `$comment` entry. Shorthand has no keyword for
it: the parser infers the boundary around static JSON containing quoted
`$`-prefixed keys (see the [shorthand spec](shorthand-spec.md)). Quotation is
not a fuel escape hatch: a `$raw` payload charges the same deterministic fuel
as evaluating the equivalent plain constant literal (see
[Execution limits](execution-limits.md)).

```json
{
  "$raw": [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8]
  ]
}
```

### Comments — `$comment`

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

## Function Bodies

A source function body is a closed structural record:

- `$return` — required result expression;
- `$params` — optional parameter layout;
- `$sig` — optional static signature;
- `$comment` — optional string comment.

Evaluator-produced function values may additionally contain `$captures` and
`$runtimeContract`:

- `$captures` is a non-null object mapping names to function bodies. Captured
  functions are available by `$var`, `$fn`, and `$call` in parameter defaults
  and `$return`.
- `$runtimeContract` is evaluator-owned serializable callable-boundary state.

These are runtime closure/boundary state, not authoring-level local bindings.
The shorthand printer rejects them rather than silently dropping them.
`$types` is module-only and is never valid on a function body. Any other
ordinary or reserved field is invalid.

### Parameters — `$params`

An ordered array of parameter **slots**. Each slot is one of:

- a name string — a required positional parameter;
- `{ "$param": name, "$optional": true }` — an optional positional parameter;
- `{ "$param": name, "$default": expression }` — a defaulted positional parameter;
- `"...rest"` — a rest collector (see [Rest Parameters](#rest-parameters));
- `{ "$fields": [...] }` — an object pattern (see
  [Object-Pattern Parameters](#object-pattern-parameters--fields)).

Descriptor objects have exactly the keys shown. Fixed arguments are bound
positionally, one per slot.

```json
{
  "$params": ["a", { "$param": "b", "$default": 1 }],
  "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
}
```

A name string is required: omitting its argument is an error. An optional
parameter may be omitted and then binds `null`. A defaulted parameter may be
omitted, in which case its `$default` expression is evaluated lazily when the
binding is first read. Calls cannot skip a positional slot: passing `null`
explicitly supplies `null` and suppresses either omission behavior.

Required positional slots—including object patterns—must precede all optional
and defaulted positional slots. Optional and defaulted slots may be mixed in
the omittable suffix, followed only by a final rest parameter. For example,
`["required", { "$param": "fallback", "$default": 0 }, "...rest"]` is valid,
while `[{ "$param": "fallback", "$default": 0 }, "required"]` is not.

Every name bound by a parameter list must be unique across positional
parameters, object-pattern fields, and the rest parameter. Repeating a name in
the same `$params` array is invalid, including repetitions across two different
object patterns.

A function without a rest parameter rejects any argument beyond its exact
number of fixed slots; extra fixed arguments are not ignored. A rest parameter
allows additional arguments as described below.

### Rest Parameters

A final parameter starting with `...` collects all arguments remaining after
the fixed slots into an array. It receives an empty array when there are no
remaining arguments.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

Called with args `[1, 2, 3]`: `first` = `1`, `rest` = `[2, 3]`.

### Object-Pattern Parameters — `$fields`

A `$params` slot may be an **object pattern** instead of a name string: an object
of the exact shape `{ "$fields": [...] }`. Its non-empty array contains required
field-name strings, optional descriptors of the form
`{ "$field": name, "$optional": true }`, and/or defaulted descriptors of the
form `{ "$field": name, "$default": expression }`. Field descriptors have
exactly the keys shown. The pattern destructures one positional object argument,
binding each field to a local of the same name.

```json
{
  "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$call": "sub", "$args": [{ "$var": "to" }, { "$var": "from" }] }
}
```

Called with args `[{ "from": 3, "to": 7 }]`: `from` = `3`, `to` = `7`, result `4`. The **calling convention is unchanged** — this is an ordinary positional call passing one plain-data object; the "named-ness" lives entirely in the parameter.

Binding rules for a pattern slot at position `i`, where `v` is the supplied
`i`-th argument:

- The whole pattern argument is required, even if every field is optional or
  defaulted.
- `v` must be a plain object (not an array and not `null`). Any other value,
  including explicit `null`, is an error.
- A required field-name string must be an own property of `v`; an absent or
  inherited field is an error.
- An absent optional field binds `null`.
- A defaulted field uses its `$default` only when the own property is absent.
  The default is evaluated lazily when the binding is first read.
- An own property whose value is `null` is supplied data: it binds `null` and
  suppresses a field default.
- Extra object keys are ignored.

Supplied field bindings are established at call time; defaulted bindings remain
lazy. Within the body they are visible via `$var` to `$return`, including any
nested `$let`, and they **shadow** same-named outer bindings until an inner
`$let` binds the same name.

Additional rules:

- `$fields` must be a **non-empty** array of field-name strings and/or
  `{ "$field": name, "$optional": true }` or
  `{ "$field": name, "$default": expression }` descriptors. Field names must
  not contain `.` or `[`.
- A `$fields` object is valid only as a `$params` slot; it may not be preceded by `...`.
- A pattern slot consumes exactly **one required** positional argument, so it
  may appear with other required slots before optional/defaulted slots, and
  before a final rest parameter (`["label", { "$fields": ["x", "y"] }]`,
  `[{ "$fields": ["x"] }, "...rest"]`).
- Optional/defaulted fields affect property omission only. Even a pattern whose
  fields are all omittable remains a required positional slot and cannot follow
  an optional or defaulted positional parameter.
- `arity` counts every non-rest slot once, including optional/defaulted slots
  and object patterns.

Rename and nested patterns are not supported.

### Expression-local bindings

Use [`$let`/`$in`](#let-binding--let-in) wherever an expression needs local
bindings. Inside a function's `$return`, its bindings can reference the
function parameters and runtime captures. A nested `$let` shadows parameters,
captures, and enclosing bindings with the same name.

```json
{
  "$params": ["x", "y"],
  "$return": {
    "$let": {
      "sum": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
      "doubled": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] }
    },
    "$in": { "$var": "doubled" }
  }
}
```

## Closures

When a function body is returned as a value (not called), outer variables are
captured by substitution. The interpreter walks the returned body and replaces
`$var` references with their current values, respecting scope boundaries.
Inner `$params`, `$captures`, and `$let` names shadow outer names. A `$let`
masks its names recursively in both its binding expressions and its `$in`,
while unrelated outer references inside either part are still substituted.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$call": "add", "$args": [10, { "$var": "y" }] }
}
```

The returned body is a valid function body that can be called subsequently.

### Escaping closures carry the local functions they call

Capture also keeps an escaping closure **self-contained** when it calls an
enclosing [local function](#local-recursive-functions) by name. Names in call
position that resolve to a local function stay literal (so recursion and mutual
recursion keep dispatching by name), and capture serializes the required
closed-over definitions under the returned body's `$captures` field. A closure
that recurses—or calls a sibling local function—therefore remains callable
after it leaves the `$let` scope that defined those functions.

```json
{
  "$params": ["base"],
  "$return": {
    "$let": {
      "go": {
        "$params": ["x"],
        "$return": {
          "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
          "$then": { "$var": "base" },
          "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
        }
      }
    },
    "$in": { "$var": "go" }
  }
}
```

Called with `[42]`, this returns a body whose `$captures` carries `go` so it
still recurses when invoked later:

```json
{
  "$params": ["x"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
    "$then": 42,
    "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
  },
  "$captures": {
    "go": {
      "$params": ["x"],
      "$return": {
        "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
        "$then": 42,
        "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
      }
    }
  }
}
```

Only the local functions actually referenced (transitively) are captured. A
name shadowed by the returned body's own `$params`, `$captures`, or nested
`$let` is not captured from outside—the inner binder wins.

**Module-level (registry) functions are not captured.** `$captures` applies only
to functions defined by an enclosing expression scope that disappears when the
closure escapes it. A top-level module function persists in the program
registry and resolves by name at call time like a stdlib builtin. A closure
serialized outside the program therefore carries required `$let` functions,
but still relies on the target host providing the module and stdlib registry.

## Scoping Rules

- Function parameters and runtime `$captures` create the function invocation
  scope.
- `$let` creates an expression-local recursive scope. Its names shadow function
  parameters, captures, outer lets, and module bindings in variable lookup.
  Literal function-body bindings additionally shadow callable registry entries.
- Variables resolve from the innermost binder outward. Parameter defaults are
  in the function invocation scope and can see captures, all parameter
  bindings/defaults, and outer/module scope, but not a `$let` nested later
  inside `$return`.

## Recursion

Functions can call themselves by name if registered in the function registry.

```json
{
  "$params": ["n"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$call": "mul",
      "$args": [
        { "$var": "n" },
        { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "n" }, 1] }] }
      ]
    }
  }
}
```

### Local Recursive Functions

`$let` bindings whose literal values are function bodies can be called by name
within their scope. This enables recursion without registering them in the
persistent module/host registry. Mutual recursion between sibling bindings
works too.

```json
{
  "$let": {
    "fact": {
      "$sig": {
        "required": [{ "type": "integer" }],
        "optional": [],
        "returns": { "type": "integer" }
      },
      "$params": ["x"],
      "$return": {
        "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 1] },
        "$then": 1,
        "$else": {
          "$call": "mul",
          "$args": [
            { "$var": "x" },
            { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
          ]
        }
      }
    }
  },
  "$in": { "$call": "fact", "$args": [5] }
}
```

Local function names can shadow persistent registry functions and do not leak
outside their `$let`.

## Module Scope

A whole program module is a distinct **object mapping names to expressions**.
When a host links such an object and chooses an entry point, module entries form
a persistent recursive registry:

- Top-level **constants** (`SIZE`, `OFFSETS`, …) are visible via `$var` throughout the module.
- Top-level **functions** are callable via `$call` and, being bindings, are also `$var`-visible as function values (so they can be passed by name to higher-order functions).
- Constants are lazy, memoized, order-independent, mutually recursive, and
  cycle-checked.
- Literal function entries are persistent named definitions. They are callable
  by name and visible as function values, but are not copied into escaping
  closures' `$captures`.

```json
{
  "W": 20,
  "H": 12,
  "SIZE": { "$call": "mul", "$args": [{ "$var": "W" }, { "$var": "H" }] },
  "area": {
    "$sig": { "required": [], "optional": [], "returns": { "type": "integer" } },
    "$params": [],
    "$return": { "$var": "SIZE" }
  }
}
```

Running this program with entry `area` returns `240`: the top-level constant `SIZE` (itself defined in terms of `W` and `H`) is read as a plain `$var`, no nullary-function workaround required.

### The boundary rule

The module scope composes with the host-supplied registry (stdlib + native builtins) by **one rule**:

> The module object is the **outermost lexical frame**; the host/stdlib registry is its **parent frame**. Callee (`$call`) and `$var` resolution are unchanged except that they now walk one additional frame.

The module registry is not a function body and is not a `$let` encoding.
Function bodies have a closed structural schema; module roots instead own named
entries and may additionally own `$types`. Consequences:

- **Shadowing.** A module binding shadows a same-named registry entry (stdlib is the parent frame).
- **Inner binders still win.** A function's `$params`, runtime `$captures`, or
  an expression `$let` shadows a module constant of the same name.
- **Lisp-2 asymmetry (by syntax, not runtime type).** Only a binding whose value is _literally_ a function body (has a `$return` key) becomes callable in `$call` position. So a module _constant_ named `map` shadows `$var map` but **not** a `$call` to `map` (which still resolves the stdlib `map`), even if that constant happens to evaluate to a function; a module _function_ named `map` shadows **both**.

This is a single outermost frame, not a module _system_: there is no `import` / `export`, no multiple modules, and no re-exports.

## Dynamic Dispatch

The callee `$call` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$call": { "$var": "fnName" }, "$args": [3, 4] }
}
```

Called with `["add"]` returns `7`. Called with `["mul"]` returns `12`.

## Tasks & Effects

json-fn is pure: evaluating an expression never performs I/O or any observable side effect. **Effects** are represented as _data_ — inert values called **tasks** that _describe_ an effectful computation without running it. Running a task is a separate step, performed either in-language by the `handle` builtin (which interprets each effect) or at the host boundary by a trampoline (`runTask`) that answers effects with real I/O.

The kernel is deliberately small: three task **constructors** (`perform`, `pure`, `bind`), one `raise` convenience, and one `handle` builtin. Everything richer — retries, error recovery, threaded state, dry-runs, capability attenuation — is ordinary json-fn library code, because [escaping-closure capture](#escaping-closures-carry-the-local-functions-they-call) makes every suspended continuation a self-contained JSON value.

### Task representation

A task is a tagged plain object. The tag key is `@task` — deliberately **not** a `$`-key, so a task classifies as an ordinary object and is never re-interpreted as an expression form. Tasks are **inert**: once built they are returned, stored, and passed around verbatim, never re-evaluated. There are three node kinds:

```json
{ "@task": "effect", "name": "http.get", "args": ["https://example.com"] }
{ "@task": "pure", "value": 42 }
{ "@task": "bind", "task": { "@task": "pure", "value": 1 }, "then": { "$params": ["x"], "$return": { "$call": "pure", "$args": [{ "$var": "x" }] } } }
```

- **`effect`** requests one effect by `name`, carrying its `args`. `raise(err)` is the distinguished effect named `raise`.
- **`pure`** is a completed task whose result is `value`.
- **`bind`** sequences: run `task`, then apply the continuation `then` to obtain the next task. A one-parameter continuation receives the completed value; a zero-parameter continuation discards it (the shape emitted by a non-final bare expression in `do` notation).

Because tasks are inert data, laziness composes with them cleanly: a task held
in an [unreferenced `$let` binding](#let-binding--let-in) is never built, and
building a task never performs its effect. Nothing happens until something
_runs_ the task.

### Constructors

These are standard-library functions (see [Standard Library → Tasks & Effects](#tasks--effects-1)):

- `perform(name, args)` — build an `effect` task. `name` must be a string, `args` an array.
- `pure(value)` — build a completed task carrying `value`.
- `bind(task, k)` — sequence; `k` must be a function (registry name or body).
- `raise(err)` — convenience for `perform("raise", [err])`.

When the checker is configured with an effect manifest, each literal effect
name has positional argument schemas and a result schema. `perform` checks those
arguments, and the result type flows through `bind` (and therefore `do`
notation). Guest signatures may preserve that index explicitly with `Task<A>`;
bare `Task` means `Task<any>`. `Task` is the one built-in type constructor and
cannot be redefined; general user-facing generics remain unsupported. The index
is checker-only, and task records contain no runtime type metadata. A dynamic
effect name cannot be resolved statically and is reported as degraded type
coverage.

A contract-linked module also receives a reserved `effects` binding
derived from that manifest. Dot-separated effect names become nested callable
paths:

```jfn
effects.http.get(url)
effects.log("starting")
```

Each leaf is a typed task constructor equivalent to a literal
`perform("http.get", [url])`; calling it remains pure and does not invoke the
host capability. Qualification distinguishes effects from direct functions, so
`tap(...)` and `effects.log(...)` may coexist with different semantics. A module
checked or run with a contract may not declare its own top-level `effects`
binding. Manifest names may not be namespace prefixes of other names (for
example, `sensor` and `sensor.read` cannot both be declared). Direct `perform`
remains available as a low-level constructor.

Malformed tasks (e.g. a `bind` whose `then` is not a function, or an `effect` with a non-string `name`) are rejected as ordinary **guest-visible evaluation errors** when the task is run — never as host-language exceptions.

### The suspended form

Running a task normalizes it — walking the `bind` spine — to exactly one of two shapes. This pair is the stable contract shared by `handle`, the host trampoline, and durable storage:

```json
{ "done": 42 }
{ "pending": { "name": "http.get", "args": ["https://example.com"], "resume": { "$params": ["__v"], "$return": "..." } } }
```

`resume` is an ordinary self-contained closure `(value) => <task>`: apply it to the effect's result to continue. Because escaping-closure capture keeps it self-contained, a `pending` record is plain JSON — persist it, ship it across a process boundary, print it as shorthand, or apply it **more than once** (multi-shot).

### `handle` — interpreting effects in-language

`handle(task, clauses)` runs a task, dispatching each effect it performs to a matching clause in the `clauses` record. This is a pure, in-language interpreter for effects — no host involved — which is what makes effectful code testable. This two-argument form is **partial**: unmatched effects bubble.

`handle(task, clauses, { "$raw": resultSchema })` is the **total annotated** form, written in shorthand as `handle task returns ResultType with { … }`. Its immediate result is checked against `resultSchema` at runtime, and the checker gives the expression that declared type. An unmatched effect is a `RuntimeContractError` instead of a residual task. The annotation is retained by every generated `resume`, and named types resolve through the active module's `$types`.

Clause lookup is by effect name:

- A **named clause** `"http.get": (url, resume) => …` receives the effect's args spread positionally, then `resume` last.
- The reserved **`"*"` wildcard** clause `"*": (eff, resume) => …` catches any otherwise-unmatched effect and receives `eff = { name, args }` plus `resume`.
- The reserved **`"return"` clause** `"return": (v) => …` runs when the task completes normally with value `v`; its result is final and is **not** re-interpreted by this handler. Without a `"return"` clause, `handle` returns the completion value directly.

For an annotated total handler of `Task<A>` with result annotation `R`, the
checker contextually types each manifest-backed clause as
`(...effectArgs, resume: (effectResult) -> R) -> R` and types `return` as
`(A) -> R`. Wildcard and built-in `raise` payloads remain broad because
`Task<A>` does not track an effect row or raised-payload type. The unannotated
partial form has no declared `R`, so it retains its imprecise static result.

`resume` is itself plain JSON built by `handle`, so continuations stay serializable mid-handle and multi-shot resumption is free: calling `resume` twice re-runs the rest of the task twice (the basis for nondeterminism, retry, and backtracking combinators).

**Bubbling.** In the partial form, an effect with no matching clause (and no `"*"`) is _not_ an error: `handle` re-performs it, wrapping the surrounding continuation so it re-enters the same handler afterward. The effect bubbles outward to the next enclosing `handle`, and ultimately to the host. This is what lets a partial handler discharge only the effects it cares about while staying transparent to the rest of the effect set. The annotated form is total and rejects the same unmatched effect.

For a function result annotation such as `(State) -> Report`, validation installs a serializable callable boundary. The function value is checked when produced; each eventual argument and return value is checked when it is called. This is what lets a state handler declare its actual immediate result:

```jfn
(handle task returns (ScriptState) -> Report with {
  // clauses return functions awaiting ScriptState
})(initialState)
```

```jfn
handle greet(mockIo()) with {
  "io.readLine": (resume) => resume("world"),
  "io.print":    (msg, resume) => resume(null)
}
```

Handler clauses are invoked through the normal call path, so fuel and call-depth metering apply; task normalization additionally charges fuel per interpreted node.

### Host trampoline

`handle` interprets effects _in-language_; to connect a task to the real world,
a host drives it with `runTask` (in TypeScript, exported from the package).
The host prepares a deployment from portable contract/profile data and
executable runtime-adapter bindings:

The two portable artifacts are specified separately:

- the [environment contract](environment-contract.md) owns boundary schemas,
  direct functions, effects, and the production entry;
- the [deployment profile](deployment-profile.md) selects a live or durable
  hosting mode, an effect subset, and portable execution limits.

```ts
const contract = {
  version: 1,
  $defs: {
    /* shared domain schemas */
  },
  functions: {
    /* direct host callable contracts */
  },
  effects: {
    /* capability argument/result contracts */
  },
  entry: {
    name: "main",
    required: [],
    optional: [],
    returns: { task: { type: "string" } },
  },
};

const profile = {
  version: 1,
  mode: "live",
  effects: ["io.readLine", "io.print"],
};

const deployment = prepareDeployment({
  module,
  contract,
  profile,
  adapter: {
    functions: {},
    effects: {
      "io.readLine": async () => prompt(),
      "io.print": async (msg) => {
        console.log(msg);
        return null;
      },
    },
  },
});
const result = await runTask(deployment, [], {
  signal,
  timeoutMs: 30_000,
});
```

The host is the _outermost handler_: any effect that no in-language `handle` discharged bubbles all the way out to `runTask`, which

- returns the value on `{ done }`;
- throws `TaskRaiseError` (carrying the guest payload) for an unhandled `raise`;
- throws `UnhandledEffectError` for an effect with no capability;
- otherwise `await`s the capability, applies `resume` to its result, and loops.

The contract and profile are portable JSON data, separate from host
implementations. `prepareDeployment({module, contract, profile, adapter})`
validates and links them once. The `RuntimeAdapter` must bind exactly all contract
functions and exactly the effects executed inline by that profile; profile
effect selection is allowed to be a subset of the contract. See
[Environment contract](environment-contract.md) and
[Deployment profile](deployment-profile.md) for the complete JSON shapes,
collision rules, validation APIs, and runtime-adapter requirements.

Entry calls accept every argument count from the required length through the
combined required-plus-optional length; supplied optional arguments are still
validated against their schemas. Entry returns have two forms:

- `entry.returns: A` describes an immediate result. The host invokes the entry
  once and validates that value directly; it does not interpret task-shaped
  data returned under a direct contract.
- `entry.returns: { task: A }` describes a task whose eventual completion value
  matches `A`. The host drives this form through the task trampoline and
  dispatches capabilities for effects that reach the host.

Despite its compatibility-preserving name,
`runTask(preparedLiveDeployment, args, hostLocalRunOptions?)` executes either
declared entry mode. It validates entry arguments and results, wraps tractable
direct host functions to validate their arguments/results, rejects effects
absent from the contract, validates outgoing effect arguments before invoking
host code, and validates capability results before resuming task entries. Named
references use the same merged builtin/contract/module definition pool as the
checker. Portable `maxCallDepth`, `maxFuel`, and `maxValueSize` limits belong in
the profile; the optional third argument is only for host-local cancellation,
timeout, and instrumentation.

For task entries that must persist across process boundaries, the TypeScript
implementation provides
`createDurableDriver({deployment: preparedDurableDeployment, store})`. See
[Deployment profile](deployment-profile.md) for durable selection and
runtime-adapter binding, then [Durable task hosting](durable-host.md) for store consistency,
delivery, recovery, and at-least-once execution semantics.

`jfn check --contract <path>` loads the same artifact, preloads its named
types, functions, and effects, and checks the entry body contextually against
the contract-owned signature. `jfn eval --contract <path>` prepares a live
deployment with an empty effect selection and empty runtime adapter, then executes the
contract entry. It is therefore suitable only when the contract has no direct
host functions and every task effect is handled in-language (or no effect is
performed). By default `eval` reads shorthand; pass `--json-input` to evaluate
canonical json-fn JSON directly.

Adding `--function <name>` selects a development evaluation instead: the CLI
uses the shared module linker, then invokes that named module function. An
environment contract may be supplied but is not required for self-contained
modules. This mode skips entry argument validation, entry return validation,
and automatic task execution. Success in this mode does not show that the
production entry can run. Test production hosting with `prepareDeployment` and
the real profile and runtime adapter; the CLI does not synthesize their
implementations.

**Durable suspend/resume.** A stepped `pending` record is host state, not itself
a task accepted by `serializeTask`. Hosts may serialize its `resume` closure (or
a task that embeds that continuation), but production durable hosting should use
the workflow-record codec and durable driver described above.

**Static admission.** `analyzeDeploymentCapabilities({ module, contract,
profile })` reports possible names, dynamic access, profile bindings, and
uncovered effects. A host can reject uncovered capabilities before running. It
is a conservative over-approximation and does not subtract effects discharged
by an in-language `handle`.

**Idempotency caveat.** `runTask` answers each `pending` exactly once, but durable suspend/resume makes **at-least-once** effect execution the practical reality: a crash between running a capability and persisting the resumed task reruns that effect on recovery (the same tradeoff as Temporal). In-language multi-shot `resume` is a feature; at the host boundary, replay is not free — capabilities with external side effects should take idempotency keys.

## Standard Library

All standard-library functions, signatures, and descriptions are listed in the
generated [Builtins reference](builtins.md).

### Arithmetic

Arithmetic builtins reject results that are `NaN` or infinite, since those are
not JSON numbers.

Portable numeric semantics use finite IEEE 754 binary64 values. Implementations
round each primitive arithmetic operation to binary64 and preserve the
operation order specified by a builtin. Aggregate folds are evaluated from left
to right.

`mean` first sums its input from left to right and divides the finite sum by the
array length. If that sum overflows, it recomputes from left to right by adding
each value divided by the length. The fallback permits a finite mean when the
unscaled sum is not finite; using it only after overflow avoids needless
underflow for subnormal inputs.

Transcendental builtins such as `sin`, `cos`, and `log` use the host math
library. Their least-significant bits are not guaranteed to agree across
implementations.

### Comparison

`eq`/`neq` are **structural**: arrays and objects are compared recursively and object key order does not matter (on scalars this is just `===`). This is the only equality — json-fn values are immutable JSON, so there is no observable reference identity to compare. Equality does **not** coerce types, so `true` is not `1` and `"1"` is not `1`. The same structural equality backs `includes`/`indexOf` element membership. (`$match` compares its subject against case values by equality too, but restricts both to scalars — see [Scalar Value Match](#scalar-value-match--match-cases-else).)

### Arrays

`range(end)` and `flatten(array)` remain unary so they can be passed directly
to ordinary one-argument higher-order functions. Use `rangeFrom(start, end)`,
`rangeBy(start, end, step)`, and `flattenDepth(array, depth)` for their
fixed-arity extended forms.

### Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall), `u` (Unicode). Example: `"(?i)hello"`.

Match results are objects with `match` (full matched text), `index` (start position), `groups` (positional captures, `null` for unmatched optional groups), and `named` (named capture groups, empty object if none).

### Higher-Order Functions

Higher-order functions can invoke json-fn callbacks. The callback argument can be a function reference (`{ "$fn": "name" }`), an inline function body, or a string name.

At runtime, a callback may be an inline function, a function reference, or a
plain string name. The static checker contextually types bare inline functions
and checks typed function references; it does not resolve string names.
Bare contextual callbacks must declare the exact required, optional, and rest
shape supplied by the builtin; those three parts are compared independently.
Referenced and `$sig`-annotated callbacks must also have a compatible complete
shape. When a referenced function intentionally has a different public shape,
use an explicit wrapper that declares the builtin's full callback shape and
forwards the arguments the function accepts.

The ordinary array HOFs supply only the item (`reduce` supplies accumulator and
item). Their `*Indexed` counterparts additionally supply the integer index.
This is a breaking API change: remove an unused index parameter from callbacks
passed to an ordinary HOF, or rename the call to its `*Indexed` counterpart when
the callback uses the index. For an indexed wrapper that ignores the supplied
index, declare it explicitly with an ignored name such as `_index`.

`groupBy`, `groupByIndexed`, and `countBy` convert numeric keys to strings before
using them as object keys. `frequencies` performs the same conversion for every
scalar value, so numeric `1` and string `"1"` share a bucket. Counting safely
supports object-special keys such as `__proto__` and `constructor`.
`flatMap` and `flatMapIndexed` splice array callback results into the output and
keep non-array results as single elements; nested arrays are therefore
flattened by exactly one level.
`reReplaceWith` callbacks must return `string`; the runtime rejects other
return values. `mapValues` is typed as a string-keyed map and does not preserve
exact input keys. `filter` and `find` do not infer type predicates from callback
logic.

### Tasks & Effects

These build and run **tasks** — the effect representation described under [Tasks & Effects](#tasks--effects). Constructors build inert, tagged records; `handle` interprets them in-language.

`isTask(a)` reports whether a value is a task.

### Debugging

`tap` is a debugging helper that passes a value and optional label to
the host-configured logger, then returns the value unchanged:

```json
{
  "$call": "map",
  "$args": [
    { "$params": ["x"], "$return": { "$call": "tap", "$args": [{ "$var": "x" }, "item"] } },
    [1, 2, 3]
  ]
}
```

By default, `tap` is inert and produces no output. Host integrations may pass a logger when constructing the standard library to capture or emit logs. The output destination and format are host-defined.

> **Note: lazy bindings.** A `tap` call placed in an unreferenced
> [`$let`](#let-binding--let-in) binding is never evaluated. To log inside a
> function body, either put the `tap` call in the path of `$return`, or
> reference the debug binding from `$in` so it is forced.

## HOF Argument Order

Higher-order functions take **callback first, data second**. This is consistent across all HOFs: `map(callback, arr)`, `filter(callback, arr)`, `partition(callback, arr)`, `countBy(callback, arr)`, `reduce(callback, init, arr)`, `scan(callback, init, arr)`, etc.

## Patterns

### Calling a registered function

Register the function body in the function registry, call it by name:

```json
{ "$call": "myFunction", "$args": [1, 2, 3] }
```

### Inline anonymous function

Use a function body directly as the `$call` callee:

```json
{
  "$call": {
    "$params": ["x"],
    "$return": { "$call": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] }
  },
  "$args": [5]
}
```

### Pipeline (filter -> map -> reduce)

Use `$let` bindings to name intermediate steps:

```json
{
  "$let": {
    "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "evens": { "$call": "filter", "$args": [{ "$fn": "isEven" }, { "$var": "nums" }] },
    "doubled": { "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "evens" }] }
  },
  "$in": { "$call": "reduce", "$args": [{ "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{ "$call": "pipe", "$args": [[{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5] }
```

### Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
  }
}
```

### Dynamic Apply

Use `apply` to call a function with a dynamically constructed argument array:

```json
{ "$call": "apply", "$args": [{ "$var": "targetFn" }, { "$var": "collectedArgs" }] }
```

### Object Transformation

Use `entries` -> HOF -> `fromEntries` to transform objects:

```json
{
  "$let": {
    "pairs": { "$call": "entries", "$args": [{ "$var": "obj" }] },
    "filtered": {
      "$call": "filter",
      "$args": [
        {
          "$params": ["pair"],
          "$return": { "$call": "gt", "$args": [{ "$get": 1, "$from": { "$var": "pair" } }, 3] }
        },
        { "$var": "pairs" }
      ]
    }
  },
  "$in": { "$call": "fromEntries", "$args": [{ "$var": "filtered" }] }
}
```

## Execution Limits

### Circular Variable Dependencies

Lazy `$let` and module bindings form dependency graphs resolved on demand. If
resolving a binding requires resolving itself—directly
(`{ "$let": { "x": { "$var": "x" } }, "$in": { "$var": "x" } }`) or through a
cycle (`a → b → a`)—evaluation errors instead of looping. The cycle is
reported in the message, e.g.:

```
Circular variable dependency detected: a -> b -> a
```

This detection is part of the language: it is always on, needs no configuration, and is enforced by every implementation. It reports the first cycle reached, even when the cycle does not start at the first variable.

Evaluating a `$let` consumes the ordinary one unit of expression fuel, as does
each binding expression when it is first forced. Entering a `$let` does not
invoke a function, consume function-invocation fuel, or increase call depth.
Calling a function-valued binding later has the ordinary function-call costs.

### Host-configured resource limits

Beyond the always-on circular check, hosts may cap the resources a program
consumes. Fuel accounting is deterministic and specified for conformance;
produced-value size has a portable definition. When explicitly configured:

- **Fuel** (`maxFuel`) bounds total metered work; exceeding it errors with `Maximum fuel limit of N exceeded`.
- **Value size** (`maxValueSize`) bounds the length of any array or string a program produces; exceeding it errors with `Maximum value size of N exceeded`.

A third cap, **call depth** (`maxCallDepth`), guards recursion against host stack overflow and uses an implementation-defined default when unset. Hosts may additionally cancel a run cooperatively or impose a wall-clock timeout; those are host-only safety nets and, being non-deterministic, are **not** part of the conformance spec.

Two further limits are fixed language constants rather than host
configuration: every JSON tree is bounded by a **structural depth** of 512
nested container levels (erroring with `Maximum structural depth of 512
exceeded` at every parsing, checking, evaluation, printing, validation, and
hydration boundary), and combined expression-plus-invocation nesting during
evaluation is bounded at 4,096 (erroring with `Maximum evaluation nesting of
4096 exceeded`). See
[Execution limits § Fixed structural limits](execution-limits.md#4-fixed-structural-limits).

Portable deployment limits are supplied through a
[deployment profile](deployment-profile.md); host entry and runtime-adapter boundaries
are described by the [environment contract](environment-contract.md), with
persistent TypeScript behavior in [Durable task hosting](durable-host.md). For
the normative cost model, see [Execution limits](execution-limits.md). The
TypeScript CLI's `eval` command accepts `--max-call-depth`, `--max-fuel`, and
`--max-value-size` to set these limits for an individual run.

## Constraints

- `$var` must be the sole key; its value is a plain variable name (no path notation, no `$get` sibling).
- `$let`/`$in` must be the only two keys; both are required, and `$let` must be
  a non-empty object of bindings.
- `$get`/`$from` must be the only two keys; both are required. This is the only property-access form.
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` may have only `$cond` and optional `$else`; each entry must be a two-element array.
- `$match` must have `$match`, `$cases`, and `$else`; `$match` and case values must evaluate to scalar JSON values.
- `$and` must be the sole key; value must be an array of expressions.
- `$or` must be the sole key; value must be an array of expressions.
- `$raw` must be the sole key.
- A function call has exactly `$call` (the callee) and `$args` (an array of arguments) and no other keys.
- A function reference has `$fn` as its sole key; `$fn` is never an array.
- `$return` cannot coexist with `$call` or `$fn`.
- A source function body has `$return` and only optional `$params`, `$sig`, and
  string-valued `$comment`; `$captures` and `$runtimeContract` are reserved
  runtime fields, and `$types` is module-only.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
