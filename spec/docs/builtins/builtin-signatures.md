# Builtin signature registry

`spec/builtins/builtins.json` is the type registry for json-fn builtins. It defines
portable callable signatures and names the semantic rules needed when a result
cannot be expressed by those signatures alone.

This document specifies the registry dialect and the behavior that the JSON
structure cannot express.

`spec/builtins/builtins.schema.json` describes the registry's JSON shape for
editors and other JSON Schema tooling. The implementation validator remains
authoritative for semantic constraints such as reference resolution and
type-variable scope and use.

## Registry shape

```json
{
  "$schema": "./builtins.schema.json",
  "description": "optional registry description",
  "$defs": {
    "Name": { "type": "object" }
  },
  "builtins": {
    "name": {
      "description": "optional builtin description",
      "category": "optional catalog category",
      "signatures": [
        {
          "typeParams": ["T"],
          "required": [{ "$tvar": "T" }],
          "optional": [],
          "rest": { "$tvar": "T" },
          "returns": { "$tvar": "T" }
        }
      ],
      "rule": "namespace.rule"
    }
  }
}
```

- `description` and `category` are descriptive metadata.
- `$defs`, when present, contains registry-owned named schemas. References use
  `{"$ref": "#/$defs/Name"}`.
- `$schema` associates the registry with its colocated JSON Schema.
- `builtins` maps each builtin name to one or more signatures.
- `rule` names an additional type rule.

Registry, contract, and module definitions share one namespace during checking.
Duplicate names across those sources are invalid.

The root, builtin entries, signatures, and schema nodes are closed structures:
unknown fields are invalid. `builtins` is required. Builtin names are
non-empty. Builtin descriptions and categories, when present, are non-empty.
Every builtin has at least one signature. References must resolve within
`$defs`, and rule names have at least two dot-separated identifier segments.

## Signatures

A signature has the same parameter shape as `$fnType`, with an optional
`typeParams` field:

- `required` lists fixed required parameters.
- `optional` lists trailing omittable parameters.
- `rest`, when present, is the element schema for the variadic tail.
- `returns` is the result schema.
- `typeParams` declares the type variables bound by the signature.

All fields except `rest` and `typeParams` are required. Parameter and result
schemas use the schema dialect defined by the
[environment contract](../deployment/environment-contract.md#schema-dialect),
plus builtin type variables.

### Type variables

`{"$tvar": "T"}` refers to a variable declared by the containing signature's
`typeParams`. Declarations are unique, and every declared variable is used.
Variables are bound independently at each call and do not escape into the
resulting schema.

Matching follows variables through:

- homogeneous array items;
- tuple positions and tuple rest items;
- object properties and schema-valued additional properties;
- function returns.

Function parameters constrain compatibility but do not infer bindings.
Repeated occurrences of a variable contribute a normalized union. Union
arguments are matched arm by arm and their contributions are joined.

For an object map template, concrete properties not named by the template
contribute to its additional-properties variable. A closed record contributes
the union of those property types, a typed map contributes its value type, and
an open object contributes `any`.

Structural inference is followed by the ordinary schema compatibility check.
It does not relax tuple lengths, required properties, or open-object rules.

### Overload resolution

Signatures form an ordered overload set.

1. Remove signatures that cannot accept the call's arity or statically known
   non-lambda arguments.
2. Treat `any` as unknown evidence: it neither rejects an overload nor binds a
   type variable.
3. When known evidence establishes an overload, preserve declaration order.
   When `any` leaves several overloads possible, retain every possible result
   and report degraded type coverage.
4. Infer type variables, instantiate parameter schemas, and contextually check
   an inline lambda when its expected function type is unambiguous.
5. Infer variables from the lambda's return, instantiate each possible result,
   and return their normalized union.

For example, the ordered integer and number overloads of `add` preserve
`integer` for two integer arguments. `add(any, 1)` returns `number`, the union
of its possible overload results, while `length(any)` returns `integer`.

### Contextual callbacks

A bare inline lambda without `$sig` receives the function schema expected at
its argument position. Its required, optional, and rest parameter counts must
match that schema exactly.

Variables produced by a callback return join with bindings from other
arguments. If that join widens a variable also used by the callback's
parameters, the callback is checked again under the final joined type. This
ensures, for example, that a `reduce` callback accepts every accumulator type
that a later iteration can produce.

A `$sig`-annotated lambda or function reference is a concrete function value.
Its declared signature is preserved and checked after call-site variables are
resolved. Function parameters are contravariant: a callback may accept a
broader input than the builtin supplies, but not a narrower one.

The ordinary array higher-order builtins use item-only callbacks.
Their `*Indexed` forms append an integer index. `reduce` uses
`(accumulator, item)` and `reduceIndexed` appends the index.

## Semantic rules

Some builtin types depend on argument structure, callback results, effect
contracts, or function composition. Their entries contain both portable
`signatures` and a namespaced `rule`.

The signatures always establish arity, broad argument compatibility,
contextual callback types, and a portable result. The named rule may add
diagnostics and return a more precise result. Its result must be a subtype of
the selected signature's result.

A rule may own specified contextual argument positions. An owned position is
checked once under the rule's context; all other fallback checks remain in
force. Ownership may cover a top-level bare lambda or a composite value
containing contextual lambdas. It does not cover function references or
`$sig`-annotated lambdas unless the rule explicitly handles those concrete
values.

A semantic-rule registry contains at most one definition for each identifier.
If a named rule is unavailable, the portable signatures remain authoritative
and the call reports degraded type coverage.

### `core.flatMap` and `core.flatMapIndexed`

The callback may return a scalar, an array, or a union of both. Scalar returns
contribute their own type; array returns contribute their item type. The result
is an array of the joined contributions after one level of flattening. A nested
array therefore remains an array element.

`flatMap` supplies `(T) -> any` as the callback floor.
`flatMapIndexed` supplies `(T, integer) -> any`.

### `core.merge`

`merge(a, b)` returns the structural object spread `{ ...a, ...b }`, with `b`
winning conflicts.

For each property, `b` supplies the type when it guarantees that property.
Otherwise the result joins contributions from `a` and `b`, and the property is
required only when `a` guarantees it. Additional properties follow these
rules:

- an open `b` makes the result open;
- a map-shaped `b` joins its value type with contributions from `a`;
- a closed `b` inherits the additional-properties behavior of `a`.

Object unions distribute across their arms. An `any` or non-object operand
reduces precision to `any` or the bare `object` floor as applicable.

### Task rules

The `$defs.Task` schema is the portable task-record floor. Task-aware rules
also track an erased completion type:

- `pure(A)` returns `Task<A>`;
- `bind(Task<A>, (A) -> Task<B>)` returns `Task<B>`;
- `raise(value)` returns `Task<never>`;
- `perform` uses the declared effect result when one is available.

Guest signatures may use `Task<A>` to preserve the completion type across
function boundaries. Bare `Task` means `Task<any>`. The completion type does
not change the runtime task record.

## Static boundaries

- String callback names accepted at runtime are not resolved as typed function
  references. Checked callbacks use inline lambdas or typed references.
- `filter` and `find` do not infer type predicates from callback bodies.
- `groupBy` returns `{ [string]: T[] }`; numeric callback keys are represented
  as strings, and exact group keys are not tracked.
- `mapValues` returns `{ [string]: U }`; exact input keys are not preserved by
  its portable type.
- `reReplaceWith` requires its callback to return `string`.

Type coverage records loss of static precision separately from type errors.
An `any` result does not satisfy a concrete expected type by itself; a
constrained use still requires an explicit checked boundary.
