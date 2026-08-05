# Parse conformance migration

This plan records the audit of TypeScript shorthand-parser tests and defines the
migration into the language-agnostic suites under `spec/cases/parse/`.

The target boundary is:

- portable shorthand syntax, lowering, diagnostics, and fixed structural limits
  belong in shared parse cases;
- TypeScript exception classes, object-identity side tables, parser metadata,
  caches, and static-cost preseeding remain in TypeScript tests;
- observable fuel behavior remains shared evaluator/fuel conformance, regardless
  of whether an implementation computes static costs eagerly, lazily, or not at
  all;
- printer spelling, normalization, and rejection behavior are portable but
  belong in a separate print-conformance format rather than the parse format.

## Baseline

The shared parse corpus currently contains:

- 18 suites under `spec/cases/parse/`;
- 201 cases;
- 164 successful parses;
- 37 rejected parses;
- expression and module modes;
- exact canonical JSON results, error-message substrings, and unqualified
  "must fail" cases.

TypeScript consumes the corpus through
`typescript/test/run-parse-cases.ts`, with
`typescript/test/parse-spec.test.ts` as the parse entry point.
`typescript/test/print-spec.test.ts` independently reads successful parse cases
as a printer round-trip corpus.

The current format has three weaknesses:

1. `expected` and `error` are mutually exclusive, but neither is required. The
   runner silently treats a missing outcome as `expected: null`.
2. `error` has no declared shape. A string checks a message substring; every
   other defined JSON value means only that parsing must throw.
3. The runner decodes suites with `JSON.parse` but does not validate their
   structure against `spec/cases/parse.schema.json`.

All current successful cases explicitly contain `expected`, so requiring an
outcome does not require a semantic fixture migration.

## Conformance boundary

### Shared parse conformance

Move a test into `spec/cases/parse/` when its primary assertion is one of:

- shorthand source lowers to a specific canonical JSON value;
- shorthand source is accepted or rejected;
- rejection contains a portable diagnostic message fragment;
- rejection occurs at a portable source position;
- expression/module mode changes parsing behavior;
- parsing obeys a fixed, documented language limit such as structural depth.

Structural-depth behavior is observable and fixed at 512, so its parse
boundaries belong in the shared suite.

### TypeScript-local parser coverage

Keep a test local when its primary assertion concerns:

- `ParseError` class identity rather than portable diagnostic data;
- `WeakMap`-based source-position storage or canonical-node object identity;
- static-cost metadata, preseeding, cache hits, or discovery counters;
- the internal shape or lifecycle of parser helper objects;
- TypeScript/JavaScript object insertion order where order is not part of the
  canonical JSON semantics;
- CLI argument handling or diagnostic rendering;
- checker/evaluator behavior for which parsing is only fixture setup.

Static-cost preseeding is an optimization, not parser conformance. Portable fuel
tests must assert the same observable charge, result, or exhaustion boundary
through evaluation. They must not require an implementation to attach metadata
during parsing.

### Separate future print conformance

Do not add printer switches to parse cases. A future
`spec/cases/print/` format should own:

- canonical JSON to canonical shorthand spelling;
- print failures;
- normalization-aware `parse(print(value))` round trips;
- preservation of deliberately normative declaration or binding order.

Until that format exists, keep the hand-written printer assertions in
`typescript/test/print-spec.test.ts`. Continue reusing successful parse cases as
a broad round-trip corpus.

## Parse-case format revision

Revise `spec/cases/parse.schema.json` without replacing the existing successful
case shape.

### Suite shape

Require:

- `$schema`, with the value `../parse.schema.json`;
- `description`;
- `cases`.

Continue supporting:

- suite-level `mode`, defaulting to `expression`;
- case-level `mode` overrides.

Add optional suite- and case-level `comment` fields for rationale that does not
belong in a test name.

### Outcomes

Require exactly one of:

- `expected`: the exact canonical JSON result, including explicit `null`;
- `error`: a required parse failure.

Continue accepting these error forms:

```json
{ "error": true }
```

```json
{ "error": "message substring" }
```

Add a structured form:

```json
{
  "error": {
    "messageIncludes": "expected a type",
    "at": { "line": 1, "column": 16 }
  }
}
```

Structured errors should support:

- optional `messageIncludes`;
- optional `at`;
- at least one of those assertions;
- positive integer `line` and `column`.

Define positions as one-based Unicode code-point coordinates. This matches the
current TypeScript lexer, which tokenizes with `Array.from(src)`.

Do not add a stable error-code field until the shorthand specification and
parser APIs define codes independently of diagnostic prose.

### Validation and loading

Introduce one shared TypeScript fixture loader/validator used by both
`run-parse-cases.ts` and `print-spec.test.ts`.

The validator must:

- reject missing or incorrect `$schema`;
- reject unknown suite, case, error, and position fields;
- enforce expression/module mode values;
- enforce exactly one outcome;
- validate structured error coordinates;
- produce a diagnostic containing the fixture path and failing field.

The runner should inspect portable error data without requiring
`instanceof ParseError`: extract the message from `Error` values and
duck-type numeric `line`/`col` fields for position assertions. Class-identity
coverage, if useful, remains local.

Update the runner and validator before adding the first structured-error case so
an error object cannot silently degrade to the old "any throw" behavior.

## Migration inventory

### `typescript/test/parse-spec.test.ts`

Move to `spec/cases/parse/program.json`:

- implicit module source parses without an outer object wrapper;
- an outer object wrapper is rejected in module mode.

Move to `spec/cases/parse/trailing-where.json`:

- an empty `where` block is rejected.

Remove the local historical-lowering guard after confirming the existing
"trailing where nested inside a where-binding value" shared case pins the
canonical nested `$let` shape. Its recursive rejection of historical function
locals and zero-argument binding IIFEs is migration scaffolding, not an
additional portable assertion.

Do not migrate the `Object.keys` insertion-order assertion into parse JSON.
Canonical JSON object equality does not portably assert key order, and current
`$let` bindings are order-independent. If source-order preservation is intended
as a printer guarantee, cover it in the future print suite.

After migration, `parse-spec.test.ts` should contain only the shared-suite entry
point unless a genuinely TypeScript-specific parser integration test is added.

### `typescript/test/parse-errors.test.ts`

Move the typed-lambda cases into the relevant function/type parse suite:

- three malformed return annotations, including message and line/column;
- a well-formed typed lambda;
- a curried function-type return annotation;
- a parenthesized `cond` guard that must not be mistaken for a typed lambda.

Move the task-type cases:

- bare `Task` return lowering;
- indexed `Task<string | null>` return lowering;
- rejection of general user-facing type application.

Remove the local reserved-`Task` declaration test after confirming equivalent
coverage in `spec/cases/parse/typed-modules.json`.

Remove the local repeated-ascription rejection after confirming equivalent
coverage in `spec/cases/parse/ascription.json`.

Move the function-reference cases:

- all five array-literal operand rejections;
- dynamic conditional function-reference operands;
- an indexed expression selecting a function value from an array.

Delete `parse-errors.test.ts` if no TypeScript-specific assertions remain.

### `typescript/test/structural-depth.test.ts`

Keep checker, evaluator, printer, schema, serialization, closure, and hydration
groups local to their owning subsystem.

Move the shorthand-parser assertions into
`spec/cases/parse/structural-depth.json`:

- arrays nested exactly to 512 are accepted;
- arrays nested to 513 are rejected, replacing rather than duplicating the
  existing shared rejection;
- inferred `$raw` wrapper and contained-object levels count toward the produced
  canonical tree's depth;
- the exact inferred-`$raw` acceptance and rejection boundaries are pinned.

Commit concrete JSON fixtures. If hand-authoring deeply nested values is
unreasonable, use a deterministic maintenance script to generate the fixture,
but do not add a fixture-generation mini-language to the runtime case schema.

### Tests that remain local

Retain:

- shorthand static-cost and preseeding tests in
  `typescript/test/expression-metadata.test.ts`;
- CLI conversion and checker-diagnostic tests;
- position-side-table and path-resolution tests;
- parser use inside evaluator, checker, durable-runtime, and example tests when
  parsing is setup rather than the behavior under test;
- parameter-layout analysis performed during TypeScript printer round trips.

## Implementation phases

### Phase 1: Harden the format and loader

1. Add `$schema`, `comment`, structured errors, and exact outcome requirements
   to `parse.schema.json`.
2. Add a shared typed loader and runtime validator.
3. Make parse and printer corpus runners use the shared loader.
4. Add focused validator tests for every accepted error form and representative
   malformed suites.
5. Add `$schema` to all 18 existing suites.

Exit criteria:

- every existing case loads through the validator;
- malformed outcome combinations fail before tests are registered;
- printer round-trip coverage still consumes all successful cases.

### Phase 2: Migrate ordinary parser behavior

1. Move module-wrapper and empty-`where` cases.
2. Move typed-lambda, task-type, and function-reference cases.
3. Convert malformed typed-lambda diagnostics to structured position
   assertions.
4. Remove duplicate reserved-`Task` and repeated-ascription tests.
5. Remove obsolete historical-lowering scaffolding.

Exit criteria:

- `parse-spec.test.ts` is only the shared-suite entry point;
- `parse-errors.test.ts` is removed or contains only a documented
  TypeScript-specific assertion;
- every removed local semantic assertion has a named shared replacement.

### Phase 3: Complete parse structural-depth coverage

1. Add the accepted array boundary.
2. consolidate the duplicate rejected array boundary.
3. Add inferred-`$raw` produced-tree boundaries.
4. Remove the shorthand-parser group from the subsystem-level local depth test.

Exit criteria:

- shared cases pin acceptance and rejection around every migrated boundary;
- TypeScript-local depth tests contain no direct shorthand parser conformance.

### Phase 4: Documentation and cleanup

1. Update active references that still name the former standalone parse-case
   path.
2. Document the parse-case format and source-position coordinate convention.
3. Record printer conformance as a separate follow-up rather than expanding the
   parse format.

## Verification

Run from `typescript/`:

```bash
bun test test/parse-spec.test.ts test/print-spec.test.ts
bun test test/parse-errors.test.ts test/structural-depth.test.ts
bun run check
bun test
```

If `parse-errors.test.ts` is removed during migration, omit it from the targeted
command.

Review the final test inventory manually:

- no portable source-to-canonical-JSON assertion remains only in TypeScript;
- no shared case asserts TypeScript class identity, metadata, or cache state;
- structural depth is shared;
- static-cost preseeding remains local;
- observable fuel behavior remains covered by evaluator/fuel conformance;
- parse and print concerns have not been conflated.

## Completion

The migration is complete when the shared parse corpus is the sole source of
portable shorthand parsing behavior, local TypeScript parser tests cover only
implementation representation or integration, all fixtures are validated, and
the fixed structural-depth contract is shared without exposing static-cost
metadata as language surface.
