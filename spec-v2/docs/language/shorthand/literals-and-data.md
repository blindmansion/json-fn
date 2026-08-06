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

Bare `$`-prefixed keys are invalid because they collide with canonical forms.
A quoted `$`-prefixed key is valid only within static JSON data; lowering wraps
the maximal static literal in `$raw`. To give a dynamic object a
`$`-prefixed key, use a computed key: `{ ["$status"]: status }`.

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
They lower in source order using `merge` and `fromEntries`. `merge` is shallow,
and its right-hand object wins conflicts.

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

There is no quoting keyword. Static JSON lowers to itself unless it contains a
quoted `$`-prefixed key. In that case, the maximal static literal around the key
lowers under `$raw` and is not evaluated.

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

Plain constant data such as `[1, 2, 3]` stays plain canonical JSON. A `$raw`
payload counts toward its containing region's static cost constant exactly
like the equivalent plain constant literal (see
[Execution limits](../../runtime/execution-limits.md)).

Canonical rendering writes a generic `$raw` payload as strict JSON. Redundant
wrappers around scalars and collision-free static JSON normalize away.
Boundaries protecting expression-shaped or reserved-key payloads, literal
`$comment` entries, generated code used as data, and an annotated handler's
[result schema](effects.md) are retained.

Module bindings and `handle` clause records do not infer `$raw`: a module root
stays a module and an empty clause record stays a handler record. `raw` is an
ordinary identifier.

