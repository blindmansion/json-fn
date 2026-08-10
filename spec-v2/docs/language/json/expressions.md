# Expressions

Every JSON value is an expression. Its shape determines how it evaluates.

## Primitives

Strings, numbers, booleans, and `null` evaluate to themselves.

## Arrays

Each element is evaluated recursively. `[1, { "$call": "add", "$args": [2, 3] }]` evaluates to `[1, 5]`.

## Plain Objects

Each value is evaluated recursively (keys are not). `{ "x": { "$call": "add", "$args": [1, 2] } }` evaluates to `{ "x": 3 }`.

## Function call — `{ $call, $args }`

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

### Dynamic dispatch

The callee `$call` can be a `$var` reference or any expression that evaluates
to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$call": { "$var": "fnName" }, "$args": [3, 4] }
}
```

Called with `["add"]` this returns `7`; called with `["mul"]` it returns `12`.

## Function reference — `{ $fn }`

`$fn` evaluates its value and returns the resulting function name or body
without calling it. Its value cannot be an array.

```json
{ "$fn": "double" }
```

## Variable reference — `{ $var }`

Resolves a variable by name. `$var` must be the sole key, and its value is a plain variable name looked up directly in scope — there is no dot/bracket path notation and no `$get` sibling.

```json
{ "$var": "x" }
```

## Let binding — `{ $let, $in }`

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

Bindings are strict: every binding evaluates eagerly, exactly once, in
dependency order, before `$in`. Bindings need not appear in dependency order
in source — the references between them determine evaluation order. A failing
binding fails the whole `$let`, whether or not `$in` references it. In
variable lookup, a `$let` binding shadows same-named function parameters,
captures, enclosing bindings, and module entries throughout every binding
expression and `$in`.

### Dependency order

A binding depends on a sibling binding when its expression **statically
references** it — directly or through transitive `$var`, named `$call`, and
`$fn` references. References from inside a nested function body count:
creating a closure consumes the referenced values, so they must exist when
the closure is created.

One exemption preserves mutual recursion: a **call-position** reference to a
sibling binding whose literal value is a function body resolves by name and
adds no dependency. A **value-position** reference to such a binding — `$var`
or `$fn` taking the closure as a value — does add one, because taking a
closure as a value requires the closure to exist. Two sibling functions may
therefore recurse mutually through calls, while a value-position cycle
between them (each storing the other's closure) is a cycle error.

The exemption removes only the edge to the sibling function itself; the
static-reference relation continues **through** the exempted call. A binding
that calls a sibling function depends on every binding that function's body
references in value position, directly or transitively: creating the caller's
closure [captures those values](closures.md#the-capture-relation) even though
the called function is resolved by name.

Bindings evaluate one at a time. At each step, the first binding in source
order whose dependencies have all been evaluated is evaluated next. If
unevaluated bindings remain and none is ready, the bindings form a cycle and
evaluation fails; direct self-reference is the one-binding case. Cycle error
identity is defined in
[Execution limits](execution-limits.md#circular-variable-dependencies). An
implementation may evaluate bindings in any order that produces the same
observable results and
[cost trace](../../runtime/execution-limits.md#determinism).

### Dynamic references during binding evaluation

A dynamic callee can resolve to a sibling binding's name at runtime without
appearing in the static reference graph. While bindings are still being
evaluated, a dynamic name resolution that reaches a sibling binding **not yet
evaluated** is a deterministic evaluation error naming that binding. Inside
`$in` every binding has been evaluated, so the error cannot occur there.

### Checking

The checker applies these rules:

- the binding must be lexically reachable from `$in`, including through
  transitive `$var`, named `$call`, and `$fn` references;
- a reachable named function must declare a complete signature, and its body
  must satisfy that signature;
- a reachable value binding is checked wherever it is referenced;
- a binding cycle under the dependency relation above is reported statically.

An unreachable binding produces an unused-binding error and its contents are
not checked. Static reachability does not change evaluation: in unchecked
evaluation, an unused binding still evaluates — and can still fail.

A binding whose literal value is a function body is callable by its binding
name. It shadows an outer callable with the same name. A non-function binding
does not shadow names in call position. Sibling function bindings may be
mutually recursive.

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

Arithmetic does not preserve refinements. For example, if
`Score = integer & min(0)`, arithmetic involving a `Score` produces `integer`;
the checker does not infer that the result still satisfies `min(0)`. Postfix
`!` only removes `null`; use `expression checked as Score` to validate a computed
result and establish the refinement explicitly.

Data passes through a successful ascription unchanged. Ascribing a function
type creates a serializable boundary that validates later arguments and
results.

## Property access — `{ $get, $from, $else? }`

All property access uses `$get`/`$from`. `$from` evaluates to the target and `$get` evaluates to the key read from it:

```json
{ "$get": "name", "$from": { "$var": "person" } }
{ "$get": 1, "$from": { "$var": "items" } }
{ "$get": { "$var": "fieldName" }, "$from": { "$var": "data" } }
{ "$get": 0, "$from": { "$call": "concat", "$args": [[10], [20]] } }
```

The evaluated `$get` key must be one of exactly two kinds:

- a **string** key — reads an object property;
- an **integer** index — reads an array element, or a Unicode code point from
  a string.

Any other evaluated key is an immediate error naming the rule: "evaluated
`$get` key must be a string or an integer". There is no array-path form; a
multi-segment path is written as nested `$get`s, one per segment:

```json
{
  "$get": "city",
  "$from": { "$get": "address", "$from": { "$var": "person" } }
}
```

Shorthand prints such static chains back as `person.address.city`; see
[Function calls and references](../shorthand/function-calls-and-references.md).

The accepted key kind depends on the target. Objects reject integer keys,
while arrays and strings reject string keys. Property access does not coerce
keys: use an explicit conversion such as
`{ "$get": { "$call": "str", "$args": [1] }, "$from": { "1": "one" } }`
(`object[str(number)]` in shorthand) when a numeric value is intended to name an
object property.

String indices count Unicode code points, not UTF-16 code units or
user-perceived grapheme clusters. For example, `"a😀b"[1]` is `"😀"` and
`length("a😀b")` is `3`. String `slice` offsets and string `indexOf` results use
the same unit; `split(string, "")` returns one element per code point.

`$from` may be any expression: a variable, a function result, a literal, or
another `$get`/`$from` chain. Traversal into a present `null` value errors, as
does a `$get` whose target is not an object, array, or string.

### Misses and the `$else` arm

A **bare** `$get` that misses — a missing object key, or an out-of-range or
negative index — is an immediate error: absence is a bug. When absence is a
case rather than a bug, the optional **`$else` arm** says so at the access
site: on a genuine miss, the arm evaluates and supplies the value.

```json
{ "$get": "sku-42", "$from": { "$var": "inventory" } }
{ "$get": "sku-42", "$from": { "$var": "inventory" }, "$else": { "$var": "empty" } }
```

`$else` fires on **absence only** — never on a present `null` value. A key
mapped to `null` is present: the read returns `null` and the arm does not
evaluate. Both bare reads and `$else` arms therefore preserve the distinction
between an absent key and a present-and-null value. In shorthand the arm is
written with the `??` operator (`inventory["sku-42"] ?? empty`), which — unlike
its JavaScript namesake — fires on absence, not on `null`; see
[Operators and precedence](../shorthand/operators-and-precedence.md).

The arm evaluates only on a miss, like the `$else` arms of `$if`, `$cond`, and
`$match`. This is branch selection — one of two arms, at most one taken — not
an exception to the language's strict evaluation: branch arms were never part
of the strictness claim, and lazy parameter defaults remain the language's one
documented exception (see [Functions](functions.md)).

Miss errors carry a stable identity:

- an object or map miss names the key and, when the container is small, the
  available keys;
- an array or string miss names the index and the container's length
  (negative indices are the same error);
- an invalid key names the evaluated key's kind: "evaluated `$get` key must be
  a string or an integer".

All three are host errors — the same class as `checked as` failures and
arithmetic errors — not `raise`-catchable domain signals.

### Checking reads

A bare read types as the element or field type `T` — never `T | null`. The
`$else` form types as `T | typeof(else-arm)`, collapsing when the arm's type is
subsumed; `$else: null` (`?? null` in shorthand) is therefore the nullable
lookup, typed `T | null`, with no dedicated builtin. A bare read of a field
declared optional (`k?: T`) is a static error — "this field may be absent; add
`?? default` or guard with `hasKey`" — since the checker cannot rule out the
miss; [`hasKey` narrowing](narrowing.md) makes the guarded bare read typecheck.
A literal index beyond a tuple type's tracked arity (`pair[2]` against a
two-element tuple) is likewise a static error. Map and open-object reads stay
bare-allowed: the checker cannot prove presence there, and those are the sites
where the `$else` arm earns its keep.

## Function body — `{ $return, ... }`

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

Evaluating a function body creates a function value carrying the body as
authored plus a [capture record](closures.md) holding the evaluated values of
its free variables — including when the body is used directly as a call's
callee. Capture happens at creation; the body is never rewritten.

## Conditional — `{ $if, $then, $else }`

All three keys are required. `$if` is evaluated; if truthy, `$then` is evaluated and returned, otherwise `$else`. Short-circuits (only the taken branch evaluates).

```json
{
  "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] },
  "$then": "positive",
  "$else": "non-positive"
}
```

## Multi-branch conditional — `{ $cond }`

`$cond` is an array of `[condition, result]` pairs. The first truthy condition
wins. If none matches, `$else` is evaluated. Without `$else`, evaluation fails.
Only the selected result is evaluated.

```json
{
  "$cond": [
    [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

`[true, result]` is an explicit catch-all branch.

## Scalar value match — `{ $match, $cases, $else }`

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

## Short-circuit and — `{ $and }`

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

Unlike the `and` builtin, `$and` short-circuits and accepts any number of
operands.

## Short-circuit or — `{ $or }`

Array of expressions evaluated left-to-right. Returns the first truthy value, or the last value if all are falsy. Short-circuits (stops evaluating after the first truthy result).

```json
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
```

Comparison and negation use ordinary
[standard-library functions](standard-library.md#comparison):

```json
{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }
{ "$call": "gte", "$args": [{ "$var": "score" }, 10] }
{ "$call": "not", "$args": [{ "$call": "eq", "$args": [{ "$var": "status" }, "playing"] }] }
```

`eq` and `neq` use structural equality.

## Raw — `{ $raw }`

Returns the value as-is without evaluating nested expressions: the payload is
a JSON value, not json-fn syntax. Use `$raw` to preserve data that would
otherwise be interpreted as expression syntax (keys such as `$fn`, `$var`, or
`$call`) or to keep a literal `$comment` entry. Shorthand infers this boundary
around static JSON containing quoted `$`-prefixed keys; see
[Literals and data](../shorthand/literals-and-data.md). A `$raw` payload counts
toward its containing region's static cost constant exactly like the
equivalent constant value.

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

A supported `$comment` key with a string value is ignored when it appears
beside an expression form and is stripped from plain-data objects. It remains
present in the source JSON.

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

- The value must be a string. A non-string value is an ordinary property and is
  invalid beside a closed expression form.
- Allowed as a sibling key in expression forms that use the common comment
  rule (`$call`/`$args`, `$fn`, `$var`, `$if`/`$then`/`$else`, `$cond`, `$and`,
  `$or`, `$raw`, `$get`/`$from`, and function bodies). A `$let` expression is
  the exception: its outer object has exactly `$let` and `$in`.
- In plain data objects, `$comment` is stripped from the output. `$raw`
  preserves a literal `$comment` property.
- Inside `$raw`, the entire value is returned unchanged.
- Function values preserve `$comment`: [capture](closures.md) never rewrites
  the body, so a returned body keeps its comments.

## Constraints

- `$var` must be the sole key; its value is a plain variable name (no path notation, no `$get` sibling).
- `$let`/`$in` must be the only two keys; both are required, and `$let` must be
  a non-empty object of bindings.
- A property access has `$get` and `$from` (both required) and an optional
  `$else`; no other keys. This is the only property-access form.
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
  string-valued `$comment`; `$captures` (the
  [capture record](closures.md#the-capture-record--captures)) and
  `$runtimeContract` appear only on evaluated function values and are invalid
  in source, and `$types` is module-only.
- A supported string `$comment` does not count toward the key limits of forms
  listed under [Comments](#comments--comment). `$let`, `$match`, `$nonnull`,
  and `$as` do not allow it.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.

