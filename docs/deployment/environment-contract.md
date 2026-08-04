# Environment contract

An environment contract is the operator-owned boundary between a json-fn
module and its host. It declares boundary schemas, direct functions, effects,
and the production entry. The contract is portable JSON and contains no
executable host code. Contract files conventionally use `.contract.json`.

## Version 1 shape

```json
{
  "version": 1,
  "$defs": {
    "UserId": { "type": "string", "pattern": "^u_" }
  },
  "functions": {
    "lookupUser": {
      "signatures": [
        {
          "required": [{ "$ref": "#/$defs/UserId" }],
          "optional": [],
          "returns": { "type": "string" }
        }
      ]
    }
  },
  "effects": {
    "log.write": {
      "params": [{ "type": "string" }],
      "returns": { "type": "null" }
    }
  },
  "entry": {
    "name": "main",
    "required": [{ "$ref": "#/$defs/UserId" }],
    "optional": [],
    "returns": { "task": { "type": "string" } }
  }
}
```

The top-level object is closed. `version` and `entry` are required. `$defs`,
`functions`, and `effects` are optional and default to empty objects. Version 1
is the only valid version.

### `$defs`

`$defs` contains schemas owned by the contract. Contract schemas refer to them
with `{"$ref": "#/$defs/Name"}`.

Builtin, contract, and module definitions share one namespace. Duplicate names
across those sources are invalid. `Task` is reserved for the built-in
`Task<A>` type constructor.

### `functions`

`functions` declares synchronous host callables. Each entry uses the callable
shape defined by the
[builtin signature registry](../builtins/builtin-signatures.md): descriptive
metadata, one or more signatures, and an optional semantic rule.

A direct function call checks its arguments before entering the host and checks
its result before returning to the module. It cannot suspend.

Contract function names must not duplicate builtin names.

### `effects`

`effects` declares capabilities that produce tasks. Each entry is a closed
object with:

- `params`: a required array of positional parameter schemas;
- `returns`: the effect's result schema.

Effects have no optional or rest parameters. Calling
`effects.log.write(message)` constructs `Task<Result>`; the host capability
runs only when task execution reaches that effect.

Effect names are non-empty. Dot-separated names form the injected `effects`
namespace, so no effect name may be a prefix of another. For example, `sensor`
and `sensor.read` cannot coexist. `raise` is intrinsic and cannot be declared.

### `entry`

`entry` is a closed object with:

- `name`: the non-empty name of a module function;
- `required`: required argument schemas;
- `optional`: trailing omittable argument schemas;
- `returns`: either a direct result schema `A` or `{"task": A}` for a task
  whose completion value is `A`.

The contract owns this boundary. The selected module function must satisfy it,
even when the module has its own `$sig`.

`effects` is a reserved top-level binding in a linked module and cannot be the
entry name. The binding is generated from the contract's effect declarations.

## Schema dialect

All contract schemas use a closed, JSON-Schema-like dialect. Unsupported
keywords are invalid.

A schema is `true` (`any`), `false` (`never`), or an object with exactly one
head keyword:

- `{"$ref": "#/$defs/Name"}` references an existing definition.
- `{"const": value}` accepts one JSON value.
- `{"enum": [value, ...]}` accepts one of a non-empty set of JSON values.
- `{"anyOf": [schema, ...]}` is a non-empty union.
- `{"$fnType": {...}}` describes a function value using `required`, `optional`,
  optional `rest`, and `returns`.
- `{"$tvar": "T"}` refers to a declared type variable. It is allowed only in
  polymorphic `functions` signatures, never in `$defs`, effects, or the entry.
- `{"type": ...}` describes a primitive or container.

Primitive types are `null`, `boolean`, `number`, `integer`, and `string`.
`type` may also be an array of distinct primitive names, with no refinements.

Number schemas may use `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, and `multipleOf`. String schemas may use `minLength`,
`maxLength`, `pattern`, and `format`.

Array schemas may use:

- `items` for homogeneous elements;
- `prefixItems` for tuple positions;
- `minItems`, `maxItems`, and `uniqueItems: true`.

Object schemas may use:

- `properties`;
- `required`, whose names must appear in `properties`;
- `additionalProperties`.

`additionalProperties: false` closes an object. A schema value describes
unlisted properties as a typed map. Omitted or `true` leaves the object open.
This differs from shorthand object types, which are closed by default.

## Linking and enforcement

Linking a contract to a module:

- combines builtin, contract, and module schema definitions without shadowing;
- combines builtin and contract function declarations without name collisions;
- verifies the entry exists and satisfies the contract;
- reserves and constructs the `effects` binding.

At execution boundaries, the host must enforce:

- entry arguments and direct results;
- direct-function arguments and results;
- effect arguments and results;
- task completion values.

A direct entry supports a pure deployment. A durable deployment requires a
task entry.

Contract validation covers JSON structure, schemas, references, names, and
collisions visible without a module. Linking adds module-level entry, binding,
and collision checks. Stable validation classifications use the failing
artifact path so equivalent hosts can report the same boundary failure.

See [Deployment profile](deployment-profile.md) for capability selection and
live or durable hosting policy.
