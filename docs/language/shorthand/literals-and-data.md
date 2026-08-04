# Literals and data

## Scalars

```jfn
42        "hello"        true        null
```

Lower to themselves.

## Arrays — `[...]`

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

## Data objects — `{ key: value }`

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
`{ year, month, day }` [**object-pattern parameter**](function-literals-and-local-bindings.md#object-pattern-parameters), so a destructured
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

## Quoted data — inferred `$raw`

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
annotated-`handle` [result schema](effects.md)) are always retained.

Module bindings and `handle` clause records are explicit no-inference
contexts: a module root stays a module and an empty clause record stays a
handler record. `raw` is an ordinary identifier, not a keyword.

---

