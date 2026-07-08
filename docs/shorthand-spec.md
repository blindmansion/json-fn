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
- **Comments:** `// …` to end of line. 🔴 **TODO(comments):** attachment rules
  (which node a comment lowers to as `$comment`, group/section comments,
  comments on non-object targets) are deferred and unspecified.

---

## 2. Expressions overview

Every construct is an expression. Three value "states" from the language are
made explicit in the surface syntax:

| State                          | Surface            | JSON                   |
| ------------------------------ | ------------------ | ---------------------- |
| Evaluated expression           | bare code          | `$fn` / `$var` / forms |
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
[1, { "$fn": ["add", 2, 3] }]
```

### Data objects — `{ key: value }`

**Values are evaluated; keys are literal data** (never evaluated). Keys may be
bare identifiers or quoted strings.

```jfn
{ name: "ada", score: x + 1 }
```

```json
{ "name": "ada", "score": { "$fn": ["add", { "$var": "x" }, 1] } }
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

### Inert data — `raw`

`raw` introduces a **verbatim JSON island**; nothing inside is evaluated. It
lowers to `$raw`. The body is **strict JSON** (quoted keys, no shorthand).

```jfn
raw [[-2, -1], [-2, 1], [-1, -2]]

raw { "$fn": ["not", "x"] }
```

```json
{ "$raw": [[-2, -1], [-2, 1], [-1, -2]] }

{ "$raw": { "$fn": ["not", "x"] } }
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
{ "$fn": ["add", 3, 4] }
{ "$fn": ["f"] }
{ "$fn": [{ "$var": "fnName" }, 3, 4] }
{ "$fn": [{ "$params": ["x"], "$return": { "$fn": ["mul", { "$var": "x" }, { "$var": "x" }] } }, 5] }
```

### Method calls and chained application

The callee slot is a full postfix expression, so anything that produces a
function value can sit in call position. In particular, a **property-access
chain** or a **preceding call** in call position is an evaluated callee — the
access/call is performed first and its result is applied. This is the
"method-call" surface: it dispatches through a record of closures (the pattern
capabilities use — see `plans/effects-implementation.md`), with no distinct
`$` form. A bare name is still the only thing that means a literal function
_name_ (`f(x)` → `{ "$fn": ["f", …] }`); the moment a `.`, `[…]`, or a prior
`(…)` intervenes, the callee is evaluated.

```jfn
caps.db.query(sql)        // call the closure held at caps.db.query
io.readLine()             // zero-arg method call
caps[name](x)             // computed-key dispatch
f(x).method(y)            // method on a call result (callee uses $get/$from)
makeCountdown(42)(3)      // chained application (call the returned closure)
```

```json
{ "$fn": [{ "$var": "caps", "$get": ["db", "query"] }, { "$var": "sql" }] }
{ "$fn": [{ "$var": "io", "$get": "readLine" }] }
{ "$fn": [{ "$var": "caps", "$get": { "$var": "name" } }, { "$var": "x" }] }
{ "$fn": [{ "$get": "method", "$from": { "$fn": ["f", { "$var": "x" }] } }, { "$var": "y" }] }
{ "$fn": [{ "$fn": ["makeCountdown", 42] }, 3] }
```

The callee lowering is exactly the property-access lowering of §5 (a `$var`/`$get`
chain rooted at a variable, or a `$get`/`$from` chain rooted at an expression),
placed as the first element of the `$fn` call array.

> **Printer note (deferred).** These forms parse and evaluate today, but the
> canonical pretty-printer currently wraps the callee in parentheses
> (`(caps.db.query)(sql)`, `(makeCountdown(42))(3)`). That still round-trips —
> `parse(print(x))` is `x` — so the bijective-by-normal-form guarantee holds; it
> is only less pretty than the bare source. Tightening the printer to emit the
> bare form for access-headed and call-headed callees (while keeping the parens
> on a bare `$var` callee, since `f(x)` would otherwise collide with a
> literal-name call) is tracked as deferred polish (§12).

### Function reference — `&`

Passes a function as a value (the language's non-array `$fn`).

```jfn
&double                   // by name
map(&double, nums)
&(expr)                   // evaluated reference (rare)
```

```json
{ "$fn": "double" }
{ "$fn": ["map", { "$fn": "double" }, { "$var": "nums" }] }
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

A bare identifier is a variable. Access lowers to `$var` + `$get`; access on a
non-variable expression lowers to `$get` + `$from`.

A bare identifier that is **not** a lexical binding but **is** a registered
function resolves to that function _reference_ (i.e. `&`-free; see §4). The
fallback only applies to a plain name: a name with a trailing path (`length.foo`)
that has no lexical binding is an error rather than resolving the reference and
then walking into it.

```jfn
x                         // {"$var":"x"}
a.b                       // {"$var":"a","$get":"b"}
a.b.c                     // {"$var":"a","$get":["b","c"]}
a[0]                      // {"$var":"a","$get":0}
a[i]                      // {"$var":"a","$get":{"$var":"i"}}
f(x).b                    // {"$get":"b","$from":{"$fn":["f",{"$var":"x"}]}}
```

Lowering rules:

- Inside `[...]`, an **integer or quoted string** is a **static** key/index; a
  **bare identifier or any other expression** is a **computed** key.
- A run of consecutive **static** segments folds into one `$get` (a single
  string/number, or an array path for multiple): `a.b[0].c` →
  `{"$var":"a","$get":["b",0,"c"]}`.
- A **computed** segment cannot join a static array path; it starts a new
  `$get`/`$from` wrapping the prior result: `a.b[i]` →
  `{"$get":{"$var":"i"},"$from":{"$var":"a","$get":"b"}}`.

Canonical JSON is always the `$var`/`$get` form (the older `$var` dotted
path-string form is deprecated; see `shorthand-stdlib-changes.md` if we remove
it from the interpreters).

An access chain **in call position** is a method call: the chain evaluates to a
function value that is then applied (`caps.db.query(sql)`). See §4.

---

## 6. Operators and precedence

A closed set of operators. Precedence from highest to lowest:

| Prec | Operators         | Assoc   | Lowers to                               |
| ---- | ----------------- | ------- | --------------------------------------- |
| 1    | `!x` `-x` (unary) | prefix  | `$not` · `neg(x)`                       |
| 2    | `*` `/` `%`       | left    | `mul` · `div` · `mod` (stdlib calls)    |
| 3    | `+` `-` `++`      | left    | `add` · `sub` · `strcat` (stdlib calls) |
| 4    | `== != < <= > >=` | none    | `$eq $neq $lt $lte $gt $gte`            |
| 5    | `&&`              | flatten | `$and` (short-circuit, variadic)        |
| 6    | `\|\|`            | flatten | `$or` (short-circuit, variadic)         |

```jfn
row * 8 + col
!done
x > 0 && x < 100
cached || compute(x)
```

```json
{ "$fn": ["add", { "$fn": ["mul", { "$var": "row" }, 8] }, { "$var": "col" }] }
{ "$not": { "$var": "done" } }
{ "$and": [{ "$gt": [{ "$var": "x" }, 0] }, { "$lt": [{ "$var": "x" }, 100] }] }
{ "$or": [{ "$var": "cached" }, { "$fn": ["compute", { "$var": "x" }] }] }
```

Rules and rationale:

- **Arithmetic and `++`** lower to **stdlib `$fn` calls**; **comparisons, `&&`,
  `||`, `!`** lower to **language `$`-forms**.
- `&&`/`||` **flatten**: `a && b && c` → one variadic `$and`. They map to the
  short-circuit language forms, **never** the eager stdlib `and`/`or` (call those
  by name: `and(a, b)`).
- Comparisons are **non-associative** (exactly two operands; no `a < b < c`).
  `==` is `$eq` (strict); for structural equality call `jsonEq(a, b)`.
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
{ "$fn": ["strcat", "Illegal move: ", { "$var": "moveDesc" }] }
{ "$fn": ["strcat", { "$var": "firstName" }, " ", { "$var": "lastName" }] }
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
{ "$if": { "$gt": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
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
    [{ "$lt": [{ "$var": "n" }, 0] }, "negative"],
    [{ "$eq": [{ "$var": "n" }, 0] }, "zero"]
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
    ["show", { "$fn": ["showResult", { "$var": "state" }] }],
    ["reset", { "$fn": ["resetResult"] }]
  ],
  "$else": { "$fn": ["moveResult", { "$var": "state" }, { "$var": "argv" }] }
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
{ "$params": ["a", "b"], "$return": { "$fn": ["add", { "$var": "a" }, { "$var": "b" }] } }
```

### `expr where { name: value, … }`

The return expression comes first; the trailing `where { … }` clause supplies
the locals. Bindings use `:` (mirroring the JSON, where locals are literally
key–value entries on the function-body object).

```jfn
(x, y) => doubled where {
  sum:     add(x, y),
  doubled: mul(sum, 2)
}
```

```json
{
  "$params": ["x", "y"],
  "sum": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] },
  "doubled": { "$fn": ["mul", { "$var": "sum" }, 2] },
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

`where` is not an operator — `parseExpr` stops before it — so it is only valid
as a postfix clause on a function body, not inside arbitrary expressions.

A bare `{...}` is **always** a data object — including immediately after `=>`:

```jfn
(state) => { output: boardSection(state, ""), exitCode: 0 }
```

```json
{
  "$params": ["state"],
  "$return": { "output": { "$fn": ["boardSection", { "$var": "state" }, ""] }, "exitCode": 0 }
}
```

### Parameters

- **No params:** `() => …` lowers to a body with **no `$params`** key.
- **Rest param:** `(first, ...rest) => …` → `"$params": ["first", "...rest"]`.
- Missing arguments default to `null` (language behavior).

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
  "$return": { "$params": ["y"], "$return": { "$fn": ["add", { "$var": "x" }, { "$var": "y" }] } }
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
and functions are callable via `$fn`, with the same lazy, order-independent,
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
    "$return": { "$if": { "$eq": [{ "$var": "color" }, "w"] }, "$then": "b", "$else": "w" }
  },
  "pieceType": { "$params": ["piece"], "$return": { "$fn": ["upper", { "$var": "piece" }] } }
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
program     := expr

expr        := orExpr
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := addExpr ( ("=="|"!="|"<"|"<="|">"|">=") addExpr )?   // non-assoc
addExpr     := mulExpr ( ("+"|"-"|"++") mulExpr )*
mulExpr     := unary ( ("*"|"/"|"%") unary )*
unary       := ("!"|"-") unary | postfix
postfix     := primary ( "." ident
                       | "[" (int | string) "]"      // static
                       | "[" expr "]"                // computed
                       | "(" args ")" )*
primary     := number | string | template | "true" | "false" | "null"
             | ident                                 // variable, or fn name if called
             | "&" ident | "&" "(" expr ")"          // function reference
             | "(" expr ")"
             | funcLit
             | "[" (expr ("," expr)*)? "]"           // array
             | "{" (dataEntry ("," dataEntry)*)? "}" // data object
             | "if" expr "then" expr "else" expr
             | "cond" "{" arm ("," arm)* "}"
             | "match" expr "{" arm ("," arm)* "}"
             | "raw" jsonValue

funcLit     := "(" params ")" "=>" body
body        := expr ( "where" "{" binding ("," binding)* "}" )?
binding     := ident ":" expr
params      := ( ident ("," ident)* )?               // last may be "...ident"
dataEntry   := (ident | string) ":" expr
             | ident                                 // punned: { x } == { x: x }
arm         := (expr | "else") "->" expr
template    := "`" ( char | "${" expr "}" )* "`"     // strict; no coercion
ident       := [A-Za-z_][A-Za-z0-9_]*
```

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
