# Control flow

## `if / then / else` → `$if`

All three branches required; only the taken branch is evaluated.

```jfn
if x > 0 then "positive" else "non-positive"
```

```json
{ "$if": { "$call": "gt", "$args": [{ "$var": "x" }, 0] }, "$then": "positive", "$else": "non-positive" }
```

## `cond { … }` → `$cond`

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

## `match subject { … }` → `$match`

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

## Truthiness

Unchanged from the language: `0`, `""`, `null`, and `false` are falsy;
everything else is truthy. Truthiness controls `if`, `cond`, `&&`, `||`, and
`!`. A `match` subject is compared against its case values instead.

---

