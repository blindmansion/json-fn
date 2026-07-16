# Portable callable contracts and host-language type rules

## Goal

Let core implementations and operators describe ordinary callable types as
portable JSON while handling genuinely call-dependent typing in host-language
code. The same mechanism should cover core builtins, direct host functions, and
future host-defined higher-order functions without growing the JSON schema
dialect into a general type-level programming language.

This is the bridge between the current builtin checker and the typed environment
in [host-environment.md](host-environment.md).

## Current state

The TypeScript rule substrate is implemented. `spec/builtins.json` gives every
callable a non-empty portable `signatures` fallback and an optional namespaced
rule. `checkModule` and `checkExpr` accept an injected V1 rule registry; the
ordinary overload engine always runs before an optional rule. Core floors,
annotated `handle`, and structural `merge` now use registered `core.*` rules
rather than hardcoded name switches.

Unavailable rules preserve fallback checking and emit a coverage degradation.
Registry composition rejects duplicate IDs, and a rule result outside its
fallback raises a configuration error. `core.flatMap` is the first new
precision consumer. The remaining work is public host callable-table
composition as part of environment packaging.

## Contract model

Normalize callable entries around portable fallback signatures and an optional
namespaced rule:

```json
{
  "signatures": [
    {
      "typeParams": ["T"],
      "params": [
        {
          "$fnType": {
            "params": [{ "$tvar": "T" }, { "type": "integer" }],
            "returns": true
          }
        },
        { "type": "array", "items": { "$tvar": "T" } }
      ],
      "returns": { "type": "array" }
    }
  ],
  "rule": "core.flatMap"
}
```

Exact field names may change during implementation, but preserve these
semantics:

1. Every callable has at least one portable fallback signature.
2. The ordinary signature engine performs arity, basic argument checking,
   contextual parameter typing, and fallback result synthesis.
3. A rule is optional and identified by a namespaced stable string.
4. An available rule may add diagnostics and refine or replace the fallback
   result.
5. An unavailable rule leaves the fallback active and emits a type-coverage
   degradation.

Purely declarative builtins such as `map` have signatures only. `pipe`, `apply`,
`perform`, `bind`, and `handle` have fallback signatures plus core rules.
`merge` uses an object/object fallback plus `core.merge`. Host functions use the
same shape with operator-namespaced rules where needed.

## Rule API

Inject rule implementations into checker entrypoints rather than switching on
rule names inside `builtin-rules.ts`:

```typescript
type BuiltinTypeRuleRegistry = Record<string, BuiltinTypeRule>;
```

A rule needs controlled access to checker operations, not the entire mutable
implementation:

- synthesize an argument;
- check an argument against a schema;
- contextually type a bare callback against a function schema;
- resolve and instantiate schemas against the active definition pool;
- add a diagnostic at an argument-relative path; and
- read operator environment data relevant to the rule.

The concrete interface should be small and versioned. Rules must not mutate
checker bindings or diagnostics except through these services.

Core rules are supplied by the implementation. Hosts merge their own
namespaced rules explicitly. Collision policy should reject duplicate rule IDs
rather than silently choosing precedence.

## Portable fallback requirements

Fallbacks are not documentation-only. They ensure:

- other implementations can perform useful basic checking without the precise
  rule;
- an agent receives arity and broad parameter guidance even when a plugin is
  unavailable;
- missing host code becomes a visible degradation instead of false precision;
  and
- runtime boundary validation can use tractable portions of the contract.

A fallback may be imprecise, including an `any` return, but must be sound for
every call the rule accepts. If the fallback necessarily loses precision, its
use without the rule must produce a coverage degradation.

## Contract validation

Operator-authored tables must be validated at load time. The current
`loadBuiltinTable` now validates parsed data before returning it, and the
exported `validateBuiltinTable` applies the same check to in-memory values.
`typeParams` remains explicit semantic data and is validated against every
`$tvar` occurrence.

Validate at least:

- table and entry shape;
- non-empty fallback signature sets;
- fixed/rest parameter consistency;
- every `$tvar` is declared by `typeParams`;
- every declared type parameter is used;
- duplicate type parameters;
- `$ref` syntax and resolution against the merged definition pool;
- supported tractable schema nodes;
- namespaced rule identifiers;
- duplicate callable names during table merge; and
- configured runtime functions with no contract, and contracts with no runtime
  implementation.

Keep `typeParams` only as semantic, validated data. If explicit declarations
are not wanted, remove the field and define variables as structurally collected;
do not retain contradictory documentation and inert metadata.

The first validator slice covers the current table format: root and entry
shape, non-empty overloads, signature arity fields, the tractable schema
fragment, type-variable declaration/use, and references against table-owned
definitions. Namespaced rules and portable fallbacks arrive with normalized
entries; merge collisions, effective merged-definition validation, and
runtime/contract parity remain checks of the later composition APIs.

Likely files:

- `spec/builtins.json`
- `docs/builtin-signatures.md`
- `typescript/src/builtins.ts`
- `typescript/src/check/builtin-types.ts`
- `typescript/src/check/builtin-rules.ts`
- `typescript/src/check/context.ts`
- `typescript/src/check/module.ts`
- `typescript/src/check/checker.ts`
- `typescript/src/check/schema.ts`
- `typescript/test/check/builtins.test.ts`

## Core migration

Migrate without changing behavior first:

1. Convert overload arrays to the normalized entry shape, or support both
   shapes during a short compatibility window.
2. Move `RULE_FLOORS` into fallback signatures in `spec/builtins.json`.
3. Register existing `handle` behavior as `core.handle`.
4. Register effect floors/rules under `core.perform`, `core.pure`, `core.bind`,
   and `core.raise`.
5. Move `CODE_RETURNS.merge` to `core.merge`.
6. Keep `core.pipe` and `core.apply` at their current coarse precision.
7. Implement `core.flatMap` after the substrate migration, as specified in
   [hof-type-corrections.md](hof-type-corrections.md).

Tests should distinguish:

- behavior with a rule present;
- behavior with the rule absent but fallback present;
- unknown rule IDs;
- rule collisions;
- malformed tables; and
- fallback/rule disagreement.

## Host functions

Extend the operator-owned environment with direct callable contracts:

```typescript
type Environment = {
  $defs?: Defs;
  functions?: Record<string, CallableContract>;
  effects?: Record<string, EffectSignature>;
  entry: EntryContract;
};
```

Keep contract and implementation separate:

- `environment.functions` is portable data given to the agent and checker;
- `FunctionRegistry` contains direct runtime implementations;
- `BuiltinTypeRuleRegistry` contains optional complex static rules; and
- the capability table contains effect implementations.

Provide public APIs to:

- load and validate callable contracts;
- merge core and host contracts;
- preload them into `checkModule` / `checkExpr`;
- merge core and host rule registries; and
- compare the effective contracts with the runtime registry.

Callable-name collisions should be explicit operator errors by default. Guest
lexical/module bindings continue to shadow registry names according to the
existing language rules; contract-table merge precedence should not silently
model that runtime shadowing.

## Runtime boundaries

For ordinary tractable signatures, runtime wrappers may validate direct host
function arguments and results using `typescript/src/runtime-contract.ts`.
Effect arguments/results and entry arguments use the same validator through the
host environment.

Complex HOF rules are static host-language code. Their corresponding runtime
implementation is trusted unless the operator supplies additional runtime
validation. The portable fallback still provides boundary checks where its
schemas are concrete.

Do not duplicate schemas inside TypeScript capability or function bodies. The
environment remains the authoritative contract.

## Agent-facing behavior

- A configured agent receives core plus host callable names, schemas, and
  documentation before authoring guest code.
- A missing rule is an information-level degradation visible to
  `--require-full-coverage`.
- A malformed environment is rejected before checking guest code.
- Unknown callable names do not silently appear merely because a runtime
  registry happens to contain them.
- Machine-readable diagnostics retain expected/actual schemas and argument
  paths.

## Non-goals

- Guest-authored generic functions.
- A JSON language for arbitrary type-level computation.
- Precise `pipe` or heterogeneous `apply` typing in the portable dialect.
- Automatic generation of host-language implementation types from contracts.
- Effect completion typing itself; that remains in
  [host-environment.md](host-environment.md).

## Delivery slices

1. Contract validator and tests. ✅ done
2. Normalized entry shape. ✅ done
3. Injected core rule registry. ✅ done
4. Migration of floors, `handle`, and `merge` with no behavior change. ✅ done
5. Public merge/check APIs for host callable tables (with environment packaging).
6. `core.flatMap` precision rule. ✅ done
7. Environment integration for host functions and effect-aware core rules.

## Completion criteria

- No core type behavior depends on an unlisted builtin-name special case.
- Every rule has a portable fallback signature.
- A host can add a direct function using data only.
- A host can add a complex HOF using data plus an injected namespaced rule.
- Missing rules degrade visibly while preserving fallback checking.
- Invalid contracts fail before guest checking or execution.
- Core and host tables compose through one documented public API.
