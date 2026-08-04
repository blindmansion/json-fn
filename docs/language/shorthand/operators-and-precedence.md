# 6. Operators and precedence

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

## Template strings

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

