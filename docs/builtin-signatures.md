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
    "add": { "signatures": [ /* overload signatures */ ] },
    "pipe": {
      "signatures": [
        { "params": [{ "type": "array" }, true], "returns": true }
      ],
      "rule": "core.pipe"
    }
  }
}
```

- **`$defs`** — named types owned by builtins (e.g. the regex `Match` record),
  referenced with ordinary `{"$ref": "#/$defs/Name"}`. Merged into the module's
  `$types` pool by the checker (module types win on a name clash).
- **`builtins`** — a map from builtin name to a callable contract containing a
  non-empty portable fallback **`signatures`** set and, optionally, a
  namespaced host-language **`rule`**.

### Load-time validation

The TypeScript loader validates the table before exposing it to the checker.
Malformed roots, entries, signatures, schema nodes, type-variable declarations,
and references fail with a path-bearing `BuiltinTableValidationError` rather
than becoming trusted data through a type assertion. `validateBuiltinTable`
provides the same validation for an already parsed value.

References are checked against the table's `$defs`. Type variables must be
declared by the containing signature, declarations must be unique and used, and
only the tractable schema fragment described below is accepted. The current
format requires every callable — including rule-backed callables — to provide at
least one fallback signature. Rule identifiers are namespaced strings such as
`core.merge` or `operator.groupLatest`; legacy overload arrays and rule-only
entries are rejected.

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

Each callable contract contains a non-empty **array** of fallback signatures,
tried in order; the first whose concrete (non-lambda) arguments fit is chosen.
Overloads express both ad-hoc polymorphism and type-directed refinement:

```json
"add": { "signatures": [
  { "params": [{ "type": "integer" }, { "type": "integer" }], "returns": { "type": "integer" } },
  { "params": [{ "type": "number" },  { "type": "number" }],  "returns": { "type": "number" } }
] },
"length": { "signatures": [
  { "params": [{ "type": "array" }],  "returns": { "type": "integer" } },
  { "params": [{ "type": "string" }], "returns": { "type": "integer" } }
] }
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
"map": { "signatures": [{
  "typeParams": ["T", "U"],
  "params": [
    { "$fnType": { "params": [{ "$tvar": "T" }, { "type": "integer" }], "returns": { "$tvar": "U" } } },
    { "type": "array", "items": { "$tvar": "T" } }
  ],
  "returns": { "type": "array", "items": { "$tvar": "U" } }
}] }
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
"mapValues": { "signatures": [{
  "typeParams": ["T", "U"],
  "params": [
    { "$fnType": { "params": [{ "$tvar": "T" }, { "type": "string" }], "returns": { "$tvar": "U" } } },
    { "type": "object", "additionalProperties": { "$tvar": "T" } }
  ],
  "returns": { "type": "object", "additionalProperties": { "$tvar": "U" } }
}] }
```

For a closed input record, `T` is the union of its value schemas; for a typed
map, it is the map's value schema; and an open object contributes `any`. The
callback receives `(value: T, key: string)` and determines `U`. The shared
result is the honest map floor `{ [string]: U }`: `mapValues` preserves the
input's exact keys at runtime, but exact key preservation requires an
argument-dependent code computation and is intentionally not represented by
this data template.

#### `flatMap`

`flatMap` accepts callbacks returning either a scalar or an array. Array results
contribute their item type, scalar results contribute themselves, and union
returns distribute across both cases. The result is always an array of that
one-level flattened element type, so a nested array remains an array element.

Its portable fallback contextually types the callback as `(T, integer) -> any`
and returns `any[]`. The `core.flatMap` rule supplies the precise result where
that host-language rule is available; without it, checking retains the fallback
and reports a type-coverage degradation.

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
"concat": { "signatures": [{
  "typeParams": ["T"],
  "params": [],
  "rest": { "type": "array", "items": { "$tvar": "T" } },
  "returns": { "type": "array", "items": { "$tvar": "T" } }
}] }
```

## Host-language type rules

Some builtins can't be captured by a data template (`pipe`, `apply`, the
effects/`Task` constructors — arity threading, heterogeneous returns, etc.).
Their callable contract still carries a portable fallback, plus an optional
namespaced rule for precision that only host-language code can provide:

```json
"pipe": {
  "signatures": [
    { "params": [{ "type": "array" }, true], "returns": true }
  ],
  "rule": "core.pipe"
}
```

The fallback always runs first: it owns overload selection, arity and broad
argument checks, contextual callback typing, and its portable result. An
available rule may add diagnostics and return a narrower result. That result
must remain inside the fallback type; otherwise the rule implementation and its
portable contract disagree.

Rule implementations are supplied through an explicit registry. A declared rule
that is unavailable leaves the fallback active and emits an information-level
coverage degradation, so `--require-full-coverage` can reject the loss of
precision without pretending a concrete fallback became `any`. Registry
composition rejects duplicate identifiers rather than choosing precedence.

### Core fallback signatures

The core contracts pin the arity, result, and broad argument shapes that are
portable. An `any`-typed argument remains exempt from a shape mismatch (a strict
`any ⊄ array` would hard-error on dynamically typed values these callables
legitimately accept):

| rule      | arity | argument shapes            | returns |
| --------- | ----- | -------------------------- | ------- |
| `core.pipe`    | 2     | arg 0: `array`             | `any`   |
| `core.apply`   | 2     | arg 1: `array`             | `any`   |
| `core.flatMap` | 2     | arg 1: `T[]`                | `any[]` |
| `core.handle`  | 2 or 3 | —                         | `any`   |
| `core.perform` | 2     | arg 0: `string`, 1:`array` | `Task`  |
| `core.pure`    | 1     | —                          | `Task`  |
| `core.bind`    | 2     | arg 0: `Task`, 1: `(any) -> Task` | `Task`  |
| `core.raise`   | 1     | —                          | `Task`  |

`Task` is the portable effect-node floor, defined in `$defs` as the tagged
record shape `{ "@task": string, ... }` (see the kernel in the language
reference). The TypeScript checker refines that floor internally with an erased
completion index: `pure(A)` produces `Task<A>`, `bind` passes `A` to its
continuation and returns the continuation's `Task<B>`, `raise` produces
`Task<never>`, and a configured effect manifest gives `perform` its result
type. Guest signatures continue to write bare `Task`, meaning completion type
`unknown`; the runtime task record is unchanged.

## What each implementation must provide

The JSON is pure data. Reading it back into working checks needs a small,
per-implementation **instantiation engine** (the algorithm, not the data):

1. Pick the first overload whose concrete arguments fit.
2. Infer type variables from those argument schemas.
3. Instantiate the parameter types and push function-typed parameters into
   inline-lambda arguments; infer any output variables from their returns.
4. Instantiate and return the result schema.

In TypeScript the fallback engine lives in
`typescript/src/check/builtin-rules.ts`; the controlled V1 rule API and core
registry live in `typescript/src/check/callable-rules.ts`. `checkModule` and
`checkExpr` install the core registry by default or accept an explicitly
composed registry. Other implementations may bundle or codegen the table and
may lack a particular rule, in which case they retain fallback checking.

### Arg-dependent returns (structural `merge`)

A few builtins keep an ordinary overload signature (good enough for argument
checking) but have a **result that depends structurally on the argument types**,
which no data template can express. After the ordinary fallback runs (so the
argument and arity diagnostics still fire), `core.merge` computes a refined
return.

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
registered under `core.merge` rather than dispatched by builtin name.
