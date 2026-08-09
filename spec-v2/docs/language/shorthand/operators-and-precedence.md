# Operators and precedence

Precedence is highest to lowest:

| Prec | Operators             | Assoc   | Lowers to                                        |
| ---- | --------------------- | ------- | ------------------------------------------------ |
| 0    | `x!` (non-null)       | postfix | `{ "$nonnull": x }`                              |
| 1    | `!x` `-x` (unary)     | prefix  | `not(x)` · `neg(x)` (stdlib calls)               |
| 2    | `*` `/` `%`           | left    | `mul` · `div` · `mod` (stdlib calls)             |
| 3    | `+` `-` `++`          | left    | `add` · `sub` · `strcat` (stdlib calls)          |
| 4    | `??`                  | right   | the access's `$else` arm                          |
| 5    | `== != < <= > >=`     | ordered chain | `eq neq lt lte gt gte` (stdlib calls)       |
| 6    | `&&`                  | flatten | `$and` (short-circuit, variadic)                  |
| 7    | `\|\|`                | flatten | `$or` (short-circuit, variadic)                   |
| 8    | `expression checked as Type` | none | `{ "$as": expression, "$type": schema }`       |

```jfn
row * 8 + col
!done
x > 0 && x < 100
0 <= x < 100
cached || compute(x)
inv[sku] ?? emptyLot()
balance + delta checked as Cents
```

```json
{ "$call": "add", "$args": [{ "$call": "mul", "$args": [{ "$var": "row" }, 8] }, { "$var": "col" }] }
{ "$call": "not", "$args": [{ "$var": "done" }] }
{ "$and": [{ "$call": "gt", "$args": [{ "$var": "x" }, 0] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }] }
{ "$and": [{ "$call": "lte", "$args": [0, { "$var": "x" }] }, { "$call": "lt", "$args": [{ "$var": "x" }, 100] }] }
{ "$or": [{ "$var": "cached" }, { "$call": "compute", "$args": [{ "$var": "x" }] }] }
{ "$get": { "$var": "sku" }, "$from": { "$var": "inv" }, "$else": { "$call": "emptyLot", "$args": [] } }
{ "$as": { "$call": "add", "$args": [{ "$var": "balance" }, { "$var": "delta" }] }, "$type": { "$ref": "#/$defs/Cents" } }
```

Arithmetic, `++`, comparisons, prefix `!`, and unary `-` lower to the named
calls shown above. The call spellings remain valid input, but canonical
rendering uses operators. A leading `-` on a numeric literal is part of that
literal rather than a `neg` call.

`&&` and `||` lower to the short-circuit `$and` and `$or` forms and flatten
consecutive operands into one variadic form. Named `and(...)` and `or(...)`
calls remain eager.

Additional rules:

- Ordered comparisons may be chained: `a < b <= c` means
  `a < b && b <= c`. Mixed ordered operators are allowed. Equality operators
  cannot participate in a chain: `a == b < c` and `a < b != c` are errors.
  Equality is structural; scalar equality is strict.
- Chained comparisons evaluate from left to right and stop after the first
  false comparison. A nontrivial interior operand is hoisted into a `$let`
  binding shared by its adjacent comparisons; it therefore evaluates exactly
  once, before the chain's comparisons, even when an earlier comparison is
  false. The first and last operands evaluate inline, only when their
  comparison is reached.
- `??` supplies a default for a property or index access that **misses**. It
  lowers to the access's `$else` arm and fires on absence only — never on a
  present `null` value, unlike JavaScript's `??`. Its left operand must be a
  property or index access; `expr ?? d` on anything else is a parse-time
  error. Its position between additive and comparison means
  `a[i] ?? b + 1` parses as `a[i] ?? (b + 1)` (a default is usually a small
  computed value) and `x.k ?? limit < 9000` parses as
  `(x.k ?? limit) < 9000` (default, then compare). It is right-associative:
  `a[i] ?? b[j] ?? d` parses as `a[i] ?? (b[j] ?? d)` and lowers to nested
  `$else` arms — the first miss falls to the next access, then to `d`. See
  [access defaults](function-calls-and-references.md#access-defaults-with-).
- Postfix `x!` is a runtime-checked non-null assertion. It removes `null` from
  the inferred type, returns every non-null value unchanged, and raises an
  evaluation error on `null`.
- `expression checked as Type` evaluates the expression once, validates the
  result against the type, and gives the result that type. It binds less
  tightly than `||`, so
  `a + b checked as Cents` means `(a + b) checked as Cents`. It is
  non-associative; repeat checks as `(x checked as A) checked as B`. Postfix
  assertion still binds tightly (`x! checked as T`), while asserting an
  ascribed result requires parentheses (`(x checked as T)!`). `checked` remains
  an ordinary identifier outside this two-token operator position:
  `checked(value)` is a call, while ascribing a variable with that name is
  written `(checked) checked as T`.
## Template strings

Backtick strings with `${expr}` holes lower to a flat variadic `strcat` call,
the same form as `++`.

```jfn
`Illegal move: ${moveDesc}`
`${firstName} ${lastName}`
```

```json
{ "$call": "strcat", "$args": ["Illegal move: ", { "$var": "moveDesc" }] }
{ "$call": "strcat", "$args": [{ "$var": "firstName" }, " ", { "$var": "lastName" }] }
```

Interpolation rules:

- `${expr}` requires `expr` to be a
  string; wrap non-strings explicitly (`${str(n)}`), consistent with `strcat`.
- Use `` \` `` for a literal backtick, `\${` for a literal
  dollar-brace, `\\` for a backslash. Other JSON escapes (`\n`, `\u2654`) apply
  inside literal spans.
- A canonical `strcat` with a string-literal segment renders as a template; one
  containing only expressions renders with `++`.
- Degenerate forms normalize: `` `${x}` `` → `x`; `` `hello` ``
  (no holes) → `"hello"`.

