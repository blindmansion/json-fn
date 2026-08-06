# Schema conformance

## Decision

Create a separate `spec/cases/schema/` conformance corpus, beginning with the
portable subschema relation. Do not add schema-helper operations to checker
fixtures, and do not add a generic `operation` switch to the schema format.

This decision follows completion of the checker conformance migration. The
subschema verdict is observable language behavior used by assignment,
overload selection, narrowing, callback compatibility, and contract checking,
but it is not itself a checker entry point. Testing it directly avoids
constructing artificial programs and isolates relation regressions.

## Initial scope

Add:

- `spec/cases/schema.schema.json`;
- `spec/cases/schema/subsumption.json`;
- `spec/docs/conformance/schemas.md`;
- a strictly validated TypeScript fixture loader and thin runner.

Each v1 case contains:

- `description`;
- optional `comment`;
- optional `defs`;
- `sub`, the candidate subschema;
- `sup`, the candidate superschema;
- `expected`, a boolean verdict.

Reject unknown fields, unresolved references, and non-contractive definition
cycles before registering tests. File placement identifies the subsumption
operation; the format does not expose an operation discriminator.

## Migration boundary

Migrate the portable rows from
`typescript/test/check/subsumption.test.ts`, including:

- top, bottom, primitive, literal, enum, and union relations;
- numeric and string refinements;
- arrays and tuples;
- open, closed, and map objects;
- function variance and parameter-shape rules;
- valid named references, recursive structural types, and aliases to `any`.

Keep malformed-reference recovery local:

- a dangling `$ref` defensively resolving to top;
- cyclic alias-pair termination.

Portable schemas require references to resolve and recursive declarations to
be contractive, so those assertions test TypeScript robustness rather than
language conformance.

## Deferred operations

- `valueSatisfies` is a candidate for a later schema-conformance phase because
  runtime value/schema compatibility is portable behavior.
- `classifySchema` remains an implementation dispatch taxonomy.
- `unionOf` and `mergeSchemas` remain implementation normalization helpers;
  their exact output shapes are not currently normative.
- mismatch paths and explanatory reasons remain local until their portable
  representation is specified.

## Exit criteria for implementation

- malformed fixtures fail before test registration;
- the shared suite covers every valid portable relation currently asserted
  locally;
- the TypeScript runner calls only the public subschema operation;
- retained local cases are limited to malformed-input recovery;
- the conformance documentation states the relation and matching rules.
