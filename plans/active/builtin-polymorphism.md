# Builtin polymorphism

## Goal

Builtin signatures may be polymorphic; guest `.jfn` types stay monomorphic. The
builtin type dialect is private specification data shared across implementations,
not part of the user-facing type language. This document covers making that
private dialect more complete, and the conditions under which user-authored
generics would be reconsidered.

## Context in the code

### The private builtin dialect

`spec/builtins.json` has three regions:

- `$defs` — builtin-owned named schemas (`Task`, `Match`), referenced with
  ordinary `$ref`.
- `builtins` — each name maps to either an ordered array of signatures or a
  `{ "rule": "..." }` escape hatch.

A signature is `{ typeParams?, params, rest?, returns }`. Polymorphism is
expressed with `{ "$tvar": "T" }` template nodes. `typeParams` is documentation
only — binding is driven entirely by encountering `$tvar` nodes during
unification. Overloads are tried in order; the first whose concrete (non-lambda)
arguments unify wins. Bare JSON `true` in a param position means `any`.

The checker instantiates these at each call site and no `$tvar` ever escapes
into an inferred guest type. Instantiation lives in
`typescript/src/check/builtin-rules.ts`:

- `tryBindOverload` selects an overload (lambdas deferred, args synthesized in a
  silent context).
- `unifyTemplate` binds `$tvar`s; repeated variables join with `unionOf`.
- `applyOverload` runs the real pass, contextually typing lambda bodies and
  distinguishing inferred return vars (e.g. `map`'s `U`) from checked concrete
  returns (e.g. `filter`'s `boolean`).
- `instantiate` substitutes bound variables; unbound variables become `any`.

### What `$tvar` can bind through today

`unifyTemplate` decomposes and binds through:

- bare positions (`{ "$tvar": "T" }` as a param);
- array `items` (via `elementSchemaOf`, including nested arrays and tuple
  elements — tuple elements are widened and unioned, losing positional info);
- `$fnType` params and returns.

For any other template shape it falls through to a plain compatibility check
(`isSubschema(concrete, instantiate(template, bindings))`) and binds nothing.

### The gap

Because unification does not structurally decompose tuple slots or object
properties on the **argument** side, `$tvar`s nested in `prefixItems`,
`properties`, or `additionalProperties` of an argument cannot be inferred. That
forced a set of hardcoded return computations in `CODE_RETURNS` (also in
`builtin-rules.ts`), dispatched after `applyOverload` to replace the template
return:

- `fromEntries` — value type from each `[key, value]` pair;
- `values` / `entries` — value projection from an object;
- `merge` — structural object spread (`mergeSchemas`).

`CODE_RETURNS` is TypeScript-only; it is not represented in the shared spec, so
other implementations must replicate it.

Some builtins are irreducibly beyond substitution templates and stay as
`{ "rule": "..." }` floors (`pipe`, `apply`, and the effect builtins). These are
not the target of this work.

### Def merging

The checker resolves `$ref` against a merged pool: `spec/builtins.json` `$defs`
first, then module `$types`, with module winning on a name clash
(`typescript/src/check/module.ts`). `$tvar` is never resolved through `$defs` —
it is a separate builtin-only construct.

## Plan

### A1 — Extend template matching through tuples and objects (complete)

Extend `unifyTemplate` to bind `$tvar`s reached through:

- tuple `prefixItems` (positionally) and tuple `rest`;
- object `properties` and `additionalProperties`.

This lets more builtins express an honest argument/return relationship directly
in `spec/builtins.json` instead of a per-implementation code rule.

Completed in the TypeScript checker. Structural matching now:

- resolves concrete refs and distributes over concrete unions;
- preserves homogeneous `array items T` widening while matching tuple templates
  positionally, including tuple rest;
- matches named object properties and feeds unnamed fields plus map/open tails
  into schema-valued `additionalProperties`;
- keeps the final `isSubschema` check, so binding does not relax structural
  compatibility.

Open objects bind a map value variable to `any`; closed records bind it to the
union of their applicable field types. Focused synthetic-signature tests cover
these paths without changing the shared builtin table.

### A2 — Retire code rules that become expressible

Once A1 lands, convert the `CODE_RETURNS` entries that become plain templates
(`fromEntries`, `values`, `entries`) to spec signatures and delete their
TypeScript-only logic. Keep code rules only where the return is a genuine schema
computation that no template can express — `merge` (structural spread) stays a
code rule.

Implementation note for A2: use a positional `[string, V]` tuple under array
`items` for `fromEntries`, and an object `additionalProperties: V` parameter for
`values` / `entries`. Preserve the current open-object floors when `V` becomes
`any`, delete `pairValueType` / `objectValueType` imports or helpers only after
their final callers are gone, and leave `merge` in `CODE_RETURNS`.

The language-agnostic table remains the common signature floor. It should not
grow into a general schema-programming language to eliminate small
per-implementation algorithms.

## Deferred: user-authored generics

Guest generics are not part of this work. Full guest polymorphism would require
generic syntax and a canonical representation, checking bodies under abstract
type variables, call-site inference and instantiation, semantics for
higher-order polymorphic values, variance rules if generic aliases are included,
and a decision about runtime validation of non-concrete signatures. Concrete
JSON-Schema guest types are also runtime validators today; generics break that
property.

Reconsider only when a concrete use case cannot be served by builtin
polymorphism, the effect manifest, specialized task-result indexing, or
monomorphic boundary annotations — and only alongside a typed shorthand printer,
since generic syntax is not viable for agent authors unless typed modules
round-trip. The smallest coherent first step, if reopened, is generic function
signatures instantiated to concrete schemas at each call; generic aliases and
polymorphic effect rows are separate later tiers.
