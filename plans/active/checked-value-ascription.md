# Checked value ascription and assertion cleanup

Status: proposed.

## Summary

`examples/typed/ledger.jfn:42-44` exposes an awkward gap in the language:

```jfn
put(books, id, handle pure(merge(acct, { balance: acct.balance + delta })) -> Account with {}, msg)
```

The balance arithmetic correctly widens refined `Cents` to `integer`, so the
checker cannot prove that the updated record is still an `Account`. A runtime
contract is appropriate, but today the only checker-recognized way to establish
that contract is to wrap the value in `pure` and immediately unwrap it through
an empty total handler.

Add a direct checked type-ascription expression:

```jfn
put(
  books,
  id,
  merge(acct, { balance: acct.balance + delta }) as Account,
  msg
)
```

The expression evaluates its operand once, validates the result against
`Account`, returns the validated value, and has static type `Account`. A failed
validation raises `RuntimeContractError`.

At the same time, remove the misleading internal "cast" terminology from
postfix `!`. No compatibility constraint applies to the canonical JSON form, so
the two concepts should receive distinct, accurate representations:

```jfn
possiblyNull!       // non-null assertion
value as Account    // checked type ascription
```

```json
{ "$nonnull": { "$var": "possiblyNull" } }
```

```json
{
  "$as": { "$var": "value" },
  "$type": { "$ref": "#/$defs/Account" }
}
```

This is a new canonical expression, not shorthand for `handle(pure(...))`.
It reuses the existing runtime-contract machinery and requires a bounded new
checker case; it does not add arithmetic refinement inference or an unchecked
cast.

## Motivation

Refinements are intentionally opaque to arithmetic. Given:

```jfn
type Cents = integer & min(0)
```

an expression such as `balance + delta` has type `integer`, even if surrounding
program logic ensures that it is non-negative. The checker should not attempt
to prove arbitrary arithmetic facts. The program instead needs an explicit
boundary that tests the fact dynamically and establishes it statically after
the test succeeds.

Annotated total handlers already provide such a boundary, but only as part of
effect interpretation:

```jfn
handle pure(value) -> Account with {}
```

Keeping that as the canonical encoding would have several long-term costs:

- ordinary value validation would be represented as task interpretation;
- canonical JSON authors would have no direct expression for the operation;
- evaluation would allocate and normalize an unnecessary task;
- printer recognition would depend on an incidental `handle(pure(...), {})`
  pattern; and
- other implementations would see effect machinery rather than the actual
  language concept they need to implement.

The current canonical `$cast` name is also inaccurate. Postfix `!` does not cast
or convert a value; it checks for `null` and removes `null` from the inferred
type. A general checked ascription does not have the same static behavior, so
overloading `$cast` with an optional schema would make the representation less
precise.

## Goals

- Provide a direct runtime-checked boundary from an expression to a named or
  inline type.
- Give the successful expression exactly the declared type to the checker.
- Preserve intentional widening of refinements through arithmetic.
- Evaluate the operand exactly once.
- Return data unchanged after successful validation.
- Support higher-order function contracts consistently with existing typed
  boundaries.
- Raise `RuntimeContractError` on contract failure.
- Give non-null assertion and checked ascription distinct canonical forms.
- Share contract-schema validation across ascription, annotated handlers, and
  host/environment boundaries.
- Preserve canonical parse/print round trips.

## Non-goals

- Inferring arithmetic refinements statically.
- Introducing an unchecked or representation-changing cast.
- Converting values between primitive or structural types.
- Adding flow-sensitive narrowing facts for the ascribed operand.
- Treating `as` as evidence about later uses of the original variable.
- Making `Task<T>` completion contracts directly inspectable without running
  the task.
- Bringing the Go, Python, or Rust implementations to parity in this change.

## Terminology and semantic model

The language has two related but distinct checked assertions.

### Non-null assertion

```jfn
x!
```

The result type is derived from the operand:

```text
T | null  ->  T
```

At runtime it rejects `null` and otherwise returns the value. Its canonical
form is:

```json
{ "$nonnull": expression }
```

The existing `$cast` canonical key, `Cast` TypeScript type, and
`ExpressionType.Cast` member are removed rather than retained as aliases.

### Checked type ascription

```jfn
x as T
```

The result type is explicitly supplied by the author. At runtime it validates
the value against `T`; statically the result has type `T`. Its canonical form
is:

```json
{
  "$as": expression,
  "$type": schema
}
```

The operation is called an ascription because it gives an expression a declared
type, and "checked" because that claim is enforced at runtime. It is not a cast:
it neither converts data nor asks the checker to trust an unchecked claim.

The two forms share runtime checking infrastructure, but not an AST shape,
because one computes a type transformation from the operand while the other
supplies an explicit target type.

## Surface syntax

Add:

```ebnf
ascription := logical-or ( "as" type )?
expression := ascription
```

`as` remains a contextual identifier token. The lexer does not need a new token
kind.

Ascription binds less tightly than the existing logical and arithmetic
operators:

```jfn
balance + delta as Cents
```

means:

```jfn
(balance + delta) as Cents
```

It does not mean:

```jfn
balance + (delta as Cents)
```

This requires a parser level above `parseOr`; it must not be added directly to
the current call/access/`!` postfix loop. Parentheses remain available when the
author wants a narrower operand:

```jfn
balance + (delta as Cents)
```

The initial grammar makes ascription non-associative. Repeated checks must be
parenthesized:

```jfn
(x as A) as B
```

Postfix non-null assertion continues to bind tightly:

```jfn
x! as T
```

is valid, while applying `!` after an ascription requires parentheses:

```jfn
(x as T)!
```

## Canonical JSON

### Non-null assertion

The evaluator classifier accepts exactly one property:

```json
{ "$nonnull": expression }
```

`$nonnull` with sibling properties is malformed.

### Checked ascription

The evaluator classifier accepts exactly these two properties:

```json
{
  "$as": expression,
  "$type": schema
}
```

If either reserved key is present, both must be present and there may be no
other properties. `$type` contains the schema directly. It is not wrapped in
`$raw`: the wrapper is only needed when a schema travels through an ordinary
evaluated call argument, as it currently does in the three-argument `handle`
builtin.

Add corresponding TypeScript representations:

```typescript
type NonNullAssertion = {
  $nonnull: JSONType;
};

type CheckedAscription = {
  $as: JSONType;
  $type: JSONType;
};
```

`CheckedAscription.$type` is structurally `JSONType` in the core expression
module to avoid coupling core expression types to checker schema modules.
Classifier, checker, and runtime validation establish that it is a supported
schema.

## Static semantics

### Non-null assertion

Rename the existing checker node kind from `"cast"` to `"nonnull"`. Its
behavior remains:

1. synthesize the operand;
2. remove `null` from the synthesized schema; and
3. return the resulting schema.

### Checked ascription

Add an `"ascription"` checker node kind. Synthesis:

1. synthesizes the operand so nested type errors and coverage degradation are
   still reported;
2. validates that `$type` is in the runtime-contract schema fragment;
3. collects all `$ref` names and reports references absent from `ctx.defs`; and
4. returns `$type` as the synthesized type of the whole expression.

The checker deliberately does **not** require:

```text
typeOf(operand) <= ascribedType
```

That test would reject the motivating `integer` to `Cents` boundary. The
runtime contract is the evidence that establishes the stronger type.

The checker also does not add a special contextual-checking path. Existing
synthesize-then-subsume behavior is sufficient, so:

```jfn
put(books, id, updated as Account, msg)
```

synthesizes the third argument as `Account` and then checks it normally against
the parameter type.

No narrowing fact is attached to the source expression or variable:

```jfn
x as Account
```

types that expression as `Account`; it does not change the type of later,
separate uses of `x`.

### Contract-schema fragment

Extract and rename `isTractableHandleSchema` from
`typescript/src/check/callable-rules.ts` to a shared schema/contract helper, for
example:

```text
typescript/src/schema/contract.ts
```

The helper should describe support in terms of runtime contracts rather than
handlers. Both checked ascription and annotated-handler checking use it.

The supported fragment remains the one already accepted for annotated handler
results:

- `any` and `never`;
- named references;
- scalar constants and enums;
- unions;
- primitive schemas and their supported refinements;
- arrays and tuples;
- closed objects and typed maps; and
- function types, including nested supported contracts.

`Task<T>` remains excluded. Its `T` parameter describes eventual completion,
but a task value is an inert record whose completion cannot be validated
without running it. Opaque schemas also remain excluded.

## Runtime semantics

Evaluation of checked ascription:

1. evaluates `$as` exactly once;
2. validates `$type` and its references against the active runtime definitions;
3. calls the shared runtime-contract enforcement path;
4. returns the checked value; or
5. raises `RuntimeContractError` labeled as a checked-ascription failure.

Conceptually:

```typescript
const value = evaluateExpression(ascription.$as, context);
return enforceRuntimeContract(
  value,
  ascription.$type,
  context.runtimeDefs ?? {},
  "checked ascription",
);
```

Named types resolve through the same merged runtime definition pool used by
annotated handlers and environment boundaries.

For first-order JSON data, successful validation returns the original value.
For function types, the existing higher-order contract behavior applies:

```jfn
f as (Input) -> Output
```

produces a serializable contract proxy that validates eventual arguments and
return values. This is intentionally not representation identity, and the
language documentation must state that function ascription installs a wrapper.

Runtime contract validation does not perform type conversion. For example,
`"1" as integer` fails rather than producing `1`.

## Contract subsystem cleanup

Keep one runtime implementation for all concrete type boundaries. The shared
API should cover:

- immediate data validation;
- named-reference resolution;
- higher-order function wrapping;
- function argument and return checks; and
- consistent `RuntimeContractError` construction.

The existing `typescript/src/runtime-contract.ts` is the implementation base.
The change should not create a second validator in the evaluator or checker.

Annotated handlers retain their distinct semantics:

- total effect coverage;
- result-type-driven contextual typing of clauses and `resume`; and
- rejection of unmatched effects.

They should reuse the shared contract-schema predicate and runtime enforcement,
but should not lower through the new ascription AST. Conversely, checked
ascription should not lower through `handle`.

## Parser and printer

### Parser

In `typescript/src/shorthand/parser.ts`:

- make `parseExpr` enter a new `parseAscription` level;
- parse the operand with the existing `parseOr`;
- recognize contextual keyword `as`;
- parse the target with the existing type parser; and
- emit `{ $as: operand, $type: schema }`.

The existing postfix `!` lowering changes from `$cast` to `$nonnull`.

### Printer

In `typescript/src/shorthand/printer.ts`:

- print `$nonnull` as postfix `!`;
- print checked ascription as `<expression> as <type>`;
- use the existing type printer for `$type`;
- add an ascription precedence below logical-or precedence; and
- parenthesize operands and surrounding contexts to preserve the parse tree.

Printer recognition is direct from the dedicated canonical nodes. It must not
recognize or emit the old `handle(pure(...), {}, raw(...))` workaround as
ascription.

## Implementation stages

### Stage 1: Shared contract-schema support

1. Extract `isTractableHandleSchema` into a shared contract-schema module and
   rename it.
2. Update annotated-handler checker logic to use the shared helper.
3. Add focused tests that preserve existing accepted and rejected handler
   annotation behavior.

This stage should be behavior-preserving.

### Stage 2: Canonical assertion forms

1. Replace `Cast`/`ExpressionType.Cast` with
   `NonNullAssertion`/`ExpressionType.NonNullAssertion`.
2. Replace canonical `$cast` recognition and evaluation with `$nonnull`.
3. Add `CheckedAscription` and `ExpressionType.CheckedAscription`.
4. Extend the evaluator classifier with exact shape validation.
5. Add evaluator dispatch that calls `enforceRuntimeContract`.
6. Add `"nonnull"` and `"ascription"` checker node kinds.
7. Add the ascription synthesis rule.

There is no compatibility alias for `$cast`; tests, docs, and internal producers
are updated atomically.

### Stage 3: Shorthand and examples

1. Change postfix `!` lowering and printing to `$nonnull`.
2. Add the `as` parser precedence level.
3. Add canonical printing of checked ascription.
4. Replace the ledger's empty-handler workaround with `as Account`.
5. Confirm parse/print normalization and CLI `to-json`/`to-shorthand` behavior.

### Stage 4: Documentation and conformance

1. Replace `$cast` with `$nonnull` in the canonical language reference.
2. Document checked ascription next to non-null assertion.
3. Add the `as` grammar and precedence to the shorthand specification.
4. Update the type-syntax specification's list of positions where type
   expressions appear.
5. Add shared parse cases and TypeScript evaluation/checker tests.

## Expected file changes

Core representation and evaluation:

- `typescript/src/types.ts`
- `typescript/src/eval/expression-type.ts`
- `typescript/src/eval/interpreter.ts`
- `typescript/src/runtime-contract.ts` if a small shared API or error-label
  cleanup is useful

Checker and schema support:

- `typescript/src/check/ast.ts`
- `typescript/src/check/checker.ts`
- `typescript/src/check/callable-rules.ts`
- a new shared helper such as `typescript/src/schema/contract.ts`

Shorthand:

- `typescript/src/shorthand/parser.ts`
- `typescript/src/shorthand/printer.ts`
- possibly `typescript/src/shorthand/type-printer.ts` only if exposing the
  existing type renderer requires a small refactor

Documentation and examples:

- `docs/language.md`
- `docs/shorthand-spec.md`
- `docs/type-syntax-spec.md`
- `docs/narrowing.md`
- `examples/typed/ledger.jfn`

Tests and shared conformance:

- `typescript/test/check/checker.test.ts`
- `typescript/test/evaluate.test.ts`
- `typescript/test/runtime-contract.test.ts`
- `typescript/test/cli-check.test.ts` where CLI coverage is useful
- `spec/parse-cases/operators.json` or a dedicated ascription parse-case file
- an appropriate `spec/cases/` evaluation case file

`typescript/src/task.ts` should require no semantic change: annotated handlers
already call the shared runtime-contract implementation. `spec/builtins.json`
should not change because checked ascription is a canonical expression, not a
builtin.

## Test plan

### Canonical form and classification

- `$nonnull` accepts exactly one property.
- `$as` and `$type` are both required and reject sibling properties.
- malformed canonical nodes fail as expression errors rather than becoming
  ordinary data objects.
- `$cast` is no longer recognized as an expression form.

### Parsing and printing

- `x!` lowers to `$nonnull`.
- `x as Account` lowers to a named-reference schema.
- inline object, union, array, tuple, refined, and function types round-trip.
- `a + b as Cents` ascribes the entire addition.
- `a + (b as Cents)` preserves the narrower operand.
- `x! as T` and `(x as T)!` round-trip.
- repeated ascription requires explicit parentheses.
- canonical printback followed by parsing returns the same canonical JSON.

### Checker

- successful ascription synthesizes the declared type.
- the operand is still traversed and reports nested errors.
- an operand need not statically subsume the target type.
- undefined named types are diagnosed.
- malformed, opaque, and task-result schemas are rejected.
- ascription satisfies a context expecting the declared type.
- ascription does not narrow later uses of a source variable.
- non-null assertion preserves its current remove-`null` behavior.

### Runtime data contracts

- valid primitive, refined, array, tuple, object, map, union, and named values
  pass.
- invalid values raise `RuntimeContractError`.
- refinements such as `min(0)` and `pattern(...)` are enforced.
- the operand is evaluated exactly once.
- no primitive or structural conversion occurs.
- named references use active module/environment definitions.

### Runtime function contracts

- function ascription installs a callable wrapper.
- valid arguments and returns pass.
- invalid arguments and returns raise `RuntimeContractError`.
- wrapped functions remain serializable and callable through the normal
  evaluator path.

### Regression

- annotated total handlers retain their static and runtime behavior.
- environment entry, direct-function, and effect contracts remain unchanged.
- the ledger checks and evaluates with direct `as Account`.
- all existing postfix `!` behavior is preserved through `$nonnull`.

## Acceptance criteria

- The ledger uses direct checked ascription and no longer needs
  `handle pure(...) -> Account with {}`.
- `.jfn` supports `expression as Type` with the specified precedence.
- canonical JSON uses `$as`/`$type`.
- postfix `!` uses canonical `$nonnull`; `$cast` is removed.
- successful data ascription returns the original value and exposes the
  declared static type.
- failed ascription raises `RuntimeContractError`.
- function ascription enforces argument and return contracts.
- checked ascription, annotated handlers, and host boundaries share contract
  schema support and runtime enforcement.
- parser/printer, evaluator, checker, runtime-contract, and ledger regression
  tests pass.
- `bun run check` and `bun test` pass in `typescript/`.
