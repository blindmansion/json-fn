# Builtin type signatures

Status: **implemented in the canonical TypeScript checker.** The other
implementations may lag while the language is still evolving.

## Why this exists

The builtin registry (`stdlib.ts` and its ports) is reimplemented in every
language. Their *types* are needed by every static checker (see
`plans/type-sketch.md` §5.3). Writing those types four times guarantees drift.

So the canonical builtin signatures live in **one** language-agnostic file,
`spec/builtins.json`, exactly like the conformance cases in `spec/cases/`. Each
implementation reads (or, later, bundles / codegens) that file and feeds it to
its checker's builtin layer.

The goal is only to **shrink the shared surface area**. Where a signature is
impossible or unwise to express in the agnostic dialect, the table punts to a
per-implementation escape hatch (see [Escape hatch](#escape-hatch)) rather than
contorting the format.

## Why not just one schema per builtin

Monomorphic signatures would launder everything to `any`: `setAt(board, i, p)`
typed as `(any[], integer, any) -> any[]` silently disables checking for the
whole downstream dataflow. The load-bearing builtins (`map`, `filter`, `setAt`,
`concat`, …) are exactly the polymorphic ones. So the table speaks a small
dialect **on top of** the user-facing schema fragment (`docs/language.md` /
`plans/type-sketch.md` §2). These extensions are **builtin-only** — they never
appear in user-written types or in the schemas the checker infers; the checker
*instantiates* them away at each call site.

## File shape

```json
{
  "$defs": { "Match": { "...": "shared builtin-owned named types" } },
  "builtins": {
    "add": [ /* overload signatures */ ],
    "pipe": { "rule": "pipe" }
  }
}
```

- **`$defs`** — named types owned by builtins (e.g. the regex `Match` record),
  referenced with ordinary `{"$ref": "#/$defs/Name"}`. Merged into the module's
  `$types` pool by the checker (module types win on a name clash).
- **`builtins`** — a map from builtin name to either an **overload set** (an
  array of signatures) or a **rule escape hatch** (`{"rule": "..."}`).

## Signatures

A signature reuses the `$fnType` inner shape plus an optional `typeParams`:

```json
{ "typeParams": ["T", "U"], "params": [ /* Schema */ ], "rest": { }, "returns": { } }
```

- `params` — one schema per fixed parameter.
- `rest` — optional; the element schema of a variadic tail (as in `$fnType`).
- `returns` — the result schema.
- `typeParams` — the type variables this signature binds (see below).

### Overload sets

Each builtin maps to an **array** of signatures, tried in order; the first whose
concrete (non-lambda) arguments fit is chosen. Overloads express both ad-hoc
polymorphism and type-directed refinement:

```json
"add": [
  { "params": [{ "type": "integer" }, { "type": "integer" }], "returns": { "type": "integer" } },
  { "params": [{ "type": "number" },  { "type": "number" }],  "returns": { "type": "number" } }
],
"length": [
  { "params": [{ "type": "array" }],  "returns": { "type": "integer" } },
  { "params": [{ "type": "string" }], "returns": { "type": "integer" } }
]
```

`add` preserves `integer` when both arguments are integers and widens to
`number` otherwise; `length` accepts arrays or strings. No special-case code —
just ordered overloads.

### Type variables

A type variable is the node `{"$tvar": "T"}` (distinct from `$ref`, which points
into `$defs`). Variables named in `typeParams` are bound per call site by
matching the template against the concrete argument schemas, then substituted
into `returns`:

```json
"map": [{
  "typeParams": ["T", "U"],
  "params": [
    { "$fnType": { "params": [{ "$tvar": "T" }, { "type": "integer" }], "returns": { "$tvar": "U" } } },
    { "type": "array", "items": { "$tvar": "T" } }
  ],
  "returns": { "type": "array", "items": { "$tvar": "U" } }
}]
```

`T` is inferred from the array argument; the instantiated parameter type
`(T, integer) -> U` is then pushed into the inline callback (contextual typing,
§4.3), and `U` is inferred from the callback's synthesized return.

#### Contextual lambdas and concrete functions

Only a bare inline body with no `$sig` is contextually typed. Its declared
parameters receive the callback argument schemas supplied by the builtin. It
may omit trailing parameters it does not use, but may not declare more fixed
parameters than the builtin supplies; a rest parameter collects the remaining
supplied schemas.

When a callback return widens a type variable that also occurs in its parameter
types, the checker validates the callback again under the final joined type.
This matters for `reduce`: if the callback expands accumulator `U`, its body
must be valid for every accumulator type a later iteration may receive. The
validation pass does not widen the inferred bindings further.

An annotated inline body or referenced/named function is instead a concrete
function value. Its declared signature is preserved, its body is checked
against its declared return, and the complete function type is validated after
all call-site type-variable bindings are final. Function parameters remain
contravariant: a callback may accept a broader input type than the builtin
passes, but not a narrower one.

#### Structural matching

Template matching follows type variables through the tractable container
shapes, rather than binding only a whole argument:

- homogeneous array `items`;
- tuple `prefixItems` positionally and tuple `items` as the rest element;
- object `properties` by key and schema-valued `additionalProperties`;
- function returns (parameters are compatibility constraints, not inference
  sources).

Repeated occurrences join with a union. Concrete union arms are all matched,
also joining their bindings. For an object map template, concrete fields not
named by the template contribute to its `additionalProperties` variable; a
closed record therefore infers the union of those field types, while an open
object contributes `any`. Matching still ends with the ordinary subschema
check, so structural inference does not loosen tuple lengths, required fields,
or open/closed-object compatibility.

#### `mapValues`

`mapValues` uses the same `T`/`U` machinery over object values:

```json
"mapValues": [{
  "typeParams": ["T", "U"],
  "params": [
    { "$fnType": { "params": [{ "$tvar": "T" }, { "type": "string" }], "returns": { "$tvar": "U" } } },
    { "type": "object", "additionalProperties": { "$tvar": "T" } }
  ],
  "returns": { "type": "object", "additionalProperties": { "$tvar": "U" } }
}]
```

For a closed input record, `T` is the union of its value schemas; for a typed
map, it is the map's value schema; and an open object contributes `any`. The
callback receives `(value: T, key: string)` and determines `U`. The shared
result is the honest map floor `{ [string]: U }`: `mapValues` preserves the
input's exact keys at runtime, but exact key preservation requires an
argument-dependent code computation and is intentionally not represented by
this data template.

#### `groupBy`

`groupBy` accepts a key callback returning `string | number`. Numeric keys are
stringified at runtime because JSON object keys are strings, so its result is
the honest map floor `{ [string]: T[] }`; exact group keys are not preserved
statically.

#### Intentional static/runtime boundaries

- Runtime higher-order functions accept raw string callback names, but the
  checker does not resolve those names. Inline lambdas and typed function
  references are the canonical checked forms.
- `reReplaceWith` callbacks statically return `string`; the runtime
  defensively applies `String()` to other values.
- `filter` and `find` do not derive type predicates from callback logic.
- A bare contextual lambda may omit trailing builtin-supplied arguments.
  Referenced and `$sig`-annotated callbacks retain strict function arity; a
  wrapper lambda is the typed workaround when their arities differ.

The CLI's type-coverage summary measures degradation to `any`, not the absence
of type errors or maximal inferred precision. `Type coverage: complete` means
that every expression stayed on a statically represented path; type errors are
reported independently. `--require-full-coverage` exits nonzero when an
information-level dynamic degradation is present.

### Variadic `rest`

```json
"concat": [{
  "typeParams": ["T"],
  "params": [],
  "rest": { "type": "array", "items": { "$tvar": "T" } },
  "returns": { "type": "array", "items": { "$tvar": "T" } }
}]
```

## Escape hatch

Some builtins can't be captured by a data template (`pipe`, `apply`, the
effects/`Task` constructors — arity threading, heterogeneous returns, etc.).
They are listed with a named rule so the *set* of builtins stays canonical and
cross-language even though the *resolution* is code:

```json
"pipe": { "rule": "pipe" }
```

Each implementation decides how to handle a given rule name. An unrecognized
rule yields `any` (its arguments are still walked for nested errors). This is the
deliberate release valve: prefer an escape hatch over distorting the shared
format.

### Recommended floors

A rule need not be fully inert. The recommended baseline ("floor") pins the
fixed arity, the result type, and the shape of the argument positions a data
template *can* pin — enough to reject a wrong-arity/wrong-shape call and to give
effectful functions a `Task` return, without a full code rule. An `any`-typed
argument is exempt from shape checks (a strict `any ⊄ array` would hard-error on
the dynamically typed values these builtins routinely accept):

| rule      | arity | argument shapes            | returns |
| --------- | ----- | -------------------------- | ------- |
| `pipe`    | 2     | arg 0: `array`             | `any`   |
| `apply`   | 2     | arg 1: `array`             | `any`   |
| `handle`  | 2     | —                          | `any`   |
| `perform` | 2     | arg 0: `string`, 1:`array` | `Task`  |
| `pure`    | 1     | —                          | `Task`  |
| `bind`    | 2     | —                          | `Task`  |
| `raise`   | 1     | —                          | `Task`  |

`Task` is the opaque effect node, defined in `$defs` as the tagged record shape
`{ "@task": string, ... }` (see the kernel in the language reference). Returning
it as a `$ref` lets a `-> Task` or `-> any` annotation on an effectful function
be satisfied. Precision beyond the floor (e.g. threading `pipe`'s fold) is left
to an optional per-impl code rule.

## What each implementation must provide

The JSON is pure data. Reading it back into working checks needs a small,
per-implementation **instantiation engine** (the algorithm, not the data):

1. Pick the first overload whose concrete arguments fit.
2. Infer type variables from those argument schemas.
3. Instantiate the parameter types and push function-typed parameters into
   inline-lambda arguments; infer any output variables from their returns.
4. Instantiate and return the result schema.

In TypeScript this lives in
`typescript/src/check/builtin-rules.ts`, loaded via
`typescript/src/builtins.ts`. Other implementations may bundle or codegen the
table; that choice is left to each.

### Arg-dependent returns (structural `merge`)

A few builtins keep an ordinary overload signature (good enough for argument
checking) but have a **result that depends structurally on the argument types**,
which no data template can express. After the ordinary overload pass runs (so
the arg/arity diagnostics still fire), a per-impl code rule keyed by name may
recompute the return.

`merge(a, b)` is the canonical case: its declared `object` return is replaced by
the **structural spread** of its two operands — `{ ...a, ...b }` at the type
level, RHS wins on conflict. For each key, `b` decides it if it guarantees the
key; otherwise the value is the union of `b`'s and `a`'s contributions, required
only if `a` guarantees a fallback. Extra keys follow the combined
additional-properties rule (`b` open ⇒ open, `b` map joins with `a`'s, `b`
closed ⇒ inherit `a`'s). Unions distribute per arm; a non-object or `any`
operand degrades to `any` / a bare `object` floor. This lets the pervasive
copy-with-one-field-changed update (`merge(rec, { field: v })`) satisfy a
declared record return. In TypeScript this is `mergeSchemas` (`check/schema.ts`),
dispatched by name in `synthBuiltinCall` (`check/builtin-rules.ts`).
