# json-fn Shorthand Specification

A compact, code-first surface syntax for authoring json-fn programs. The
**canonical form is JSON** — the interpreter only ever sees JSON. Shorthand
lowers deterministically to canonical json-fn JSON, and canonical JSON
pretty-prints back to shorthand.

- **Semantics-preserving.** Shorthand is correct only if it lowers to exactly
  the JSON you would have hand-written.
- **Code-first.** Identifiers and calls are code by default; literal strings are
  quoted; inert data is marked with `raw`.
- **Bijective (by normal form).** One canonical shorthand per JSON node and vice
  versa. Byte-exact round-tripping of arbitrary hand-written JSON is _not_
  guaranteed — JSON is normalized to canonical form first (e.g. property-access
  spellings, see §5).

File extension: `.jfn`.

---

## 1. Lexical structure

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`. Used for variables, function names
  (in call position), parameters, and local names. Must not contain `.` or `[`.
- **Numbers / booleans / null:** as in JSON (`42`, `-3.5`, `true`, `false`,
  `null`). A leading `-` on a numeric token is part of the literal.
- **Strings:** double-quoted, with JSON escape rules (`"\n"`, `"\u2654"`,
  `"\""`). Quoting is the **sole** signal for a literal string.
- **Whitespace** is insignificant except as a token separator. Elements in
  arrays, objects, argument lists, and blocks are comma-separated.
- **Comments:** `// …` to end of line and non-nested `/* … */` block comments.
  Both are currently discarded as trivia. 🔴 **TODO(comments):** attachment
  rules (which node a comment lowers to as `$comment`, group/section comments,
  comments on non-object targets) are deferred and unspecified.

---

## 2. Expressions overview

Every construct is an expression. Three value "states" from the language are
made explicit in the surface syntax:

| State                          | Surface            | JSON                   |
| ------------------------------ | ------------------ | ---------------------- |
| Evaluated expression           | bare code          | `$call` / `$fn` / `$var` / forms |
| Plain data (values evaluated)  | `[...]` / `{k: v}` | array / object         |
| Inert (verbatim, un-evaluated) | `raw <json>`       | `{ "$raw": <json> }`   |

---

## 3. Literals and data

### Scalars

```jfn
42        "hello"        true        null
```

Lower to themselves.

### Arrays — `[...]`

Elements are **evaluated**.

```jfn
[1, add(2, 3)]
```

```json
[1, { "$call": "add", "$args": [2, 3] }]
```

An array element may be spread with `...`. Consecutive ordinary elements form
array-literal segments; the ordered segments lower to one variadic `concat`
call. This evaluates every expression once, from left to right.

```jfn
[first, ...middle, last]
```

```json
{ "$call": "concat", "$args": [[{ "$var": "first" }], { "$var": "middle" }, [{ "$var": "last" }]] }
```

The spread operand must evaluate to an array. Even a spread-only literal lowers
through `concat` (`[...xs]` → `concat(xs)`), so that requirement is enforced.

### Data objects — `{ key: value }`

**Values are evaluated; keys are literal data** (never evaluated). Keys may be
bare identifiers or quoted strings.

```jfn
{ name: "ada", score: x + 1 }
```

```json
{ "name": "ada", "score": { "$call": "add", "$args": [{ "$var": "x" }, 1] } }
```

**`$`-prefixed keys are forbidden** in a data object (they would collide with a
magic key on lowering). Use `raw` for data containing `$`-keys.

**Shorthand-property punning.** A bare identifier key with no `: value` puns to
a same-named variable read — `{ year }` means `{ year: year }`. It mirrors the
`{ year, month, day }` **object-pattern parameter** (§8), so a destructured
parameter and the record you build to pass it read identically.

```jfn
{ year, month, day }
```

```json
{ "year": { "$var": "year" }, "month": { "$var": "month" }, "day": { "$var": "day" } }
```

Punning and explicit entries mix freely (`{ year, month: m }`). Only **bare
identifier** keys pun; a quoted-string key always requires an explicit value.
The pun is the **canonical printback** for a `{ "$var": k }` value whose key `k`
equals the variable name (a value with a `$get` path — `{ year: year.start }` —
is not a pun and prints in full).

Object entries may be spreads (`...object`) or computed keys (`[key]: value`).
They lower in source order using the existing `merge` and `fromEntries`
builtins; `merge` is shallow and its right-hand object wins conflicts.

```jfn
{ ...defaults, name: requestedName, [extraKey]: extraValue }
```

```json
{
  "$call": "merge",
  "$args": [
    {
      "$call": "merge",
      "$args": [{ "$var": "defaults" }, { "name": { "$var": "requestedName" } }]
    },
    {
      "$call": "fromEntries",
      "$args": [[[{ "$var": "extraKey" }, { "$var": "extraValue" }]]]
    }
  ]
}
```

Ordinary entries between dynamic entries are grouped into plain-object chunks.
A computed entry always uses `fromEntries`, including when its key expression
is a string literal, so a computed `$`-prefixed result remains data rather than
canonical expression syntax. Object spread operands must be objects; a
spread-only literal lowers as `{ ...source }` → `merge({}, source)` to preserve
that validation. Computed keys follow `fromEntries`' string-key contract.

### Inert data — `raw`

`raw` introduces a **verbatim JSON island**; nothing inside is evaluated. It
lowers to `$raw`. The body is **strict JSON** (quoted keys, no shorthand).

```jfn
raw [[-2, -1], [-2, 1], [-1, -2]]

raw { "$call": "not", "$args": ["x"] }
```

```json
{ "$raw": [[-2, -1], [-2, 1], [-1, -2]] }

{ "$raw": { "$call": "not", "$args": ["x"] } }
```

`raw` is the **exception**, not the default: reach for it only to (a) protect
data containing `$`-prefixed keys, or (b) skip evaluation cost for a constant in
a hot path. Plain constant data (e.g. `[1, 2, 3]`) needs no `raw`.

---

## 4. Function calls and references

In **call position**, a bare identifier is a literal function _name_; a
parenthesized expression is an _evaluated_ callee.

**Name resolution is lexical-first, registry-second — uniformly.** A name in
call position (a direct call `f(x)`, an operator that desugars to a named call
like `+`→`add`, or a bare reference used as a value) resolves against the
enclosing lexical scope chain first. If it resolves to a _function declaration_
— a parameter, a `where`-local, or a module binding whose value is a function —
that binding is used, **shadowing** any same-named stdlib/host builtin. If the
lexical binding is _not_ a function (e.g. `add: 5`), or there is no lexical
binding, resolution falls through to the function registry (scoped local
functions + stdlib/host). Only if both miss is it an error. This makes operator
desugaring, direct calls, and bare references agree on shadowing.

```jfn
add(3, 4)                 // named call
f()                       // zero-arg call
(fnName)(3, 4)            // dynamic dispatch (callee is an expression)
((x) => x * x)(5)         // inline function literal as callee
```

```json
{ "$call": "add", "$args": [3, 4] }
{ "$call": "f", "$args": [] }
{ "$call": { "$var": "fnName" }, "$args": [3, 4] }
{ "$call": { "$params": ["x"], "$return": { "$call": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] } }, "$args": [5] }
```

### Spread arguments

Arguments may be spread from an array. Ordinary argument runs become array
segments, those segments are combined with `concat`, and the callee plus final
argument array are passed to `apply`.

```jfn
f(first, ...middle, last)
```

```json
{
  "$call": "apply",
  "$args": [
    { "$fn": "f" },
    {
      "$call": "concat",
      "$args": [[{ "$var": "first" }], { "$var": "middle" }, [{ "$var": "last" }]]
    }
  ]
}
```

A sole spread avoids the unnecessary `concat`: `f(...args)` lowers to
`apply(&f, args)`. The `$fn` wrapper preserves the lexical-first,
registry-second behavior of an ordinary named call. Evaluated callees use their
ordinary expression value instead. Spread operands must evaluate to arrays.
The current `core.apply` checker rule is intentionally imprecise, so a spread
call's result type degrades to `any` even when the callee has a known signature;
this is a checker limitation, not a new canonical JSON form.

### Method calls and chained application

The callee slot is a full postfix expression, so anything that produces a
function value can sit in call position. In particular, a **property-access
chain** or a **preceding call** in call position is an evaluated callee — the
access/call is performed first and its result is applied. This is the
"method-call" surface: it dispatches through a record of closures (the pattern
capabilities use — see `plans/effects-implementation.md`), with no distinct
`$` form. A bare name is still the only thing that means a literal function
_name_ (`f(x)` → `{ "$call": "f", "$args": [ … ] }`); the moment a `.`, `[…]`, or a prior
`(…)` intervenes, the callee is evaluated.

```jfn
caps.db.query(sql)        // call the closure held at caps.db.query
io.readLine()             // zero-arg method call
caps[name](x)             // computed-key dispatch
f(x).method(y)            // method on a call result (callee uses $get/$from)
makeCountdown(42)(3)      // chained application (call the returned closure)
```

```json
{ "$call": { "$get": ["db", "query"], "$from": { "$var": "caps" } }, "$args": [{ "$var": "sql" }] }
{ "$call": { "$get": "readLine", "$from": { "$var": "io" } }, "$args": [] }
{ "$call": { "$get": { "$var": "name" }, "$from": { "$var": "caps" } }, "$args": [{ "$var": "x" }] }
{ "$call": { "$get": "method", "$from": { "$call": "f", "$args": [{ "$var": "x" }] } }, "$args": [{ "$var": "y" }] }
{ "$call": { "$call": "makeCountdown", "$args": [42] }, "$args": [3] }
```

The callee lowering is exactly the property-access lowering of §5 (a `$get`/`$from`
chain rooted at a variable or an arbitrary expression), placed in the `$call`
position of the call node.

> **Printer note (deferred).** These forms parse and evaluate today, but the
> canonical pretty-printer currently wraps the callee in parentheses
> (`(caps.db.query)(sql)`, `(makeCountdown(42))(3)`). That still round-trips —
> `parse(print(x))` is `x` — so the bijective-by-normal-form guarantee holds; it
> is only less pretty than the bare source. Tightening the printer to emit the
> bare form for access-headed and call-headed callees (while keeping the parens
> on a bare `$var` callee, since `f(x)` would otherwise collide with a
> literal-name call) is tracked as deferred polish (§12).

### Function reference — `&`

Passes a function as a value (the language's `$fn` reference).

```jfn
&double                   // by name
map(&double, nums)
&(expr)                   // evaluated reference (rare)
```

```json
{ "$fn": "double" }
{ "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "nums" }] }
{ "$fn": <expr> }
```

**`&` is optional for a bare name.** Because a bare identifier in value position
falls through to the registry (§5), a registered function name resolves to its
reference without `&`: `map(length, xs)` == `map(&length, xs)`. Use `&` when you
want to be explicit, and reserve it for the computed `&(expr)` form, which has no
bare equivalent. A lexical binding still wins over the registry, so a local named
`length` shadows the builtin in value position too.

---

## 5. Variables and property access

A bare identifier is a variable (`{"$var":"x"}`). Any access on it lowers to a
`$get`/`$from` chain rooted at that `$var`; access on a non-variable expression
lowers to a `$get`/`$from` chain rooted at that expression.

A bare identifier that is **not** a lexical binding but **is** a registered
function resolves to that function _reference_ (i.e. `&`-free; see §4). The
fallback only applies to a plain name: a name with a trailing path (`length.foo`)
that has no lexical binding is an error rather than resolving the reference and
then walking into it.

```jfn
x                         // {"$var":"x"}
a.b                       // {"$get":"b","$from":{"$var":"a"}}
a.b.c                     // {"$get":["b","c"],"$from":{"$var":"a"}}
a[0]                      // {"$get":0,"$from":{"$var":"a"}}
a[i]                      // {"$get":{"$var":"i"},"$from":{"$var":"a"}}
f(x).b                    // {"$get":"b","$from":{"$call":"f","$args":[{"$var":"x"}]}}
```

Lowering rules:

- Inside `[...]`, an **integer or quoted string** is a **static** key/index; a
  **bare identifier or any other expression** is a **computed** key.
- A run of consecutive **static** segments folds into one `$get` (a single
  string/number, or an array path for multiple): `a.b[0].c` →
  `{"$get":["b",0,"c"],"$from":{"$var":"a"}}`.
- A **computed** segment gets its own `$get`, wrapping the prior result as its
  `$from`: `a.b[i]` →
  `{"$get":{"$var":"i"},"$from":{"$get":"b","$from":{"$var":"a"}}}`.

Canonical JSON is always the `$get`/`$from` form. There is no `$var` + `$get`
pairing and no dotted `$var` path-string form: `$var` is a bare variable name,
and every property access is a `$get`/`$from` pair.

An access chain **in call position** is a method call: the chain evaluates to a
function value that is then applied (`caps.db.query(sql)`). See §4.

---

## 6. Operators and precedence

A closed set of operators. Precedence from highest to lowest:

| Prec | Operators             | Assoc   | Lowers to                                        |
| ---- | --------------------- | ------- | ------------------------------------------------ |
| 0    | `x!` (non-null)       | postfix | `{ "$nonnull": x }`                              |
| 1    | `!x` `-x` (unary)     | prefix  | `not(x)` · `neg(x)` (stdlib calls)               |
| 2    | `*` `/` `%`           | left    | `mul` · `div` · `mod` (stdlib calls)             |
| 3    | `+` `-` `++`          | left    | `add` · `sub` · `strcat` (stdlib calls)          |
| 4    | `== != < <= > >=`     | none    | `eq neq lt lte gt gte` (stdlib calls)            |
| 5    | `&&`                  | flatten | `$and` (short-circuit, variadic)                  |
| 6    | `\|\|`                | flatten | `$or` (short-circuit, variadic)                   |
| 7    | `expression as Type`  | none    | `{ "$as": expression, "$type": schema }`          |

```jfn
row * 8 + col
!done
x > 0 && x < 100
cached || compute(x)
balance + delta as Cents
```

```json
{ "$call": "add", "$args": [{ "$call": "mul", "$args": [{ "$var": "row" }, 8] }, { "$var": "col" }] }
{ "$call": "not", "$args": [{ "$var": "done" }] }
{ "$and": [{ "$call": "gt", "$args": [{ "$var": "x" }, 0] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }] }
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
{ "$as": { "$call": "add", "$args": [{ "$var": "balance" }, { "$var": "delta" }] }, "$type": { "$ref": "#/$defs/Cents" } }
```

Rules and rationale:

- **Arithmetic, `++`, comparisons, prefix `!`, and unary `-`** lower to
  **stdlib `$call` calls** (`add`, `strcat`, `eq`, `not`, `neg`, …).
  `&&`, `||`, postfix `!`, and checked `as` lower to dedicated language
  `$`-forms.
- `&&`/`||` **flatten**: `a && b && c` → one variadic `$and`. They map to the
  short-circuit language forms, **never** the eager stdlib `and`/`or` (call those
  by name: `and(a, b)`).
- Comparisons are **non-associative** (exactly two operands; no `a < b < c`).
  `==` is `eq`, which is **structural** (deep) equality — the only equality
  json-fn has; on scalars it is ordinary strict equality.
- Postfix `x!` is a runtime-checked non-null assertion. It removes `null` from
  the checker's inferred type, returns every non-null value unchanged, and
  raises an evaluation error on `null`.
- Checked `expression as Type` evaluates the expression once, validates the
  result against the type's runtime contract, and gives the expression that
  declared type. It binds less tightly than `||`, so `a + b as Cents` means
  `(a + b) as Cents`. It is non-associative; repeat checks as
  `(x as A) as B`. Postfix assertion still binds tightly (`x! as T`), while
  asserting an ascribed result requires parentheses (`(x as T)!`).
- Only operators with a single unambiguous meaning and universal precedence are
  elevated. Everything else stays a named call.
- The call form (`add(a, b)`) remains legal and parses identically, but the
  **operator form is canonical** on pretty-print.

### Template strings

Backtick strings with `${expr}` holes are sugar for string building. Literal
spans and hole expressions lower to a **flat variadic `strcat(...)`** — the same
node as `++`.

```jfn
`Illegal move: ${moveDesc}`
`${firstName} ${lastName}`
```

```json
{ "$call": "strcat", "$args": ["Illegal move: ", { "$var": "moveDesc" }] }
{ "$call": "strcat", "$args": [{ "$var": "firstName" }, " ", { "$var": "lastName" }] }
```

Rules:

- **Interpolation is strict — no coercion.** `${expr}` requires `expr` to be a
  string; wrap non-strings explicitly (`${str(n)}`), consistent with `strcat`.
- **Escaping:** `` \` `` for a literal backtick, `\${` for a literal
  dollar-brace, `\\` for a backslash. Other JSON escapes (`\n`, `\u2654`) apply
  inside literal spans.
- **Canonical printback:** a `strcat` node with any string-literal segment prints
  as a template; a node of pure expressions prints as `++`; `strcat(...)` stays
  legal input but is not canonical output.
- **Degenerate forms normalize:** `` `${x}` `` → `x` (single arg); `` `hello` ``
  (no holes) → `"hello"`.

---

## 7. Control flow

### `if / then / else` → `$if`

All three branches required; only the taken branch is evaluated.

```jfn
if x > 0 then "positive" else "non-positive"
```

```json
{ "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
```

### `cond { … }` → `$cond`

Ordered `condition -> result` arms. `else -> …` supplies the optional `$else`;
`true -> …` is an explicit catch-all arm inside the array. Only the matched
result (or `$else`) is evaluated.

```jfn
cond {
  n < 0  -> "negative",
  n == 0 -> "zero",
  else   -> "positive"
}
```

```json
{
  "$cond": [
    [{ "$call": "lt", "$args": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$call": "eq", "$args": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

### `match subject { … }` → `$match`

Like `cond`, but with a leading subject expression; case values must be scalars
compared by strict equality. `else -> …` is **required**.

```jfn
match cmd {
  "show"  -> showResult(state),
  "reset" -> resetResult(),
  else    -> moveResult(state, argv)
}
```

```json
{
  "$match": { "$var": "cmd" },
  "$cases": [
    ["show", { "$call": "showResult", "$args": [{ "$var": "state" }] }],
    ["reset", { "$call": "resetResult", "$args": [] }]
  ],
  "$else": { "$call": "moveResult", "$args": [{ "$var": "state" }, { "$var": "argv" }] }
}
```

Arms use `->` (never `=>`, which is reserved for function literals). `cond` is
distinguished from `match` purely by the absence of a subject after the keyword.

---

## 8. Function literals and local bindings

`(params) => body`. The body is a single expression, optionally followed by a
`where { … }` clause introducing **lazy local bindings**.

```jfn
(a, b) => add(a, b)
```

```json
{ "$params": ["a", "b"], "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] } }
```

### `body-expr where { name: value, … }`

The result expression comes first; the trailing `where { … }` clause supplies
the locals. Bindings use `:` (mirroring the JSON, where function locals are
literally key–value entries on the function-body object).

```jfn
(x, y) => doubled where {
  sum:     add(x, y),
  doubled: mul(sum, 2)
}
```

```json
{
  "$params": ["x", "y"],
  "sum": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] },
  "$return": { "$var": "doubled" }
}
```

**Semantics (important).** Bindings are **lazy** and **order-independent**: they
form a dependency graph resolved on demand, and a binding that is never reached
from `$return` is **never evaluated**. The `where` form is declarative, not a
sequence of steps. (E.g. a binding may hold an unconditionally-recursive call
that only terminates because it is forced solely in the branch that uses it.)
Placing the answer first and its supporting locals after mirrors how these
functions read: headline, then the details that back it up.

`where` is a lowest-precedence postfix clause on a **body**. Bodies occur at the
program top level, after `=>`, inside a parenthesized group, in a `where` binding
value, in a `cond`/`match` result arm, and in the body positions of `do`.
In a function body, the bindings lower directly into that function's scope.
In any other body, they lower to an immediately invoked zero-argument function:

```jfn
answer where { answer: 40 + 2 }
```

```json
{
  "$call": {
    "answer": { "$call": "add", "$args": [40, 2] },
    "$return": { "$var": "answer" }
  },
  "$args": []
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

### Parameters

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
complete recursive function-body scope, so they may reference earlier or later
parameters, other defaults, object-pattern fields, body locals, local
functions, and recursive definitions already visible to the body. This is
deliberately not JavaScript's left-to-right, call-entry default evaluation
despite the TypeScript-style surface spelling. A self-reference or dependency
cycle is permitted syntactically and fails at runtime only if evaluation forces
the cycle.

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

#### Object-pattern parameters

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
mirrors [shorthand-property punning](#data-objects--key-value): a destructured
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

### Closures & recursion

No special syntax. A nested function literal is a closure (outer variables are
captured by substitution when it is returned as a value). Functions call
themselves by registered name, or a local binding whose value is a function
literal can recurse by its local name.

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

## 9. Files and program shape

A `.jfn` file is **one json-fn expression**, and lowers to a single JSON value.
There is no file-level construct beyond "an expression."

A typical multi-function file is an **object mapping names to expressions** —
constants and function literals — as in `examples/chess.jsonc` and
`examples/life.jfn`. This object is the **outermost `letrec` scope**: top-level
names (constants _and_ functions) are visible via `$var` throughout the file,
and functions are callable via `$call`, with the same lazy, order-independent,
mutually-recursive semantics a function body gives its locals. The host supplies
the parent frame (stdlib + native builtins) and picks an entry point to invoke.

```jfn
{
  otherColor: (color) => if color == "w" then "b" else "w",
  pieceType:  (piece) => upper(piece)
}
```

```jfn
{
  otherColor: (color) => if color == "w" then "b" else "w",
  pieceType:  (piece) => upper(piece)
}
```

```json
{
  "otherColor": {
    "$params": ["color"],
    "$return": { "$if": { "$call": "eq", "$args": [{ "$var": "color" }, "w"] }, "$then": "b", "$else": "w" }
  },
  "pieceType": { "$params": ["piece"], "$return": { "$call": "upper", "$args": [{ "$var": "piece" }] } }
}
```

**How a file is consumed is a host concern**, unchanged from raw JSON: the host
may run the resulting object as a program — treating it as the outermost scope
over the stdlib registry and invoking a named entry point (as with `chess.jsonc`
and `life.jfn`) — or evaluate a file that is a bare expression down to a value.
See [`docs/host-integration.md`](./host-integration.md) for the entry-point
contract. The shorthand only guarantees the JSON it produces.

> **Future direction (not specified):** module-level `import` / `export` and a
> brace-less top-level declaration form (so a file reads as a list of
> definitions rather than one braced object) are possible supersets. They are
> intentionally out of scope here.

---

## 10. Grammar (informal EBNF)

```
program     := body

expr        := ascription
ascription  := orExpr ( "as" type )?                             // non-assoc
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := addExpr ( ("=="|"!="|"<"|"<="|">"|">=") addExpr )?   // non-assoc
addExpr     := mulExpr ( ("+"|"-"|"++") mulExpr )*
mulExpr     := unary ( ("*"|"/"|"%") unary )*
unary       := ("!"|"-") unary | postfix
postfix     := primary ( "." ident
                       | "[" (int | string) "]"      // static
                       | "[" expr "]"                // computed
                       | "(" args ")"
                       | "!" )*                      // non-null assertion
primary     := number | string | template | "true" | "false" | "null"
             | ident                                 // variable, or fn name if called
             | "&" ident | "&" "(" expr ")"          // function reference
             | "(" body ")"
             | funcLit
             | "[" (expr ("," expr)*)? "]"           // array
             | "{" (dataEntry ("," dataEntry)*)? "}" // data object
             | "if" expr "then" expr "else" expr
             | "cond" "{" arm ("," arm)* "}"
             | "match" expr "{" arm ("," arm)* "}"
             | "do" "{" doEntry ("," doEntry)* "}"   // effects (§13)
             | "handle" expr "with" "{" (dataEntry ("," dataEntry)*)? "}"  // §13
             | "raw" jsonValue

funcLit     := "(" params ")" "=>" body
body        := expr ( "where" "{" binding ("," binding)* "}" )?
binding     := ident ":" body
params      := ( param ("," param)* )?               // last may be "...ident"
param       := ident ( "?" | "=" expr )?
             | "..." ident                           // rest (last slot only)
             | objectPattern
objectPattern := "{" fieldBinding ("," fieldBinding)* ","? "}"
fieldBinding  := ident ( "?" | "=" expr )?
dataEntry   := (ident | string) ":" expr
             | ident                                 // punned: { x } == { x: x }
doEntry     := ident "<-" expr                       // effect binding (§13)
             | ident ":" body                        // pure (lazy-local) binding
             | body                                  // discard (non-final) / result (final)
arm         := (expr | "else") "->" body
template    := "`" ( char | "${" expr "}" )* "`"     // strict; no coercion
ident       := [A-Za-z_][A-Za-z0-9_]*
```

Required positional and object-pattern parameters precede all `?`/`=`
positional parameters; a rest parameter, when present, is final. These ordering
rules apply to `param` entries, not to `fieldBinding` entries within one
required object pattern.

Canonical printing uses newline-and-indent for `where`, `cond`, `match`, and long
argument/element lists; single-line for short forms. Parsers accept either.

---

## 11. Truthiness

Unchanged from the language: `0`, `""`, `null`, and `false` are falsy;
everything else is truthy. Used by `if`, `cond`, `match` (subject compare aside),
`&&`, `||`, `!`.

---

## 12. Open decisions (tracked)

- 🔴 **TODO(comments)** — §1: how `//` comments attach and lower to `$comment`,
  including group/section comments and comments on non-object targets.
- 🟡 **Printer polish for method/chained callees** — §4: the pretty-printer
  parenthesizes access-headed and call-headed callees (`(caps.db.query)(sql)`).
  Parsing and evaluation of the bare form already work and round-trip; only the
  canonical printback is deferred.

Everything else in this document is resolved and implementable.

---

## 13. Effects: `do` and `handle`

Two surface forms lower to the effects kernel (`perform` / `pure` / `bind` /
`handle`; see the [Tasks & Effects](./language.md#tasks--effects) section of the
language reference for the runtime semantics). Both are **parser-only sugar** —
they lower to ordinary `$call` calls, and the printer folds those exact shapes
back.

`do` and `handle` are **contextual keywords**: in primary position they
introduce these forms, so — unlike ordinary identifiers — they can no longer be
used as bare variable or call names there (a breaking change, alongside
`if`/`cond`/`match`/`raw`). A property key or a `.field` access named `do`/`handle`
is unaffected.

### `do { … }` — sequencing effects

A `do` block is a comma-separated list of entries; each is one of:

- **effect binding** — `name <- expr`: run the task `expr`, bind its result to
  `name` for the rest of the block;
- **pure binding** — `name : expr`: a lazy local (like a `where` binding; the
  value parses as a `body`, so a trailing `where` works);
- **bare expression** — a *discard* if non-final (run for its effect, result
  dropped, like Haskell's `e >> rest`), or the block's **result** if final.

A `do` block **must end with a result expression**, never a binding.

Desugar: each effect binding and each discard starts a nested `bind(expr, k)`.
The continuation `k` binds the effect result to `name` (effect binding) or takes
**no parameter** (discard — a distinct JSON shape from `_ <- expr`, which binds
`_`, so both surface forms round-trip). Pure bindings since the previous
effect/discard attach as `k`'s `where`-locals; pure bindings *before* the first
effect wrap the whole chain in a zero-arg IIFE, exactly like expression-level
`where`.

```jfn
do {
  name <- readLine(),
  upper: upper(name),
  print(upper),
  pure(upper)
}
```

```json
{
  "$call": "bind",
  "$args": [
    { "$call": "readLine", "$args": [] },
    {
      "$params": ["name"],
      "upper": { "$call": "upper", "$args": [{ "$var": "name" }] },
      "$return": {
        "$call": "bind",
        "$args": [
          { "$call": "print", "$args": [{ "$var": "upper" }] },
          { "$return": { "$call": "pure", "$args": [{ "$var": "upper" }] } }
        ]
      }
    }
  ]
}
```

#### The `<-` adjacency rule

`<-` is **not a lexer token** — tokenizing it as one would break `x < -1`.
Instead, only in do-binding position, the parser recognizes a `<` token
immediately followed by an **adjacent** `-` token (same line, next column).
Everywhere else `< -` is an ordinary comparison against a negated operand, so a
`do` result like `r < -1` is unaffected.

### `handle … (-> Type)? with { … }` — in-language effect interpreter

`handle <task> with { "name": clause, … }` lowers to
`handle(task, { …clauses… })`. The clause record follows **data-object key
rules** (§3), so dotted effect names (`io.readLine`), the `"*"` wildcard, and the
`"return"` clause must be quoted. Clause semantics — named clauses, `"*"`,
`"return"`, bubbling, and multi-shot `resume` — are specified in the language
reference.

The total annotated form `handle <task> -> <type> with { … }` lowers the type
schema as a raw third argument:
`handle(task, { …clauses… }, raw(<result-schema>))`. The annotation precedes
`with` so the grammar remains distinct from a `cond` arm whose guard happens to
be an unannotated `handle` expression.

```jfn
handle greet(io) with {
  "io.readLine": (resume) => resume("world"),
  "io.print":    (msg, resume) => resume(null)
}
```

```json
{
  "$call": "handle",
  "$args": [
    { "$call": "greet", "$args": [{ "$var": "io" }] },
    {
      "io.readLine": { "$params": ["resume"], "$return": { "$call": "resume", "$args": ["world"] } },
      "io.print": { "$params": ["msg", "resume"], "$return": { "$call": "resume", "$args": [null] } }
    }
  ]
}
```

### Canonical printback

The printer folds **only exact desugar images**, preserving the
bijective-by-normal-form guarantee (`parse(print(x)) === x`): a `bind` call whose
continuation is a function literal prints as `do { … }` (folding nested binds and
their where-locals back into `<-` / `:` / discard entries), and a `handle` call
with a literal clause object prints as `handle … with { … }`; a third
`raw(schema)` argument prints as `handle … -> Type with { … }`. Any other
shape — e.g. a `bind` with a `&`-referenced continuation, or a `handle` whose
clauses are a computed expression — prints as a plain call.
