# Stage 2: required/optional callable shape

Source plan: [`plans/active/strict-parameter-semantics.md`](../strict-parameter-semantics.md), implementation order item 2: “adopt the required/optional callable shape.”

## Completion criteria

Stage 2 is complete when the canonical TypeScript implementation represents every callable signature with this structural shape:

```ts
{
  required: Schema[];
  optional: Schema[];
  rest?: Schema;
  returns: Schema;
}
```

Specifically:

- `$fnType` schemas and function-body `$sig` nodes no longer use `params`;
- builtin and environment callable signatures use the same required/optional split;
- every existing fixed parameter migrates to `required`, with `optional: []`;
- all producers, readers, schema walkers, printers, runtime-contract adapters, and checker helpers understand the new fields;
- fixed-slot consumers use one shared `required`-then-`optional` ordering instead of rebuilding it independently;
- old `params` fields are rejected where callable schemas are validated rather than accepted as a compatibility alias;
- current programs retain their existing checker and runtime-contract behavior because this stage does not yet create semantically active optional slots.

The last point is deliberate. This stage establishes the representation before later checker work applies its arity range to calls. A non-empty `optional` array describes the eventual accepted trailing range, but canonical producers in this stage emit `optional: []`.

## Scope boundaries

This stage is a schema migration. It does **not**:

- add the canonical `{ "$param": "...", "$optional": true }` body descriptor;
- add shorthand `?` or `=` parameter syntax;
- classify existing `$default` body descriptors into signatures;
- enforce that omittable positional parameters are trailing;
- refactor `normalizeParams` to return structured validation results;
- change direct-call, builtin-overload, or runtime-contract arity from exact fixed count to a required/optional range;
- change contextual callback arity exceptions;
- implement checker bindings for defaulted or optional parameters;
- check default expressions;
- adopt the final required/optional-count function-assignability rule;
- collapse existing overloads into signatures with optional slots;
- rename unrelated `params` fields such as runtime `$params` arrays or effect-manifest argument lists.

Those changes belong to implementation-order items 3–5 or the later checker-support sequence. In particular, a builtin such as `padStart` keeps its existing two- and three-argument overloads during this stage.

## Current callable representations

The same flat fixed-parameter shape currently appears in several related formats:

```ts
{ params: Schema[]; rest?: Schema; returns: Schema }
```

- [`FnTypeShape`](../../../typescript/src/check/schema.ts#L38) represents `$fnType` and `$sig`.
- [`CallableSignature`](../../../typescript/src/check/builtin-types.ts#L6-L11) adds optional `typeParams` for builtin and environment callable tables.
- [`EntryContract`](../../../typescript/src/environment.ts#L11-L15) separately describes the environment entry with `params`.
- [`fnShape`](../../../typescript/src/check/schema.ts#L228-L235) reads `$fnType`.
- [`sigOf`](../../../typescript/src/check/context.ts#L131-L138) reads a body `$sig`.

The flat array serves two different purposes today:

1. positional schema lookup, such as `sig.params[i]`;
2. exact fixed arity, such as `argc === sig.params.length`.

The target shape separates omission capability structurally. Its eventual fixed arity range is:

```text
minimum = required.length
maximum = required.length + optional.length
```

and schemas remain positionally ordered as:

```text
[...required, ...optional]
```

Stage 2 centralizes that fixed ordering but preserves exact-count behavior over its full length. The later shared-arity checker step changes the minimum from the full fixed length to `required.length`.

## Canonical migration

### `$fnType`

Before:

```json
{
  "$fnType": {
    "params": [{ "type": "string" }],
    "returns": { "type": "integer" }
  }
}
```

After:

```json
{
  "$fnType": {
    "required": [{ "type": "string" }],
    "optional": [],
    "returns": { "type": "integer" }
  }
}
```

### Function-body `$sig`

Before:

```json
{
  "$sig": {
    "params": [{ "$ref": "#/$defs/Color" }],
    "returns": { "$ref": "#/$defs/Color" }
  },
  "$params": ["color"],
  "$return": { "$var": "color" }
}
```

After:

```json
{
  "$sig": {
    "required": [{ "$ref": "#/$defs/Color" }],
    "optional": [],
    "returns": { "$ref": "#/$defs/Color" }
  },
  "$params": ["color"],
  "$return": { "$var": "color" }
}
```

`$params` remains the runtime binding layout. `$sig.required` followed by `$sig.optional` aligns with its fixed slots; `$sig.rest` aligns with a final rest slot.

### Builtin and environment callable signatures

The language-agnostic callable-table format in [`spec/builtins.json`](../../../spec/builtins.json) uses the same inner shape plus `typeParams`:

```json
{
  "typeParams": ["T"],
  "required": [{ "$tvar": "T" }],
  "optional": [],
  "returns": { "$tvar": "T" }
}
```

Environment `functions` entries already reuse that table format. The environment `entry` contract should migrate from `params` to `required` and `optional` as well so injected entry signatures do not retain a second callable layout.

There is no backward-compatibility shim. The source plan explicitly permits canonical-format breakage, so validators should report legacy `params` as unsupported.

## Implementation plan

### 1. Define one structural model and fixed-slot helper

Primary files:

- [`typescript/src/check/schema.ts`](../../../typescript/src/check/schema.ts)
- [`typescript/src/check/builtin-types.ts`](../../../typescript/src/check/builtin-types.ts)
- [`typescript/src/check/context.ts`](../../../typescript/src/check/context.ts)

Replace `FnTypeShape.params` with mandatory `required` and `optional` arrays. Make `CallableSignature` reuse or extend that shape rather than maintaining another independent list of fields.

Add one helper such as:

```ts
function fixedParamSchemas(shape: FnTypeShape): Schema[] {
  return [...shape.required, ...shape.optional];
}
```

Use it wherever a consumer needs positional lookup or the current total fixed count. Keep the helper neutral about whether optional slots may be omitted; the later arity step can add explicit minimum/maximum helpers.

Update `fnShape` and `sigOf` to read `required` and `optional`. Both arrays are mandatory in canonical data; their defensive readers may still return empty arrays for malformed unchecked input, matching the current non-throwing checker behavior. Validation boundaries, not these internal readers, reject malformed schemas.

Update comments and `SchemaKind.FnType` examples so no internal documentation continues to advertise the legacy shape.

### 2. Update schema validation and reference walking

Primary files:

- [`typescript/src/builtins.ts`](../../../typescript/src/builtins.ts#L117-L128)
- [`typescript/src/check/schema.ts`](../../../typescript/src/check/schema.ts#L95-L142)
- [`typescript/src/check/module.ts`](../../../typescript/src/check/module.ts#L174-L227)

For `$fnType` validation:

- allow exactly `required`, `optional`, optional `rest`, and `returns`;
- require both fixed arrays and `returns`;
- validate every schema in both arrays;
- continue validating `rest` and `returns`;
- reject `params`.

Apply the same rules to callable-table signatures, additionally allowing `typeParams`.

Update `collectSchemaRefs` and `walkSigRefs` to visit both arrays in required-then-optional order. Add focused dangling-reference cases for each array so an incomplete migration cannot silently skip optional schemas.

Do not broaden this into general body-signature validation. The existing checker reads hand-authored `$sig` defensively; redesigning malformed parameter analysis and diagnostics belongs to stage 4.

### 3. Migrate shorthand type and signature producers

Primary files:

- [`typescript/src/shorthand/type-parser.ts`](../../../typescript/src/shorthand/type-parser.ts#L342-L397)
- [`typescript/src/shorthand/parser.ts`](../../../typescript/src/shorthand/parser.ts#L486-L540)
- [`typescript/src/shorthand/type-printer.ts`](../../../typescript/src/shorthand/type-printer.ts#L112-L117)
- [`typescript/src/shorthand/printer.ts`](../../../typescript/src/shorthand/printer.ts#L437-L455)

Current shorthand has no optional parameter syntax. Therefore:

- parsed function types emit every fixed schema in `required` and emit `optional: []`;
- typed function literals do the same in `$sig`;
- rest syntax continues to populate `rest`;
- type and body printers read the fixed schemas through the shared required-then-optional ordering.

A printer must not silently erase omission semantics. Until shorthand has optional syntax, reject a callable type or typed body with a non-empty `optional` array instead of printing it as an ordinary required parameter. Existing canonical output remains printable because this stage emits only empty optional arrays.

Do not add lowering from `{ "$param", "$default" }` here. The shorthand parameter grammar cannot currently produce that descriptor, and checker binding of defaults is a later step.

### 4. Migrate checker consumers without changing arity policy

Primary files:

- [`typescript/src/check/checker.ts`](../../../typescript/src/check/checker.ts)
- [`typescript/src/check/subsumption.ts`](../../../typescript/src/check/subsumption.ts#L331-L352)
- [`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts)
- [`typescript/src/check/callable-rules.ts`](../../../typescript/src/check/callable-rules.ts)

Replace direct `sig.params` and `shape.params` access with the new fields or the shared fixed-slot helper.

This includes:

- `bindParams` positional schema lookup;
- `paramAt`;
- `checkArity`;
- contextual-lambda shape construction and lookup;
- injected-body arity diagnostics;
- IIFE synthetic signatures;
- builtin overload matching, instantiation, display, and diagnostics;
- callable-rule-generated `$fnType` schemas;
- function subsumption.

Preserve current behavior in this stage:

- `checkArity` compares against the total fixed count;
- builtin overload selection does the same;
- contextual lambdas retain their current fewer-parameter allowance;
- subsumption compares the total fixed sequence and matching rest presence.

Every synthetic callable shape must nevertheless contain both arrays. Shapes synthesized from existing fixed slots use `required`; `optional` is empty.

The final conservative assignability rule compares required and optional counts independently. Implement that only in the later assignability step, alongside its focused diagnostics and tests, rather than changing checker semantics during this representation migration.

### 5. Migrate generated and injected signatures

Primary files:

- [`typescript/src/effects.ts`](../../../typescript/src/effects.ts#L90-L118)
- [`typescript/src/check/module.ts`](../../../typescript/src/check/module.ts#L85-L108)
- [`typescript/src/environment.ts`](../../../typescript/src/environment.ts)
- [`typescript/src/host.ts`](../../../typescript/src/host.ts#L225-L259)

Generated effect namespace functions keep effect-manifest `params` unchanged, but emit:

```json
{ "$sig": { "required": [/* effect params */], "optional": [], "returns": {/* Task */} } }
```

Effect manifests describe effect operations, not callable-type syntax, so renaming their own `params` field would be unrelated churn.

Migrate the environment entry contract to `required` and `optional`, update its validation, and inject that shape into the module checker. Existing environment examples use `optional: []`.

When host functions are wrapped in runtime contracts, copy both arrays into each generated `$fnType` arm. Keep runtime-contract arm selection exact over the concatenated fixed array for this stage; range selection lands with shared arity support.

Any host tuple schema that models CLI entry arguments should likewise concatenate `entry.required` and `entry.optional` in positional order. Since migrated entries have no optional slots, this does not yet change accepted CLI argument counts.

### 6. Migrate the shared callable table and fixtures

Primary data file: [`spec/builtins.json`](../../../spec/builtins.json)

Mechanically migrate each signature:

```text
params: X  ->  required: X, optional: []
```

Apply the same change recursively to callback `$fnType` schemas. Preserve:

- signature order;
- overload count and order;
- type parameters;
- parameter and return schemas;
- rest schemas;
- type-rule identifiers.

Also migrate canonical `$sig` and `$fnType` fixtures in:

- [`spec/cases/effects-handle.json`](../../../spec/cases/effects-handle.json)
- [`spec/parse-cases/handle.json`](../../../spec/parse-cases/handle.json)
- [`spec/effects.example.json`](../../../spec/effects.example.json)
- TypeScript test literals and snapshots;
- typed environment examples.

Use formatting tools after the mechanical JSON migration. Do not reinterpret optional-looking overloads or callback shapes during this pass.

## Tests

### Shape and validation tests

Update [`typescript/test/check/schema.test.ts`](../../../typescript/test/check/schema.test.ts) and [`typescript/test/builtin-table-validation.test.ts`](../../../typescript/test/builtin-table-validation.test.ts) to cover:

- valid empty and non-empty `required`;
- valid empty and non-empty `optional`;
- `rest` and `returns`;
- missing or non-array `required`;
- missing or non-array `optional`;
- rejection of legacy `params`;
- malformed schemas in each array with paths naming the correct field;
- declared type variables used only in `optional`;
- nested callback `$fnType` validation.

Add reference-walking tests showing that `$ref`s in both arrays are collected and that dangling references in either position produce diagnostics.

### Parser and printer tests

Update parse and print expectations so ordinary function types and typed functions emit:

```json
{ "required": [/* fixed */], "optional": [], "returns": {/* ... */} }
```

Cover:

- zero fixed parameters;
- multiple required parameters;
- required plus rest;
- typed object-pattern parameters;
- nested callback function types;
- printer rejection of non-empty `optional` until optional shorthand exists.

### Checker regression tests

Update callable literals in:

- `typescript/test/check/checker.test.ts`
- `typescript/test/check/subsumption.test.ts`
- `typescript/test/check/builtins.test.ts`
- `typescript/test/environment.test.ts`
- `typescript/test/runtime-contract.test.ts`
- CLI and parse-error tests containing callable schemas.

Retain existing expected behavior for arity, contextual callbacks, overload selection, and function assignability. Add a regression test for positional lookup across the shared fixed sequence, but do not add successful omitted-optional call cases yet.

### Verification

From `typescript/`, run:

```sh
bun test
bun run check
```

Then search source, tests, specs, docs, and examples for callable-shape `params` remnants. Review each result rather than replacing blindly: `$params`, effect signatures, parser-local parameter arrays, and other non-callable uses remain valid.

## Documentation updates

Update:

- [`docs/type-syntax-spec.md`](../../../docs/type-syntax-spec.md#L195-L278) — function-type lowering, `$sig` examples, positional alignment, rest examples, and object-pattern examples;
- [`docs/builtin-signatures.md`](../../../docs/builtin-signatures.md#L33-L95) — callable-table shape and examples;
- environment-format documentation and examples that describe entry or function contracts;
- checker/type-plan references that show the old `$fnType` shape.

Document the canonical required/optional split and eventual arity range, but state that optional parameter surface syntax and checker support are pending later stages. Do not copy the old claim from [`plans/type-syntax-deferred.md`](../../type-syntax-deferred.md#L101-L145) that omission is equivalent to null-filling; the strict-parameter source plan supersedes it.

The runtime parameter sections of `docs/language.md` and `docs/shorthand-spec.md` belong primarily to stage 1 and later optional/default work. Change them in stage 2 only where they show `$sig` or `$fnType`.

## Files expected to change

Core shape and validation:

- `typescript/src/check/schema.ts`
- `typescript/src/check/context.ts`
- `typescript/src/check/builtin-types.ts`
- `typescript/src/builtins.ts`

Checker consumers:

- `typescript/src/check/checker.ts`
- `typescript/src/check/subsumption.ts`
- `typescript/src/check/builtin-rules.ts`
- `typescript/src/check/callable-rules.ts`
- `typescript/src/check/module.ts`

Producers and adapters:

- `typescript/src/shorthand/type-parser.ts`
- `typescript/src/shorthand/type-printer.ts`
- `typescript/src/shorthand/parser.ts`
- `typescript/src/shorthand/printer.ts`
- `typescript/src/effects.ts`
- `typescript/src/environment.ts`
- `typescript/src/host.ts`
- `typescript/src/runtime-contract.ts`

Shared data, tests, examples, and docs:

- `spec/builtins.json`
- callable `$sig`/`$fnType` fixtures under `spec/`
- TypeScript checker, builtin, environment, runtime-contract, parser, and printer tests
- typed environment examples
- `docs/type-syntax-spec.md`
- `docs/builtin-signatures.md`
- environment-format docs

Expected unchanged:

- `typescript/src/params.ts`
- `typescript/src/evaluate.ts`
- `typescript/src/stdlib.ts`
- effect-manifest `params` format
- runtime `$params` descriptors
- shared runtime parameter conformance cases
- Go, Python, and Rust implementations

## Final verification checklist

- Every canonical `$fnType` and `$sig` uses `required`, `optional`, optional `rest`, and `returns`.
- Both fixed arrays are mandatory at validation boundaries.
- Legacy callable `params` is rejected rather than aliased.
- All migrated existing signatures put their former fixed array in `required` and use `optional: []`.
- A shared helper defines required-then-optional positional ordering.
- Schema and dangling-reference walks visit both arrays.
- Shorthand-generated callables emit empty `optional` arrays.
- Printers do not silently turn non-empty optional slots into required slots.
- Builtin overloads and contextual callback policy are unchanged.
- Checker and runtime-contract arity behavior is unchanged pending the later shared-arity step.
- Environment entries and host-generated contracts use the new shape.
- Unrelated effect and runtime parameter arrays retain their existing names.
- TypeScript tests and checks pass.
