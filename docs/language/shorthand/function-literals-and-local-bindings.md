# 8. Function literals and local bindings

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

**Semantics (important).** Bindings are **lazy** and **order-independent**: they
form a dependency graph resolved on demand, and a binding that is never reached
from `$in` is **never evaluated**. They are memoized, mutually recursive, and
cycle-checked. The `where` form is declarative, not a
sequence of steps. (E.g. a binding may hold an unconditionally-recursive call
that only terminates because it is forced solely in the branch that uses it.)
Every binding name in one `where` block must be unique; nested `where` blocks
may shadow names from enclosing scopes.
The checker rejects a binding that is not lexically reachable from the result,
directly or through another binding. Its contents are not checked, avoiding
cascading diagnostics from a declaration that should instead be removed.
Every reachable value binding is checked where it is referenced. A reachable
function-valued binding is a named function: it must include complete parameter
and return annotations, and its body is checked against that declared
signature. Bare inline lambdas remain available where a higher-order call
supplies their signature contextually.
Placing the answer first and its supporting locals after mirrors how these
functions read: headline, then the details that back it up.

`where` is a lowest-precedence postfix clause on a **body**. Bodies occur at the
program top level, after `=>`, inside a parenthesized group, in a `where` binding
value, in a `cond`/`match` result arm, and in the body positions of `do`.
Every occurrence lowers the same way: to a `$let` whose `$in` is the preceding
body expression. For a function literal, that `$let` becomes the function's
`$return`.

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
must be non-empty. A `$let` is an expression scope, not a function call:
entering it consumes no call frame or function-invocation fuel.

The printer reconstructs a valid shorthand-compatible `$let` as
`<in> where { ...bindings }`. A `$let` nested directly under a function's
`$return` therefore prints as function-body `where`; the same canonical form
elsewhere prints as expression-level `where`.

Bindings can see the surrounding scope. In a function's `$return`, that
includes its parameters; the `$let` names then shadow same-named parameters,
captures, and outer bindings. A binding whose value is a function literal is
callable by its local name, including recursively or mutually recursively.

For example, the function-body form above always nests the let under
`$return`:

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

A bare `{...}` is **always** a data object — including immediately after `=>`:

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

The surface forms are direct spellings of the canonical descriptors:

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

Default expressions are ordinary json-fn expressions. They are resolved in the
function invocation scope, so they may reference earlier or later parameters,
other defaults, object-pattern fields, runtime captures, and outer/module
bindings. They cannot reference a `where` `$let` nested inside `$return`, which
is entered only after parameter binding. This is deliberately not JavaScript's
left-to-right default evaluation despite the TypeScript-style surface spelling.
A self-reference or dependency cycle is permitted syntactically and fails at
runtime only if evaluation forces the cycle.

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

The **calling convention is unchanged**: `move({ from: 3, to: 7 })` is an
ordinary positional call passing one data object — the "named-ness" lives
entirely in the parameter, which destructures that object. The argument is
required and must be a plain object (not an array or `null`); omitting it or
supplying any non-object value is an evaluation error. Each unmarked shorthand
field is required and must be an own property of that object. Absent or
inherited required fields are errors, while extra object keys are ignored. This
mirrors [shorthand-property punning](literals-and-data.md#data-objects--key-value): a destructured
parameter and the record you build to pass it read identically.

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
- The printer renders a `$fields` slot as `{ required, optional?, defaulted =
  expr }` (space inside the braces, `", "` between fields) inside the normal
  `(params) =>` header.
- A field cannot combine `?` and `=`, and field order does not affect whether
  the containing positional slot is required.

Not accepted in this version (each is a **parse error**, reserving the syntax
for later): empty pattern `({}) => …`, rename `({ from: f }) => …`, nesting
`({ a: { b } }) => …`, rest pattern `(...{ x }) => …`, and non-identifier fields.

## Closures & recursion

No special syntax. A nested function literal is a closure (outer variables are
captured by substitution when it is returned as a value). Functions call
themselves by registered name, or a local binding whose value is a function
literal can recurse by its local name.

Escaping closures may acquire the runtime-only canonical `$captures` field.
It is serialized closure state, not a `where` binding, has no authoring
shorthand, and is rejected by the shorthand printer rather than discarded.

```jfn
(x) => (y) => x + y
```

```json
{
  "$params": ["x"],
  "$return": { "$params": ["y"], "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] } }
}
```

---

