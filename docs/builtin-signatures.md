# Builtin type signatures

Status: **draft / first pass.** Currently only the TypeScript checker consumes
this; the format is being validated on a small representative set before it is
filled out for every builtin.

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

In TypeScript this lives in section F of `typescript/src/check.ts`, loaded via
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
