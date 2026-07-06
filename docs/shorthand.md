# json-fn Shorthand (`.jfn`)

A compact surface syntax for authoring json-fn programs. The **canonical form is
still JSON** — the interpreter only ever sees JSON. Shorthand is a purely
syntactic layer that **lowers deterministically to canonical json-fn JSON**, and
canonical JSON **pretty-prints back to shorthand**. The two are a bijection: one
shorthand per JSON node, one JSON node per shorthand form, with a canonical
normal form on each side.

Design goals, in priority order:

1. **Semantics-preserving.** Shorthand is correct only if it lowers to *exactly*
   the JSON you would have hand-written — including subtle distinctions like
   short-circuit forms vs. stdlib functions, and strict vs. structural equality.
2. **Cheap to write.** Code-first: identifiers and calls are code by default;
   literal strings are quoted; literal data is escaped explicitly.
3. **Low ambiguity.** A small, closed set of operators with a fixed precedence
   ladder. No arithmetic infix, no open-ended operator grammar. Any residual
   ambiguity is a design-time error, not a runtime surprise.

See [`docs/language.md`](./language.md) for the language being encoded.

---

## 1. Overview: the three "states"

json-fn values live in one of three states. Shorthand makes the boundary between
them explicit:

| State                        | json-fn                                   | shorthand signal        |
| ---------------------------- | ----------------------------------------- | ----------------------- |
| Evaluated expression         | `{"$fn": [...]}`, `{"$var": ...}`, forms  | bare code (the default) |
| Plain data, values evaluated | array / plain object (keys literal)       | `[...]` / `{k: v}`      |
| Fully inert (verbatim)       | `{"$literal": ...}`                        | `raw ...`               |

Everything below is written **shorthand → JSON**.

---

## 2. Literals

Numbers, booleans, and `null` are written as in JSON. Strings are
double-quoted — **quoting is the sole signal for a literal string**.

```jfn
42            "hello"           true            null
```

```json
42            "hello"           true            null
```

Because we are code-first, an unquoted word is **never** a string; it is a
variable (§4) or, in call position, a function name (§3).

### Arrays and data objects

`[...]` is an array; `{k: v}` is a plain object. In both, **values are code**
(evaluated recursively) and **object keys are literal data** (never evaluated),
matching json-fn's rules.

```jfn
[1, add(2, 3)]

{ name: "ada", score: add(1, 2) }
```

```json
[1, { "$fn": ["add", 2, 3] }]

{ "name": "ada", "score": { "$fn": ["add", 1, 2] } }
```

Object keys may be bare when identifier-like, else quoted: `{ "person.name": 1 }`.

**Keys beginning with `$` are forbidden in a data object** — they would collide
with a magic key on lowering. Use `raw` (§8) to produce literal data that
contains `$`-prefixed keys.

---

## 3. Function calls and references

Applicative syntax. In **call position**, a bare identifier is a literal
function *name*; a parenthesized expression is an *evaluated* callee (dynamic
dispatch or an inline body).

```jfn
add(3, 4)                    // named call
f()                          // zero-arg call
(fnName)(3, 4)               // dynamic dispatch — callee is an expression
((x) => mul(x, x))(5)        // inline anonymous callee
```

```json
{ "$fn": ["add", 3, 4] }
{ "$fn": ["f"] }
{ "$fn": [{ "$var": "fnName" }, 3, 4] }
{ "$fn": [{ "$params": ["x"], "$return": { "$fn": ["mul", { "$var": "x" }, { "$var": "x" }] } }, 5] }
```

### Function reference — `&name`

Passing a function *as a value* (json-fn's non-array `$fn`) uses the `&` sigil.
This is distinct from a zero-arg call and from a bare variable.

```jfn
&double
map(&double, nums)
```

```json
{ "$fn": "double" }
{ "$fn": ["map", { "$fn": "double" }, { "$var": "nums" }] }
```

---

## 4. Variables and property access

A bare identifier is a variable reference. Static paths reuse json-fn's existing
`$var` path DSL verbatim.

```jfn
x
person.name
items[0]
data.people[0].name
```

```json
{ "$var": "x" }
{ "$var": "person.name" }
{ "$var": "items[0]" }
{ "$var": "data.people[0].name" }
```

Inside `[...]`, an **integer or quoted string is a static path segment**; a
**bare identifier or any other expression is a computed key** and lowers to
`$get`. So `items[0]` and `items["k"]` are static, while `items[i]` is computed.

```jfn
data[fieldName]              // computed key (variable)
person["name"]               // == person.name (static)
```

```json
{ "$var": "data", "$get": { "$var": "fieldName" } }
{ "$var": "person.name" }
```

Property access on a **non-variable expression** lowers to `$get` / `$from`:

```jfn
concat([10], [20])[0]
score().total
lookup()[key]
```

```json
{ "$get": 0, "$from": { "$fn": ["concat", [10], [20]] } }
{ "$get": "total", "$from": { "$fn": ["score"] } }
{ "$get": { "$var": "key" }, "$from": { "$fn": ["lookup"] } }
```

Canonical rule: when the base is a bare variable and the access is fully static,
the printer prefers the compact `$var` path string; otherwise it uses
`$get`/`$from`.

Variable names must not contain `.` or `[` (unchanged from the language).

---

## 5. Operators

A **closed set** of infix/prefix operators with a **fixed precedence ladder**
(highest to lowest). Comparisons are non-associative (exactly two operands, no
chaining). Parenthesize to override.

| Prec | Operators                    | Lowers to                          |
| ---- | ---------------------------- | ---------------------------------- |
| 1    | `!x` (prefix)                | `$not`                             |
| 2    | `== != < <= > >=`            | `$eq $neq $lt $lte $gt $gte`       |
| 3    | `&&`                         | `$and` (short-circuit, variadic)   |
| 4    | `\|\|`                       | `$or` (short-circuit, variadic)    |

```jfn
!done
x == "playing"
score >= 10
x > 0 && x < 100
cached || compute(x)
```

```json
{ "$not": { "$var": "done" } }
{ "$eq": [{ "$var": "x" }, "playing"] }
{ "$gte": [{ "$var": "score" }, 10] }
{ "$and": [{ "$gt": [{ "$var": "x" }, 0] }, { "$lt": [{ "$var": "x" }, 100] }] }
{ "$or": [{ "$var": "cached" }, { "$fn": ["compute", { "$var": "x" }] }] }
```

Deliberate exclusions and mappings (see §"design conclusions"):

- **No arithmetic infix.** `+ - * /` are ordinary stdlib calls: `add(a, b)`,
  `mul(a, b)`, `neg(x)`. This avoids a precedence table for functions that have
  no special-form status.
- **`&&` / `||` are the language short-circuit forms `$and` / `$or`**, never the
  stdlib `and` / `or` (which evaluate all operands). To get the stdlib functions,
  call them: `and(a, b)`.
- **`==` is `$eq` (strict)**, not structural. For structural equality call
  `jsonEq(a, b)`.
- `a && b && c` **flattens** to a single variadic `{"$and": [a, b, c]}`.

---

## 6. Control flow

### `if / then / else` → `$if`

All three branches required. Only the taken branch is evaluated.

```jfn
if x > 0 then "positive" else "non-positive"
```

```json
{ "$if": { "$gt": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
```

### `cond { ... }` → `$cond`

Ordered `condition => result` arms. `else =>` supplies the optional `$else`;
`true =>` is an explicit catch-all arm inside the array.

```jfn
cond {
  n < 0  => "negative",
  n == 0 => "zero",
  else   => "positive"
}
```

```json
{
  "$cond": [
    [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$eq": [{ "$var": "n" }, 0] }, "zero"]
  ],
  "$else": "positive"
}
```

### `match subject { ... }` → `$match`

Like `cond` but with a leading subject expression; case values are scalars
compared by strict equality. `else =>` is **required**.

```jfn
match cmd {
  "show"  => showResult(state),
  "reset" => resetResult(),
  "help"  => helpResult(),
  else    => moveResult(state, argv)
}
```

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

(`cond` is distinguished from `match` purely by the absence of a subject after
the keyword.)

---

## 7. Function literals

`(params) => body`. The body is either a single expression (→ `$return`
directly) or a `{ ... }` block of **lazy local bindings** plus a `return`.

Bindings use `=` (distinguishing a function block from a `:`-based data object);
the block is **declarative, not imperative** — bindings are order-independent,
lazy locals that form a dependency graph, exactly as in the language.

```jfn
(a, b) => add(a, b)

(x, y) => {
  sum     = add(x, y),
  doubled = mul(sum, 2),
  return doubled
}
```

```json
{ "$params": ["a", "b"], "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] } }

{
  "$params": ["x", "y"],
  "sum": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$fn": ["mul", { "$var": "sum" }, 2] },
  "$return": { "$var": "doubled" }
}
```

- **Rest params**: `(first, ...rest) => ...`.
- **No params**: `() => ...` lowers to a body with **no `$params` key** (the
  canonical no-args body; `$params: []` normalizes to this).
- **Closures** need no special syntax — a returned function literal is just a
  nested `(params) => ...`.

```jfn
(x) => (y) => add(x, y)
```

```json
{
  "$params": ["x"],
  "$return": { "$params": ["y"], "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] } }
}
```

---

## 8. Escaping literal data — `raw`

`raw` introduces a **verbatim JSON island** — the body is parsed as literal JSON
and nothing inside is evaluated. It lowers to `$literal`. Use it for hot-path
constants and for data that contains `$`-prefixed keys.

```jfn
raw [[0, 1, 2], [3, 4, 5], [6, 7, 8]]

raw { "$fn": ["not", "code"], "$var": "data" }
```

```json
{ "$literal": [[0, 1, 2], [3, 4, 5], [6, 7, 8]] }

{ "$literal": { "$fn": ["not", "code"], "$var": "data" } }
```

---

## 9. Comments — `//` → `$comment`

A `//` line comment lowers to a `$comment` sibling on the expression it
immediately precedes (so it **round-trips** through JSON, unlike JSONC comments,
which would be lost). The comment string must be attachable to a form; comments
on positions that cannot hold `$comment` are a lowering error.

```jfn
// classify a number by sign
(n) => cond {
  n < 0  => "negative",
  n == 0 => "zero",
  else   => "positive"
}
```

```json
{
  "$comment": "classify a number by sign",
  "$params": ["n"],
  "$return": {
    "$cond": [
      [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
      [{ "$eq": [{ "$var": "n" }, 0] }, "zero"]
    ],
    "$else": "positive"
  }
}
```

---

## 10. Worked example — pipeline

```jfn
() => {
  nums    = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  evens   = filter(&isEven, nums),
  doubled = map(&double, evens),
  return reduce(&add, 0, doubled)
}
```

```json
{
  "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "evens": { "$fn": ["filter", { "$fn": "isEven" }, { "$var": "nums" }] },
  "doubled": { "$fn": ["map", { "$fn": "double" }, { "$var": "evens" }] },
  "$return": { "$fn": ["reduce", { "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

---

## 11. Grammar sketch (informal)

```
expr        := orExpr
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := unary ( ("=="|"!="|"<"|"<="|">"|">=") unary )?   // non-assoc, at most one
unary       := "!" unary | postfix
postfix     := primary ( "." ident | "[" (int|string) "]" | "[" expr "]" | "(" args ")" )*
primary     := number | string | "true" | "false" | "null"
             | ident                              // variable, or fn name in call position
             | "&" ident                          // function reference
             | "(" expr ")"
             | "(" params ")" "=>" body           // function literal
             | "[" (expr ("," expr)*)? "]"        // array
             | "{" (dataEntry ("," dataEntry)*)? "}"   // data object (colon entries)
             | "if" expr "then" expr "else" expr
             | "cond" "{" arm ("," arm)* "}"
             | "match" expr "{" arm ("," arm)* "}"
             | "raw" jsonValue
body        := expr | "{" (binding ",")* "return" expr "}"
binding     := ident "=" expr
dataEntry   := (ident|string) ":" expr
arm         := (expr | "else") "=>" expr
params      := (ident ("," ident)*)?              // last may be "...rest"
ident       := [A-Za-z_][A-Za-z0-9_]*
```

Whitespace is insignificant except as a token separator. The canonical printer
uses newline-and-indent for blocks/`cond`/`match` and single-line for short
forms; parsers accept either.

---

## 12. Design conclusions (why the syntax is shaped this way)

- **Code-first polarity** for token density; quoting is the one and only
  literal-string marker.
- **Function name vs. variable vs. reference** are three distinct surfaces:
  bare-in-call-position (name), bare-elsewhere (variable), `&name` (reference).
- **Static vs. computed access** is decided inside `[...]`: literals are path
  segments, expressions are `$get`.
- **A closed operator set with fixed precedence** — comparisons, `&&`/`||`, `!` —
  each mapping to exactly one language form. No arithmetic infix, no general
  precedence grammar, so the semantic "twins" (`$and` vs `and`, `$eq` vs
  `jsonEq`) can never be selected by accident.
- **Declarative function blocks** (`=` bindings) preserve lazy, order-independent
  locals; imperative reading is explicitly not implied.
- **`raw` / `$literal`** is the single escape hatch across the expression↔data
  boundary.
- **Bijection** (JSON ↔ shorthand) is the correctness forcing function: it lets
  every existing program render into shorthand and turns ambiguity into a
  design-time error.

### Still open (normalization only, not semantics)

- Exact **comment attachment** rules when multiple comments cluster around one
  node, and whether trailing (`expr // note`) comments are supported.
- Whether the canonical printer's **line-wrapping thresholds** are part of the
  normal form or advisory.
