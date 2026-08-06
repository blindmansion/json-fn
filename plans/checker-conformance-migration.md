# Checker conformance migration

This plan defines a language-agnostic conformance format for the json-fn type
checker and records the migration boundary for the existing TypeScript checker
tests.

## Status

Completed for the canonical `spec/` language on 2026-08-06. The shared corpus
lives under `spec/cases/check/`, its adapter contract is documented in
`spec/docs/conformance/checking.md`, and TypeScript runs it through
`typescript/test/check-spec.test.ts`. Remaining direct checker calls are
implementation-unit, parser, runtime-integration, or example-validation tests.
The separate schema-algorithm decision is recorded in
`plans/schema-conformance.md`: create a dedicated corpus beginning with
subsumption, while keeping helper normalization details implementation-local.

The target boundary is:

- observable checking of canonical expressions and modules belongs in shared
  cases under `spec/cases/check/`;
- inferred types and checker diagnostics are portable outputs;
- standard builtin typing and portable environment-contract integration belong
  in shared cases;
- internal synthesis contexts, narrowing fact maps, AST classification,
  callable-rule registry mechanics, and JavaScript representation details
  remain in TypeScript unit tests;
- shorthand parsing, source-position mapping, CLI rendering, and process exit
  behavior remain integration concerns rather than canonical checker
  conformance.

## Goals

- Give every implementation one corpus for the observable behavior of the type
  checker.
- Organize checker coverage by language feature rather than by TypeScript source
  unit.
- Make inferred schemas, hard errors, and visible coverage degradation
  independently assertable.
- Exercise the standard builtin registry and portable environment contracts
  without exposing host-language callable-rule implementations.
- Leave the TypeScript suite focused on implementation units, adapters, and
  integration boundaries.
- Validate fixtures strictly before registering tests.

## Non-goals

- Do not make shorthand parsing part of the initial checker-case format.
- Do not standardize CLI output, exit codes, or source-position rendering here.
- Do not expose `CheckContext`, narrowing fact maps, callable-rule registries, or
  other TypeScript checker internals through the conformance adapter.
- Do not define stable diagnostic codes until the language specification and
  checker APIs define them.
- Do not require implementations to use the TypeScript checker's traversal
  order, recovery strategy, or internal schema helpers.
- Do not combine direct schema-algorithm conformance with program-checking cases
  in the first format revision.

## Historical baseline

Before the migration, the canonical checker was implemented under
`typescript/src/check/`.

Its public program-checking entry points are:

- `checkExpr`, which returns an inferred `type` and accumulated `diagnostics`;
- `checkModule`, which returns accumulated `diagnostics`.

A diagnostic currently contains:

- `path`: a canonical JSON path represented as string segments;
- `message`;
- `severity`: `error` or `info`;
- optional `expected` and `actual` schemas.

An `error` is a definite type failure. An `info` records visible loss of type
coverage, including fallback to `any`. The CLI's full-coverage policy is derived
from those information diagnostics; it is not a separate checker result.

Before migration, most observable checker behavior lived in:

- `typescript/test/check/checker.test.ts`;
- `typescript/test/check/builtins.test.ts`;
- `typescript/test/check/chess.test.ts` (removed after migration);
- `typescript/test/let-check.test.ts`;
- the `contract checker integration` block in
  `typescript/test/contract.test.ts`;
- checker-specific portions of `function-body-structure.test.ts`,
  `structural-depth.test.ts`, and `special-object-keys.test.ts`.

There was no shared checker corpus at the start of this work.

## Conformance boundary

### Shared checker conformance

Move a test into `spec/cases/check/` when its primary assertion is one or more
of:

- a canonical expression synthesizes a particular schema;
- a canonical expression or module produces no diagnostics;
- checking produces a particular portable diagnostic;
- diagnostic recovery finds a complete set of independent errors;
- checking records a visible type-coverage degradation;
- bidirectional checking accepts or rejects an expression against contextual
  types;
- flow narrowing changes the observable result of checking a branch, local, or
  match case;
- a standard builtin has a particular observable static type or call behavior;
- a portable environment contract changes module-entry, callable, or effect
  checking;
- checking obeys a fixed language limit such as structural depth.

Cases must use canonical json-fn JSON. If an existing test uses shorthand only
as fixture setup, convert the parsed result to canonical JSON during migration.

### TypeScript-local checker coverage

Keep a test local when its primary assertion concerns:

- direct construction or mutation of `CheckContext`;
- direct behavior of `synth`, `check`, or another internal function under a
  hand-built context that cannot be represented as a complete expression or
  module;
- the exact fact maps returned by `factsFromCondition`, `matchCaseFact`, or
  related narrowing helpers;
- AST node classification;
- callable type-rule registration, ownership, merging, dispatch injection, or
  TypeScript exception classes;
- JavaScript own-property or prototype behavior of an in-memory schema object;
- diagnostic formatting, source-position lookup, command-line arguments, exit
  codes, or process streams;
- parser lowering where checking is not the sole behavior under test;
- runtime evaluation, durable execution, or example loading where checking is
  only one assertion in a broader integration test.

An internal test may remain local even when an end-to-end shared case covers the
same semantic feature. The two tests protect different boundaries.

### Separate schema-algorithm conformance

The following operations are language-agnostic in principle but are not checker
entry points:

- the subschema relation;
- schema classification;
- schema union normalization;
- object-schema merging;
- testing whether a concrete value satisfies a schema.

Do not add an `operation` switch for these to the checker-case format. After the
program-checking migration, decide which operations are normative language
behavior. A separate `spec/cases/schema/` format can then cover those operations
without coupling checker adapters to TypeScript helper APIs.

The subschema relation is the strongest candidate for a shared schema suite.
`classifySchema` and the exact output of `mergeSchemas` or `unionOf` may remain
implementation details unless their normalization is specified.

## Checker-case format

Add `spec/cases/check.schema.json` and recursively load suites from
`spec/cases/check/`.

### Suite shape

Require:

- `$schema`, with the value `../check.schema.json` for a suite directly below
  `check/`;
- `description`;
- `builtins`, explicitly selecting `standard` or `none`;
- `cases`.

Support:

- optional suite-level `comment`;
- optional suite-level `options`;
- case-level overrides for `builtins` and `options`.

If nested suite directories are used, either give their fixtures the correct
relative `$schema` value or constrain suites to one directory level. The loader
must verify the declared schema path rather than accepting any string.

### Inputs

Each case requires exactly one of:

```json
{
  "expression": {
    "$nonnull": {
      "$if": true,
      "$then": 1,
      "$else": null
    }
  }
}
```

```json
{
  "module": {
    "main": {
      "$params": [],
      "$sig": {
        "required": [],
        "optional": [],
        "returns": { "type": "integer" }
      },
      "$return": 1
    }
  }
}
```

The expression and module values are canonical json-fn trees. Do not add
`source`, parser mode, or source positions to the initial format.

An expression case may optionally provide `defs` if checking an isolated
expression against named schemas is a required public operation. Prefer a
module with `$types` when it represents the same language behavior, so the
fixture exercises normal type-definition scope.

### Environment and options

The `builtins` field has two values:

- `standard`: load the portable registry from
  `spec/builtins/builtins.json`;
- `none`: provide no builtin callable table.

Do not embed implementation-specific callable tables or type-rule registries in
fixtures.

A case may contain an inline `contract` using the portable environment-contract
format. Contracts apply only to module cases. The runner passes the contract
through the ordinary checker/linker entry point rather than reconstructing
contract behavior in the test adapter.

The initial portable options object supports:

- `allowUntypedFunctions`.

Do not put CLI policy such as `requireFullCoverage` into checker options.
Full-coverage success or failure is derived by consumers from the presence of
`info` diagnostics.

### Successful and diagnostic outcomes

Every ordinary case contains:

```json
{
  "expected": {
    "type": { "type": "integer" },
    "diagnostics": []
  }
}
```

`diagnostics` is required and represents the complete expected diagnostic
multiset. This ensures that a fixture cannot pass while the checker emits an
unasserted error or degradation.

`type` is:

- allowed only for expression cases;
- optional, so a case can focus on diagnostics when recovery typing is not
  portable or relevant;
- compared by exact canonical JSON equality when present.

Do not add a separate `valid` field. Validity is derived from whether the
diagnostic set contains an `error`. Do not add a separate `coverage` field.
Coverage degradation is represented by `info` diagnostics.

### Diagnostic matching

An expected diagnostic has:

- required exact `path`;
- required exact `severity`;
- required `messageIncludes`;
- optional exact `expected`;
- optional exact `actual`.

For example:

```json
{
  "path": ["f", "$return"],
  "severity": "error",
  "messageIncludes": "not assignable",
  "expected": { "type": "integer" },
  "actual": { "const": "wrong" }
}
```

Compare diagnostics as an unordered multiset. Each expected matcher must consume
exactly one actual diagnostic, and every actual diagnostic must be consumed.
Path and severity are exact, `messageIncludes` is a substring assertion, and
present schema fields are exact JSON assertions.

Ignoring order avoids making implementation traversal order normative while
still rejecting missing, duplicate, and additional diagnostics.

Do not support permissive `allowAdditionalDiagnostics` or partial-list modes.
If implementations legitimately disagree about whether a diagnostic is
required, resolve that language-design question rather than weakening the
fixture.

Do not add exact diagnostic messages or stable codes initially. Message
substrings match the existing parse, evaluator, and builtin conformance
practice without freezing incidental prose.

### Portable throws

The checker normally reports malformed programs through diagnostics. Permit a
separate outcome only for failures that occur outside recover-and-continue
checking, such as a fixed structural-depth limit:

```json
{
  "throws": {
    "messageIncludes": "maximum structural depth"
  }
}
```

Require exactly one of `expected` and `throws`. Do not use `throws` merely
because the current TypeScript implementation happens to throw for a condition
that should have a portable diagnostic.

### Validation and loading

Follow the hardened parse-suite pattern:

- add a typed loader and runtime validator;
- reject missing or incorrect `$schema`;
- reject unknown suite, case, option, expected, throw, and diagnostic fields;
- enforce exactly one input;
- enforce exactly one outcome;
- reject contracts on expression cases;
- reject `type` expectations on module cases;
- validate diagnostic paths, severities, and schema-bearing fields;
- include the fixture path and failing field in loader errors.

The JSON Schema and runtime validator must encode the same rules. Add focused
validator tests so schema drift cannot silently broaden the fixture language.

The conformance adapter must use public checker and linker entry points. It must
not import `CheckContext`, direct narrowing helpers, or callable-rule registry
composition utilities.

## Final corpus organization

Organize by language behavior:

```text
spec/cases/check/
  expressions/*.json
  functions/*.json
  modules/*.json
  locals/*.json
  narrowing/*.json
  builtins/*.json
  contracts/*.json
  limits/structural-depth.json
  programs/chess.json
```

The runner recurses over this tree. Keep suites large
enough to express a coherent behavior and small enough that fixture ownership
is obvious. Do not reproduce the TypeScript test-file layout.

## Migration inventory (historical)

### `typescript/test/check/checker.test.ts`

Move the observable `checkExpr` and `checkModule` coverage:

- literal and data synthesis;
- non-null assertions;
- checked ascription;
- visible `any` degradation;
- clean module checking;
- module diagnostics and recovery;
- primitive-predicate narrowing exercised through modules;
- bidirectional object and array literals;
- branch-arm checking;
- contextually typed unannotated lambdas;
- inline function calls;
- recursive type contractivity;
- dangling references;
- typed named-function requirements and the untyped migration option;
- declared return enforcement through the expression entry point.

Keep direct internal-context blocks local:

- field projection over a union;
- computed index and key projection;
- missing closed-object-field synthesis;
- control-flow union synthesis;
- value-returning short-circuit synthesis;
- the ascription test that manually constructs a `CheckContext`.

Where practical, add shared end-to-end versions of those internal cases by
placing the expression inside a complete function, local scope, or module.
Retain the direct unit tests when they still provide useful localization.

### `typescript/test/check/builtins.test.ts`

Move observable standard-builtin typing:

- concrete and overloaded signatures;
- builtin references as function values;
- array generics;
- higher-order builtins;
- structural type-variable binding;
- callback return binding;
- object utilities;
- fallback floors and visible degradation;
- contextual lambda typing;
- builtin behavior through module checking;
- effect-related behavior expressible through a portable contract.

Keep local:

- injected namespaced type rules;
- rule ownership and callback dispatch assertions;
- rule-registry merge behavior;
- duplicate-rule and ownership exception classes;
- tests requiring a custom implementation-owned callable table.

If a custom table currently stands in for a generally useful language feature,
add equivalent coverage through a portable contract or standard builtin rather
than adding arbitrary table definitions to fixtures.

### Former `typescript/test/check/chess.test.ts`

The migration moved all portable chess fragments:

- coordinate-layer checking;
- nullability and narrowing;
- lazy locals and named boolean guards;
- field-path and discriminant narrowing;
- match exhaustiveness and dead cases.

They now live under `check/programs/chess.json`, with individual descriptions
preserved even where common module fragments are expanded in JSON.

Do not add a fixture macro or inheritance language solely to make these cases
shorter. Checked-in canonical programs are the conformance artifacts.

### `typescript/test/let-check.test.ts`

Move:

- canonical `$let` validation and result typing;
- malformed outer shapes;
- recursive and transitive local scope;
- cycles and recursive functions;
- unannotated local behavior;
- narrowing through named boolean guards;
- lazy-local creation and forcing behavior;
- callback, parameter, capture, and shadowing boundaries;
- function captures;
- structural inline calls.

For tests currently constructed with `parse(...)`, separate the concerns:

- move canonical checker behavior after converting the shorthand result to
  checked-in JSON;
- retain a small local parser/checker integration test only when the path
  mapping produced by shorthand lowering is itself the assertion.

### `typescript/test/contract.test.ts`

Move the `contract checker integration` block:

- contract entry signature injection;
- parameter and completion mismatches;
- malformed entry parameters;
- direct-value and task-valued entries;
- contract callables;
- effect namespaces and handlers;
- guest bindings that shadow contract-related names.

Keep contract validation, runtime integration, and capability-admission tests
with their owning subsystems.

### `typescript/test/function-body-structure.test.ts`

Move checker-observable structural-boundary cases:

- stray function-body fields;
- continued checking through supported fields;
- malformed supported fields;
- unannotated-body rejection;
- module-root behavior.

Keep direct `analyzeFunctionBodyStructure` tests and evaluator exceptions local.

### `typescript/test/structural-depth.test.ts`

Move checker acceptance and rejection at the documented structural-depth
boundary into `check/limits/structural-depth.json`.

Retain parser, printer, evaluator, schema, serialization, closure, and hydration
depth tests in their owning suites until each subsystem has an appropriate
shared format.

Commit concrete deep JSON fixtures. A deterministic maintenance script may
generate them, but the checker-case format must not gain a depth-expression
mini-language.

### `typescript/test/special-object-keys.test.ts`

Move checker-observable handling of special keys when it can be expressed as a
canonical program and portable diagnostics.

Keep:

- own-property helper tests;
- `Object.hasOwn` assertions on TypeScript schema objects;
- prototype and in-memory object-representation assertions.

Schema satisfaction for special keys belongs in a future shared schema suite,
not the checker suite.

### `typescript/test/cli-check.test.ts`

Do not move CLI assertions directly. Keep coverage for:

- command-line input selection;
- JSON versus shorthand flags;
- source-position rendering;
- JSON diagnostic rendering;
- stdout and stderr;
- exit codes;
- positional-path hints;
- wiring of coverage and migration flags.

Move or deduplicate the underlying checker semantics into shared cases. After
migration, CLI tests should be a focused adapter suite rather than a second
checker behavior corpus.

### `typescript/test/check/narrowing.test.ts`

Keep the direct narrowing-helper tables local because they assert internal fact
maps rather than checker outputs.

Ensure shared end-to-end cases cover the corresponding observable forms:

- truthiness;
- primitive predicates;
- equality and literal exclusion;
- discriminant paths;
- boolean composition;
- named guards;
- match-case and match-else narrowing;
- cases where no valid fact can be derived.

Do not delete the local helper tests merely because end-to-end coverage exists.

### Schema-helper tests

Do not migrate these into checker cases:

- `typescript/test/check/subsumption.test.ts`;
- `typescript/test/check/schema.test.ts`;
- `typescript/test/check/values.test.ts`.

Audit them in the separate schema-conformance follow-up. Until then they remain
TypeScript unit tests.

### Tests that remain local

Retain:

- `typescript/test/check/ast.test.ts`;
- direct fact-map tests in `check/narrowing.test.ts`;
- direct `synth` tests with hand-built contexts;
- callable-rule registry and exception tests;
- CLI and source-position integration;
- runtime portions of contract and example tests;
- example-file loading tests whose main purpose is end-to-end deployment or
  durable execution.

Checker-only assertions in large example tests may later move if their modules
and contracts are committed as canonical portable fixtures. This is lower
priority than migrating the focused checker suites.

## Implementation phases

### Phase 1: Define and validate the format (completed)

1. Add `spec/cases/check.schema.json`.
2. Add a typed checker-case loader and runtime validator under
   `typescript/test/`.
3. Add validator tests for:
   - expression and module inputs;
   - standard and absent builtins;
   - options and contracts;
   - empty and populated diagnostics;
   - inferred types;
   - portable throws;
   - every invalid input/outcome combination;
   - unknown fields and incorrect `$schema` paths.
4. Document exact unordered diagnostic matching.

Exit criteria:

- malformed fixtures fail before tests are registered;
- JSON Schema and runtime validation accept and reject the same focused sample
  corpus;
- the adapter surface contains no TypeScript checker internals.

### Phase 2: Add the runner and seed cases (completed)

1. Add a checker conformance runner and a thin test entry point.
2. Load standard builtins from the shared registry only when selected.
3. Pass contracts and portable checker options through public entry points.
4. Implement exact inferred-type equality.
5. Implement exact unordered diagnostic matching.
6. Seed each major outcome:
   - clean expression synthesis;
   - clean module checking;
   - hard error;
   - information-level degradation;
   - multiple recovered diagnostics;
   - structural-depth throw.

Exit criteria:

- both checker entry points are exercised through shared fixtures;
- additional, missing, and duplicate diagnostics cause test failures;
- builtin-free and standard-builtin suites run through the same adapter.

### Phase 3: Migrate core checker and local-scope behavior (completed)

1. Migrate portable blocks from `check/checker.test.ts`.
2. Migrate portable blocks from `let-check.test.ts`.
3. Migrate checker-specific function-body-structure cases.
4. Add end-to-end narrowing cases corresponding to the local fact-map groups.
5. Remove migrated local assertions while preserving genuine internal unit
   tests.

Exit criteria:

- core expression, function, module, narrowing, and local-scope semantics have
  named shared cases;
- no removed local assertion lacks a named shared replacement;
- direct-context and fact-map unit tests remain local and focused.

### Phase 4: Migrate builtins, contracts, and programs (completed)

1. Migrate standard builtin typing by behavior category.
2. Migrate contract checker integration.
3. Migrate the chess fragments.
4. Migrate the checker structural-depth boundary.
5. Migrate portable special-key and function-body cases.
6. Reduce duplicate CLI semantic coverage to adapter smoke tests.

Exit criteria:

- standard builtin typing is tested without implementation-owned fixture hooks;
- contract entry, callable, and effect checking have portable coverage;
- chess remains a coherent realistic checker corpus;
- CLI tests no longer serve as the only coverage for checker semantics.

### Phase 5: Audit and follow-ups (completed)

1. Search TypeScript tests for direct `checkExpr` and `checkModule` calls.
2. Classify every remaining call as unit, integration, example, or an
   intentionally retained duplicate.
3. Document the reason beside non-obvious retained tests.
4. Decide whether to create `spec/cases/schema/`, beginning with subsumption.
   Decision: yes; scope and migration boundary are recorded in
   `plans/schema-conformance.md`.
5. Update documentation maps and obsolete references.

Exit criteria:

- portable checker behavior has one shared source of truth;
- TypeScript-local checker tests have an explicit implementation or integration
  purpose;
- schema-algorithm conformance has a recorded decision rather than being
  accidentally mixed into checker fixtures.

## Verification

Run from `typescript/`:

```bash
bun test test/check-spec.test.ts
bun test test/check/checker.test.ts test/check/builtins.test.ts
bun test test/check/narrowing.test.ts
bun test test/let-check.test.ts test/contract.test.ts
bun test test/function-body-structure.test.ts test/structural-depth.test.ts
bun test test/cli-check.test.ts
bun run check
bun test
```

Adjust targeted paths as local files are removed or reduced.

Review the final inventory manually:

- canonical expression and module behavior is shared;
- inferred schemas and every emitted diagnostic are asserted;
- information diagnostics remain distinct from hard errors;
- no fixture depends on TypeScript exception identity or checker internals;
- no checker case depends on shorthand parsing or CLI rendering;
- standard builtins come from the portable registry;
- contracts use the portable contract format;
- diagnostic traversal order is not accidentally normative;
- schema-helper behavior has not been smuggled into the checker adapter.

## Completion

The migration is complete when `spec/cases/check/` is the source of truth for
portable checker behavior, all fixtures are strictly validated, TypeScript
consumes the corpus through public checker entry points, and the remaining local
tests cover only implementation units, adapters, integrations, or deliberately
documented end-to-end examples.
