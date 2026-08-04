# json-fn Shorthand Specification

A compact, code-first surface syntax for authoring json-fn programs. The
**canonical form is JSON** — the interpreter only ever sees JSON. Shorthand
lowers deterministically to canonical json-fn JSON, and canonical JSON
pretty-prints back to shorthand.

- **Semantics-preserving.** Shorthand is correct only if it lowers to exactly
  the JSON you would have hand-written.
- **Code-first.** Identifiers and calls are code by default; literal strings are
  quoted; quoted data needs no keyword — the parser infers the canonical `$raw`
  boundary from static JSON (§3).
- **Bijective (by normal form).** One canonical shorthand per normalized JSON
  node and vice versa: `parse(print(node)) = normalize(node)`. Byte-exact
  round-tripping of arbitrary hand-written JSON is _not_ guaranteed — JSON is
  normalized to canonical form first (e.g. property-access spellings, see §5;
  redundant `$raw` wrappers, see §3).

File extension: `.jfn`.

---

## 1. Lexical structure

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`. Used for variables, function names
  (in call position), parameters, and local names. Must not contain `.` or `[`.
- **Numbers / booleans / null:** as in JSON (`42`, `-3.5`, `true`, `false`,
  `null`). A leading `-` on a numeric token is part of the literal.
- **Strings:** double-quoted, with JSON escape rules (`"\n"`, `"\u2654"`,
  `"\""`). Quoting is the **sole** signal for a literal string.
- **Whitespace** is insignificant inside expressions except as a token
  separator. A physical line break separates complete top-level module
  declarations. Elements in arrays, objects, argument lists, and blocks are
  comma-separated.
- **Comments:** `// …` to end of line and non-nested `/* … */` block comments.
  Both are currently discarded as trivia. 🔴 **TODO(comments):** attachment
  rules (which node a comment lowers to as `$comment`, group/section comments,
  comments on non-object targets) are deferred and unspecified.

---

## 2. Expressions overview

Every construct is an expression. Three value "states" from the language are
made explicit in the surface syntax:

| State                          | Surface                                       | JSON                   |
| ------------------------------ | --------------------------------------------- | ---------------------- |
| Evaluated expression           | bare code                                     | `$call` / `$fn` / `$var` / forms |
| Plain data (values evaluated)  | `[...]` / `{k: v}`                            | array / object         |
| Inert (verbatim, un-evaluated) | static JSON with quoted `$`-keys — _inferred_ | `{ "$raw": <json> }`   |

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

**Bare `$`-prefixed keys are forbidden** in a data object (they would collide
with a magic key on lowering). A **quoted** `$`-prefixed key is accepted only
when the whole containing literal is static JSON data; the parser then quotes
the maximal static literal under a canonical `$raw` boundary (see "Quoted
data" below). To give a dynamic object a literal `$`-prefixed key, use a
computed key: `{ ["$status"]: status }`.

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

### Quoted data — inferred `$raw`

There is no quoting keyword. Ordinary static JSON is already a value and lowers
to itself; when a static literal contains a **quoted `$`-prefixed key** — which
would otherwise collide with the canonical encoding — the parser quotes the
**maximal static literal** around it under a canonical `$raw` boundary: a
verbatim JSON island in which nothing is evaluated.

```jfn
{ "$var": "this is data" }

{ envelope: { payload: { "$call": "not code", "$args": [] } } }
```

```json
{ "$raw": { "$var": "this is data" } }

{ "$raw": { "envelope": { "payload": { "$call": "not code", "$args": [] } } } }
```

A literal is **static** when it is a scalar, an array literal whose elements
are all static (no spread), or a data-object literal whose values are all
static (no spread or computed entry). Calls, variables, function references
and literals, conditionals, ascriptions, and templates that lower to
concatenation are dynamic. Grouping parentheses and a degenerate single-hole
template are transparent: the literal inside keeps its provenance. When the
parent is dynamic, only the maximal static child is quoted:

```jfn
{ receivedAt, payload: { "$call": "not code", "$args": [] } }
```

```json
{
  "receivedAt": { "$var": "receivedAt" },
  "payload": { "$raw": { "$call": "not code", "$args": [] } }
}
```

A quoted `$`-key inside a **dynamic** literal is rejected — `{ "$status": status }`
is an error, because it cannot be a JSON value (its value is an expression)
and it would collide with reserved syntax as a canonical object. Use a
computed key (`{ ["$status"]: status }`) there instead. A literal `$comment`
entry follows the same rule, which is how a `$comment` key is preserved as
data (`{ "$comment": "note", a: 1 }` quotes; plain literal syntax strips
`$comment`).

Quotation is a semantic boundary, not a performance hint: plain constant data
(e.g. `[1, 2, 3]`) stays plain canonical JSON, and quoting does not change
deterministic fuel — a `$raw` payload charges the same cost as evaluating the
equivalent plain constant literal (see
[Execution limits](../../runtime/execution-limits.md)).

Printing mirrors inference: a generic `$raw` payload prints as ordinary strict
JSON, redundant wrappers (around scalars and collision-free static JSON)
normalize away, and boundaries re-hoist to the maximal static literal on
reparse — the round-trip contract is `parse(print(node)) = normalize(node)`.
Wrappers that a boundary genuinely protects (expression-shaped or reserved-key
payloads, literal `$comment` entries, generated code embedded as data, and the
annotated-`handle` result schema, §13) are always retained.

Module bindings and `handle` clause records are explicit no-inference
contexts: a module root stays a module and an empty clause record stays a
handler record. `raw` is an ordinary identifier, not a keyword.

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
this is a checker limitation, not a new canonical JSON form. Because `any`
does not prove assignability to a concrete return type, use a checked
ascription (`f(...args) checked as T`) when the runtime boundary is intentional. Use
`--require-full-coverage` when the remaining spread-call imprecision must also
be rejected.

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
| 4    | `== != < <= > >=`     | ordered chain | `eq neq lt lte gt gte` (stdlib calls)       |
| 5    | `&&`                  | flatten | `$and` (short-circuit, variadic)                  |
| 6    | `\|\|`                | flatten | `$or` (short-circuit, variadic)                   |
| 7    | `expression checked as Type` | none | `{ "$as": expression, "$type": schema }`       |

```jfn
row * 8 + col
!done
x > 0 && x < 100
0 <= x < 100
cached || compute(x)
balance + delta checked as Cents
```

```json
{ "$call": "add", "$args": [{ "$call": "mul", "$args": [{ "$var": "row" }, 8] }, { "$var": "col" }] }
{ "$call": "not", "$args": [{ "$var": "done" }] }
{ "$and": [{ "$call": "gt", "$args": [{ "$var": "x" }, 0] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }] }
{ "$and": [{ "$call": "lte", "$args": [0, { "$var": "x" }] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }] }
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
{ "$as": { "$call": "add", "$args": [{ "$var": "balance" }, { "$var": "delta" }] }, "$type": { "$ref": "#/$defs/Cents" } }
```

Rules and rationale:

- **Arithmetic, `++`, comparisons, prefix `!`, and unary `-`** lower to
  **stdlib `$call` calls** (`add`, `strcat`, `eq`, `not`, `neg`, …).
  `&&`, `||`, postfix `!`, and `checked as` lower to dedicated language
  `$`-forms.
- `&&`/`||` **flatten**: `a && b && c` → one variadic `$and`. They map to the
  short-circuit language forms, **never** the eager stdlib `and`/`or` (call those
  by name: `and(a, b)`).
- Ordered comparisons may be chained: `a < b <= c` means
  `a < b && b <= c`. Mixed ordered operators are allowed. Equality operators
  cannot participate in a chain: `a == b < c` and `a < b != c` are errors.
  `==` is `eq`, which is **structural** (deep) equality — the only equality
  json-fn has; on scalars it is ordinary strict equality.
- Chained operands evaluate from left to right, at most once, and stop after
  the first false comparison. Primitive literals and plain variable reads can
  be repeated in the canonical `$and`. Every nontrivial interior operand is
  instead stored in a hygienic, lazy `$let` binding, whose memoized value is
  used by both adjacent comparisons. For example, `0 < value() < 10` lowers to
  the equivalent of `tmp > 0 && tmp < 10 where { tmp: value() }`; the synthetic
  binding name is an implementation detail, and the printer reconstructs the
  chained surface form.
- Postfix `x!` is a runtime-checked non-null assertion. It removes `null` from
  the checker's inferred type, returns every non-null value unchanged, and
  raises an evaluation error on `null`.
- `expression checked as Type` evaluates the expression once, validates the
  result against the type's runtime contract, and gives the expression that
  declared type. It binds less tightly than `||`, so
  `a + b checked as Cents` means `(a + b) checked as Cents`. It is
  non-associative; repeat checks as `(x checked as A) checked as B`. Postfix
  assertion still binds tightly (`x! checked as T`), while asserting an
  ascribed result requires parentheses (`(x checked as T)!`). `checked` remains
  an ordinary identifier outside this two-token operator position:
  `checked(value)` is a call, while ascribing a variable with that name is
  written `(checked) checked as T`.
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

Ordered `condition: result` arms. `else: …` supplies the optional `$else`;
`true: …` is an explicit catch-all arm inside the array. Only the matched
result (or `$else`) is evaluated.

```jfn
cond {
  n < 0:  "negative",
  n == 0: "zero",
  else:   "positive"
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
compared by strict equality. `else: …` is **required**.

```jfn
match cmd {
  "show":  showResult(state),
  "reset": resetResult(),
  else:    moveResult(state, argv)
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

The surrounding control-flow form distinguishes arm colons from colons in
nested object expressions. `cond` is distinguished from `match` purely by the
absence of a subject after the keyword.

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

## 9. Files and program shape

A `.jfn` file is an **implicit module**: a newline-separated sequence of named
bindings and type declarations without surrounding braces. It lowers to one
canonical JSON object mapping names to expressions. A declaration may span
multiple lines; a line break is a module separator only after its expression or
type is complete. Top-level commas are not accepted, and two declarations
cannot share a line. Commas remain required in nested comma-separated syntax.

This object is a distinct persistent module registry, not a function body or a
`$let` encoding. Top-level names (constants _and_ functions) are visible via
`$var` throughout the file, and literal functions are callable via `$call`.
Constants are lazy, memoized, order-independent, mutually recursive, and
cycle-checked. Module functions remain registry-backed for the whole program
and are not copied into escaping closures. The host supplies the parent
registry (stdlib + native builtins) and picks an entry point to invoke.

```jfn
otherColor: (color) => if color == "w" then "b" else "w"
pieceType:  (piece) => upper(piece)
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

**How a module is consumed is a host concern**, unchanged from canonical JSON: the
host treats the resulting object as the outermost scope over the stdlib
registry and chooses a named entry point (as with `pipeline.jfn` and
`dungeon.jfn`). Standalone expressions are a separate parser/CLI mode and are
not `.jfn` file syntax.
See [Environment contract](../../deployment/environment-contract.md) for portable entry linking
and [Durable task hosting](../../runtime/durable-host.md) for persistent execution.
The shorthand only guarantees the JSON it produces.

> **Future direction (not specified):** module-level `import` / `export` may
> extend this file-level module syntax.

---

## 10. Grammar (informal EBNF)

```
program     := (moduleEntry (moduleSep moduleEntry)*)?
moduleSep   := physical line break after a complete moduleEntry
moduleEntry := "type" ident "=" type
             | dataEntry

// Used only by an explicit standalone-expression parser mode.
expressionInput := body

expr        := ascription
ascription  := orExpr ( "checked" "as" type )?                   // non-assoc
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := addExpr ( ("=="|"!="|"<"|"<="|">"|">=") addExpr )*
               // Multiple operators must all be ordered: < <= > >=
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
             | "handle" expr ( "returns" type )? "with"
                        "{" (dataEntry ("," dataEntry)*)? "}"     // §13

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
arm         := (expr | "else") ":" body
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
`handle`; see the [Tasks & Effects](../json/tasks-and-effects.md) section of the
language reference for the runtime semantics). Both are **parser-only sugar**.
`handle` lowers to a call, while `do` lowers to a `bind` call spine plus
canonical `$let` nodes for pure bindings. The printer folds those exact shapes
back.

`do` and `handle` are **contextual keywords**: in primary position they
introduce these forms, so — unlike ordinary identifiers — they can no longer be
used as bare variable or call names there (a breaking change, alongside
`if`/`cond`/`match`). A property key or a `.field` access named `do`/`handle`
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
effect/discard wrap the continuation's `$return` in `$let`; pure bindings
*before* the first effect wrap the whole bind chain in `$let`. No synthetic
zero-argument call is introduced.

Because each consecutive pure run forms one `$let`, its binding names must be
unique. A later run after an effect or discard is a nested scope and may shadow
an earlier name.

Within one consecutive run, pure bindings have exactly the same semantics as a
`where` binding group: they are lazy, memoized, order-independent, and mutually
recursive. A run after an effect may refer to results bound by that effect or
any preceding effect. By contrast, a `where` attached to the complete `do`
expression is outside the generated continuations and cannot refer to their
effect-bound names. Finally, `name: taskExpr` only binds the task value; it does
not run the task. Use `name <- taskExpr` to sequence it and bind its result.

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
      "$return": {
        "$let": {
          "upper": { "$call": "upper", "$args": [{ "$var": "name" }] }
        },
        "$in": {
          "$call": "bind",
          "$args": [
            { "$call": "print", "$args": [{ "$var": "upper" }] },
            { "$return": { "$call": "pure", "$args": [{ "$var": "upper" }] } }
          ]
        }
      }
    }
  ]
}
```

Leading pure bindings use the same canonical form around the complete bind
spine:

```jfn
do {
  prefix: "hello ",
  name <- readLine(),
  pure(prefix ++ name)
}
```

```json
{
  "$let": {
    "prefix": "hello "
  },
  "$in": {
    "$call": "bind",
    "$args": [
      { "$call": "readLine", "$args": [] },
      {
        "$params": ["name"],
        "$return": {
          "$call": "pure",
          "$args": [
            { "$call": "strcat", "$args": [{ "$var": "prefix" }, { "$var": "name" }] }
          ]
        }
      }
    ]
  }
}
```

#### The `<-` adjacency rule

`<-` is **not a lexer token** — tokenizing it as one would break `x < -1`.
Instead, only in do-binding position, the parser recognizes a `<` token
immediately followed by an **adjacent** `-` token (same line, next column).
Everywhere else `< -` is an ordinary comparison against a negated operand, so a
`do` result like `r < -1` is unaffected.

### `handle … (returns Type)? with { … }` — in-language effect interpreter

`handle <task> with { "name": clause, … }` lowers to
`handle(task, { …clauses… })`. The clause record follows **data-object key
rules** (§3), so dotted effect names (`io.readLine`), the `"*"` wildcard, and the
`"return"` clause must be quoted. Clause semantics — named clauses, `"*"`,
`"return"`, bubbling, and multi-shot `resume` — are specified in the language
reference.

The total annotated form `handle <task> returns <type> with { … }` lowers the type
schema as a `$raw`-quoted third argument:
`handle(task, { …clauses… }, { "$raw": <result-schema> })`. The annotation precedes
`with` and names the handler's immediate result contract explicitly. `returns`
is contextual: `handle returns with { … }` still handles a task variable named
`returns`. An ascribed task operand must be parenthesized so `returns` can
terminate the header operand:
`handle (task checked as Task<Result>) returns Report with { … }`.

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
bijective-by-normal-form guarantee (`parse(print(x)) = normalize(x)`, and exact
identity for these already-normal forms): a `bind` call whose
continuation is a structural function literal prints as `do { … }`. A leading
`$let` around the bind spine reconstructs leading pure entries; a `$let` in a
continuation's `$return` reconstructs the consecutive pure entries after that
effect/discard. A `handle` call with a literal clause object prints as
`handle … with { … }`; a third `$raw` schema argument prints as
`handle … returns Type with { … }`. Any other shape—e.g. a `bind` with an
`&`-referenced continuation, or a `handle` whose clauses are a computed
expression—prints as a plain call.
