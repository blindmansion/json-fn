# Effects: `do` and `handle`

`do` and `handle` lower to the `perform`, `pure`, `bind`, and `handle` task
operations. See [Tasks and effects](../json/tasks-and-effects.md) for their
runtime semantics.

`do` and `handle` are contextual keywords in primary-expression position.
They remain valid property names and access segments.

## `do { … }` — sequencing effects

A `do` block is a comma-separated list of:

- **effect binding** — `name <- expr`: run the task `expr`, bind its result to
  `name` for the rest of the block;
- **pure binding** — `name : expr`: a lazy local (like a `where` binding; the
  value parses as a `body`, so a trailing `where` works);
- **bare expression** — a discard if non-final, or the block result if final.

A `do` block **must end with a result expression**, never a binding.

Each effect binding and discard starts a nested `bind(expr, k)`.
The continuation `k` binds the effect result to `name` (effect binding) or takes
no parameter (discard). `_ <- expr` instead binds the name `_`. Pure bindings
since the previous
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

### `<-` adjacency

In a `do` binding, `<-` requires adjacent `<` and `-` characters on the same
line. Elsewhere, `< -` is a comparison against a negated operand.

## `handle … (returns Type)? with { … }` — in-language effect interpreter

`handle <task> with { "name": clause, … }` lowers to
`handle(task, { …clauses… })`. The clause record follows **data-object key
rules** for [data objects](literals-and-data.md#data-objects--key-value), so dotted effect names (`io.readLine`) and the `"*"` wildcard must be
quoted. `return` may be bare. Literal clause names cannot start with `$`; use a
computed key for such a name.
Clause semantics — named clauses, `"*"`,
`"return"`, bubbling, and multi-shot `resume` — are specified in the language
reference.

The total form `handle <task> returns <type> with { … }` lowers the type schema
as a `$raw`-quoted third argument:
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

## Canonical rendering

Only exact lowering shapes render with this syntax. A `bind` call whose
continuation is a structural function literal renders as `do { … }`. A leading
`$let` around the bind spine reconstructs leading pure entries; a `$let` in a
continuation's `$return` reconstructs the consecutive pure entries after that
effect/discard. A `handle` call with a literal clause object prints as
`handle … with { … }`; a third `$raw` schema argument prints as
`handle … returns Type with { … }`. Any other shape—e.g. a `bind` with an
`&`-referenced continuation, or a `handle` whose clauses are a computed
expression—prints as a plain call.
