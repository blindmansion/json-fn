# Destructured (object-pattern) parameters — `$fields`

Status: **spec drafted, unimplemented.** Conformance cases are written
(`spec/cases/destructured-params.json`, `spec/parse-cases/destructured-params.json`)
and define the target behavior for every implementation. No interpreter or
parser/printer changes have landed yet.

This is the implementer-agnostic specification for kwargs-style named arguments,
backing the entry in `todo/new-features.md` ("kwargs-style destructured function
args").

---

## 1. Summary

A function parameter may be an **object pattern** that binds named fields of a
single object argument to locals, instead of relying on positional order:

```jfn
move = ({ from, to }) => sub(to, from)
```

called as

```jfn
move({ from: 3, to: 7 })     // => 4
```

The crucial property: **the calling convention is unchanged.** `move({ from: 3,
to: 7 })` is an ordinary positional call passing one plain-data object; the
"named-ness" lives entirely in the *parameter*, which destructures that object.
Nothing about `$fn` argument evaluation or dispatch changes. Only three things
are new: a canonical JSON shape for a pattern slot, surface syntax for it, and
binding logic that spreads the object's fields into locals.

---

## 2. Canonical JSON representation

`$params` remains the ordered list of parameter **slots**. Today every slot is a
string (`"n"`, a rest `"...rest"`). A slot may now also be an **object pattern**:

```json
{ "$fields": ["from", "to"] }
```

So `$params` is `(string | { "$fields": string[] })[]`. Example:

```json
{
  "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$fn": ["sub", { "$var": "to" }, { "$var": "from" }] }
}
```

Rules:

- `$fields` is a **non-empty** array of identifier strings.
- Each field name obeys the existing parameter-name rule: it must not contain
  `.` or `[`.
- A `$fields` object is valid **only** as an element of `$params`. It may not be
  preceded by `...` (there is no rest-pattern).
- A pattern slot occupies exactly **one** positional argument position (see §4).

Why a per-slot object rather than making `$params` itself an object: `$params`
is an *ordered, positional* list, and the language is deliberate that object key
order is not semantically load-bearing. Localizing the pattern to one slot keeps
positional order meaningful, lets patterns mix freely with ordinary and rest
params, and leaves the type-system plan's positionally-parallel `$sig.params`
(see `plans/type-sketch.md` §3.1) untouched — types never live in `$params`.

---

## 3. Shorthand surface and lowering

Grammar delta (extends `docs/shorthand-spec.md` §8 / §10 `params`):

```
params := ( param ("," param)* )?           // last may be "...ident"
param  := ident
        | "..." ident
        | "{" ident ("," ident)* ","? "}"   // object pattern
```

Lowering:

```jfn
({ from, to }) => sub(to, from)
```

```json
{ "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$fn": ["sub", { "$var": "to" }, { "$var": "from" }] } }
```

- A trailing comma inside the pattern is accepted (consistent with arrays,
  objects, and argument lists) and normalizes away.
- Patterns compose with positional and rest params: `(label, { x, y }) => …`,
  `({ x }, ...rest) => …`, `({ a }, { b }) => …`.

Not accepted in this version (each is a **parse error**, reserving the syntax
for later):

- Empty pattern `({}) => …`.
- Rename `({ from: f }) => …` (the `:` is rejected).
- Nested pattern `({ a: { b } }) => …`.
- Rest pattern `(...{ x }) => …`.
- Non-identifier field `({ 1 }) => …`.

### Canonical printing

The printer renders a `$fields` slot as `{ f1, f2 }` — a space inside each brace,
`", "` between fields — inside the normal `(params) =>` header. Since spacing is
insignificant to the parser, this is purely aesthetic; the round-trip guarantee
(`parse ∘ print = id`) holds because the reparsed `$fields` array is identical.
The printer never emits an empty `{}` slot (empty `$fields` is not a valid
canonical input).

---

## 4. Binding semantics (evaluation)

For a slot `{ "$fields": [f1, …, fk] }` at position `i`, let `v` be the `i`-th
argument (`null` if fewer than `i+1` arguments were supplied). Then:

- If `v` is a JSON **object** (not an array, not `null`): each `fj` binds to
  `v[fj]` when that key is present, otherwise to `null`.
- Otherwise (`v` is `null`, a boolean, number, string, or **array**): every `fj`
  binds to `null` (**lenient** — mirrors the language's "missing args default to
  `null`" rule; an array is not a plain object, matching `isObject`).
- Extra keys of `v` are ignored.

Bindings are **eager**, established once at call time, exactly like positional
parameters (they are not lazy locals). Within the body they are visible via
`$var` to `$return` and to sibling lazy locals, and can be read by `where`
bindings.

Position accounting: each slot — string **or** pattern — consumes one positional
argument, left to right. A trailing `...rest` collects all remaining arguments
after the fixed slots, unchanged. Thus `(label, { x, y }, ...rest)` called with
`("p", { x: 1, y: 2 }, 8, 9)` binds `label="p"`, `x=1`, `y=2`, `rest=[8, 9]`.

---

## 5. Arity and introspection

`arity` counts a pattern slot as **one** positional parameter (it consumes one
argument). A trailing rest is still excluded from the count, as today.

- `arity(({ from, to }) => …)` → `1`
- `arity((a, { x, y }) => …)` → `2`
- `arity(({ x }, ...rest) => …)` → `1`

---

## 6. Scoping and closures

Field names behave identically to parameter names for scope purposes:

- They **shadow** same-named outer bindings within the body, at any nesting
  depth. An inner lambda whose own param/field/local reuses a field name shadows
  it (e.g. `({ x }) => ((x) => x)(99)` returns `99`).
- Closure substitution must treat field names as **bound**: when a body is
  returned as a value and outer variables are substituted in, a field name is
  masked out of that substitution just like a param name, so it is not
  accidentally captured from an enclosing scope.

Implementation note (non-normative): in the reference TypeScript interpreter
this means `buildScope` binds fields alongside params, and the local-name set
that `replaceVars` builds from `$params` must include field names.

---

## 7. Validation and errors

Structural validation (all implementations, at the point `$params` is checked):

- Each `$params` element is a string or an object of the exact shape
  `{ "$fields": string[] }`.
- `$fields` is a non-empty array whose every element is a string with no `.` or
  `[`.

The specific error messages are implementation-defined; the conformance parse
cases only assert that malformed **surface** forms fail to parse.

---

## 8. Interactions and non-goals

- **Rename, defaults, nesting** (`{ from: f }`, `{ x = 1 }`, `{ a: { b } }`):
  deferred. The `$fields: string[]` shape can later widen its entries (e.g. to
  `[key, localName]` pairs or objects) without breaking the current form.
- **Duplicate binding names** (a field repeated, or colliding with a sibling
  positional param): deferred; left unspecified for now (do not rely on it).
- **Type system:** orthogonal. Types attach via `$sig` (`plans/type-sketch.md`),
  positionally parallel to `$params`; a pattern slot's declared type is just the
  object schema at the matching `$sig.params` index. No changes here.
- **Rust port:** this spec is implementer-agnostic and the conformance cases
  target both implementations, but the first cut lands **TypeScript only**
  (parser, printer, evaluator). The Rust implementation and the normative
  `docs/language.md` / `docs/shorthand-spec.md` edits follow once TS is proven
  against these cases.

---

## 9. Conformance cases

- **Evaluation:** `spec/cases/destructured-params.json` — binding, missing key →
  `null`, extra keys ignored, non-object / missing / null / array argument →
  all-`null`, mixed positional+pattern, pattern+rest, multiple patterns, fields
  visible to locals, nested-call visibility, inner shadowing, and `arity`.
- **Parsing:** `spec/parse-cases/destructured-params.json` — single/multiple
  fields, mixed with positional and rest, multiple patterns, trailing comma,
  pattern with a `where` clause, plus the rejected forms from §3 (empty, rename,
  nested, rest-pattern, non-identifier). Every non-error `expected` also feeds
  the printer round-trip corpus.
