# Control flow

## `if … then … else …`

All three expressions are required. Only the selected branch is evaluated.

```jfn
if x > 0 then "positive" else "non-positive"
```

```json
{ "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
```

## `cond { … }`

Arms are tested in order. The first truthy condition selects its result.
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

## Truthiness

`0`, `""`, `null`, and `false` are falsy. Every other value is truthy.
Truthiness controls `if`, `cond`, `&&`, `||`, and prefix `!`. `match` uses
strict equality instead.

