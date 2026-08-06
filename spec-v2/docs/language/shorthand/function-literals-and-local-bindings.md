# Function literals and local bindings

`(params) => body`. The body is a single expression, optionally followed by a
`where { … }` clause introducing **lazy local bindings**.

```jfn
(a, b) => add(a, b)
```

```json
{ "$params": ["a", "b"], "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] } }
```

## `body-expr where { name: value, … }`

The result expression comes first; the trailing `where { … }` clause supplies
expression-local bindings. Bindings use `:` and lower to the canonical
`$let`/`$in` form.

```jfn
(x, y) => doubled where {
  sum:     add(x, y),
  doubled: mul(sum, 2)
}
```

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

Bindings are lazy, memoized, order-independent, mutually recursive, and
cycle-checked. Only bindings reachable from `$in` are evaluated.
Every binding name in one `where` block must be unique; nested `where` blocks
may shadow names from enclosing scopes.
The checker rejects a binding that is not lexically reachable from the result,
directly or through another binding. Its contents are not checked.
Every reachable value binding is checked where it is referenced. A reachable
function-valued binding is a named function: it must include complete parameter
and return annotations, and its body is checked against that declared
signature. Bare inline lambdas remain available where a higher-order call
supplies their signature contextually.

`where` is a lowest-precedence postfix clause on a body. Bodies occur after
`=>`, inside a parenthesized group, in a `where` binding value, in a
`cond`/`match` result arm, and in the body positions of `do`.
Every occurrence lowers the same way: to a `$let` whose `$in` is the preceding
body expression. For a function literal, that `$let` becomes the function's
`$return`.

A module binding takes an `expr`, not a body. Parentheses are required to
attach `where` to its complete value.

```jfn
answer where { answer: 40 + 2 }
```

```json
{
  "$let": {
    "answer": { "$call": "add", "$args": [40, 2] }
  },
  "$in": { "$var": "answer" }
}
```

The canonical `$let` object has exactly `$let` and `$in`, and its binding map
must be non-empty. A `$let` is an expression scope, not a function call, so
entering it is not an invocation event and consumes no call frame. The `$let`
counts in its containing region's static cost constant, and each binding
expression is its own region, charged when the binding is first forced.

Canonical rendering writes `$let` as `<in> where { ...bindings }`, including
when it occurs directly under a function's `$return`.

Bindings can see the surrounding scope. In a function's `$return`, that
includes its parameters; the `$let` names then shadow same-named parameters,
captures, and outer bindings. A binding whose value is a function literal is
callable by its local name, including recursively or mutually recursively.

An unparenthesized clause attaches to the largest expression in its current
body. In particular, it scopes over a complete conditional:

```jfn
(x) => if doubled > 0 then doubled else 0 where { doubled: x * 2 }
```

To scope locals to only one branch, make that branch a parenthesized body:

```jfn
if x > 0 then x else (fallback(x) where { fallback: (n) => n - 1 })
```

A nested function literal starts a new body after its `=>`, so its trailing
`where` naturally belongs to the nested function. Parenthesize the complete
nested literal before `where` when the clause should belong to an enclosing
body instead.

A bare `{...}` is always a data object, including immediately after `=>`:

```jfn
(state) => { output: boardSection(state, ""), exitCode: 0 }
```

```json
{
  "$params": ["state"],
  "$return": { "output": { "$call": "boardSection", "$args": [{ "$var": "state" }, ""] }, "exitCode": 0 }
}
```

## Parameters

- **No params:** `() => …` lowers to a body with **no `$params`** key.
- **Required param:** `(value) => …` lowers to `"$params": ["value"]`; omitting
  its argument is an evaluation error.
- **Optional param:** `(value?) => …` lowers to
  `"$params": [{ "$param": "value", "$optional": true }]`; omission binds
  `null`.
- **Defaulted param:** `(value = expr) => …` lowers to
  `"$params": [{ "$param": "value", "$default": expr }]`; omission installs a
  lazy default binding.
- **Rest param:** `(first, ...rest) => …` → `"$params": ["first", "...rest"]`.
- **Object-pattern param:** `({ from, to }) => …` — see below.

A call supplies fixed parameters positionally. Required slots establish the
minimum arity; optional and defaulted slots extend the fixed maximum. Without a
rest parameter, the callee accepts every argument count in that inclusive
range and rejects counts outside it. A final rest parameter removes the upper
bound and collects all arguments after the fixed slots, including an empty
remainder.

```jfn
(id, nickname?, greeting = "hello", ...rest) => ...
```

```json
[
  "id",
  { "$param": "nickname", "$optional": true },
  { "$param": "greeting", "$default": "hello" },
  "...rest"
]
```

`?` means that the positional slot may be omitted; it does not make an
explicitly supplied value nullable. Omitting an optional slot binds `null`.
Omitting a defaulted slot installs its `$default` expression as the binding's
lazy value, evaluated only if first read. Explicit `null` is supplied data and
suppresses either omission behavior. json-fn has no `undefined` value.

Default expressions use the function invocation scope. They may reference any
parameter, other defaults, object-pattern fields, captures, and outer or module
bindings. They cannot reference a `where` binding inside `$return`. A
self-reference or dependency cycle fails only if forced.

Canonical parameter layouts place every required positional or object-pattern
slot before all optional/defaulted positional slots, with a rest parameter last
when present. Optional and defaulted slots may be mixed within that omittable
suffix. For example, `(required, fallback = 0, label?, ...rest) => …` is valid,
while `(fallback = 0, required) => …` is not. A rest parameter cannot be
optional or defaulted. Combining both omission forms on one binding
(`value? = expr`) is also invalid: an omittable binding either produces `null`
or has a default, never both.

Every name bound by one canonical `$params` array must be unique, including
names introduced by object patterns and the rest parameter.

### Object-pattern parameters

A parameter may be an **object pattern** `{ f1, f2 }` that destructures a single
object argument into named locals, instead of relying on positional order. It
lowers to a `{ "$fields": [...] }` slot in `$params`.

```jfn
({ from, to }) => sub(to, from)
```

```json
{
  "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$call": "sub", "$args": [{ "$var": "to" }, { "$var": "from" }] }
}
```

`move({ from: 3, to: 7 })` is an ordinary positional call passing one data
object. The parameter destructures that object. The argument is
required and must be a plain object (not an array or `null`); omitting it or
supplying any non-object value is an evaluation error. Each unmarked shorthand
field is required and must be an own property of that object. Absent or
non-own required fields are treated as missing, while extra object keys are
ignored.

`?` and `= expr` apply the same binding behaviors to individual fields:

```jfn
({ from, via?, to = 0 }) => ...
```

```json
{
  "$fields": [
    "from",
    { "$field": "via", "$optional": true },
    { "$field": "to", "$default": 0 }
  ]
}
```

An absent optional own field binds `null`; an absent defaulted own field
evaluates its default lazily when read. An own field whose value is explicitly
`null` binds `null` and suppresses a default. The whole object-pattern argument
remains required even when every field is omittable. Omission inside `$fields`
does not make the containing positional pattern omittable, so that pattern must
still precede every optional or defaulted positional slot. There is no syntax
for an optional or defaulted whole object-pattern argument.

- A pattern consumes exactly **one required** positional slot, so it may mix
  with other required and rest params: `(label, { x, y }) => …`,
  `({ x }, ...rest) => …`, `({ a }, { b }) => …`.
- A **trailing comma** inside the pattern is accepted and normalizes away.
- A field cannot combine `?` and `=`, and field order does not affect whether
  the containing positional slot is required.

Object patterns must be non-empty and contain identifier fields. Renamed,
nested, and rest object patterns are invalid.

## Closures & recursion

A nested function literal is a closure. Functions recurse through a module name
or a local function binding.

Escaping closures may contain the canonical `$captures` field. It is serialized
closure state and has no shorthand source form.

```jfn
(x) => (y) => x + y
```

```json
{
  "$params": ["x"],
  "$return": { "$params": ["y"], "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] } }
}
```

