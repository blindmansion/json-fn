# Effects: `do` and `handle`

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

## `do { … }` — sequencing effects

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

### The `<-` adjacency rule

`<-` is **not a lexer token** — tokenizing it as one would break `x < -1`.
Instead, only in do-binding position, the parser recognizes a `<` token
immediately followed by an **adjacent** `-` token (same line, next column).
Everywhere else `< -` is an ordinary comparison against a negated operand, so a
`do` result like `r < -1` is unaffected.

## `handle … (returns Type)? with { … }` — in-language effect interpreter

`handle <task> with { "name": clause, … }` lowers to
`handle(task, { …clauses… })`. The clause record follows **data-object key
rules** for [data objects](literals-and-data.md#data-objects--key-value), so dotted effect names (`io.readLine`), the `"*"` wildcard, and the
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

## Canonical printback

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
