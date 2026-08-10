# Control flow

## `if … then … else …`

All three expressions are required. The condition must evaluate to `true` or
`false`; only the selected branch is evaluated.

```jfn
if x > 0 then "positive" else "non-positive"
```

```json
{ "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
```

## `cond { … }`

Arms are tested in order. The first condition to evaluate to `true` selects
its result.
`else: …` is optional. `true: …` is an explicit catch-all arm within `$cond`.
Evaluation fails if no arm matches and neither catch-all form is present. Only
the selected result is evaluated.

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

## `match subject { … }`

The subject is evaluated once. Case values are scalars and are compared with
strict equality in source order. `else: …` is required. Only the selected
result is evaluated.

Within `cond` and `match`, the surrounding form distinguishes arm colons from
colons in nested object expressions.

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

## Boolean conditions

Conditions are boolean positions: the condition of an `if` and of each `cond`
arm must evaluate to `true` or `false`, and any other value is an immediate
error. `&&`, `||`, and prefix `!` are boolean-only in the same way — every
evaluated operand must be a boolean, and the result is a boolean. No value
coerces to a boolean: write the test out (`x != null`, `n > 0`, `s != ""`,
`length(xs) > 0`). `match` selects by strict equality on its scalar subject
instead. The position inventory and error identity are defined in
[boolean positions](../json/expressions.md#boolean-positions).

