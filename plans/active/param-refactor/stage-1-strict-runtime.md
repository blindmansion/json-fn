# Stage 1: strict runtime parameter semantics

Source plan: [`plans/active/strict-parameter-semantics.md`](../strict-parameter-semantics.md), implementation order item 1: “adopt strict runtime call and destructuring errors.”

## Completion criteria

Stage 1 is complete when every canonical TypeScript JSON-function call enforces these rules at runtime, including unchecked canonical JSON:

- every required positional slot must receive an argument;
- a function without a rest parameter rejects arguments beyond its fixed slots;
- a rest parameter continues to collect all remaining arguments;
- every object-pattern slot must receive a plain object (not `null` or an array);
- a required field in an object pattern must be an own property of that object;
- omitting the whole object-pattern argument is an error, even when every field has a default;
- omitted defaulted positional parameters and absent defaulted fields still evaluate their defaults lazily;
- explicit `null` is supplied data: it suppresses a positional or field default, while `null` supplied to an object-pattern slot is a type error.

The required-field rule follows the source plan’s distinction between required, optional, and defaulted fields. There is no optional field descriptor yet, so a plain string in `$fields` is required. Allowing an absent plain field to bind `null` would preserve the ambiguity this refactor is intended to remove.

## Scope boundaries

This stage changes runtime invocation and the tests/docs that describe it. It does **not**:

- add `$optional` descriptors;
- replace `$sig.params` with required/optional arrays;
- enforce declaration ordering for trailing omittable parameters;
- perform the structured normalization-result refactor;
- redesign checker contextual-callback rules;
- enforce JSON-function parameter rules on native builtins or external JavaScript functions.

Those belong to later implementation-order items. `getArity` also remains fixed-slot introspection during this stage.

## Current execution path

All calls to a JSON function converge on the same binding path:

1. [`callFunctionInternal`](../../../typescript/src/evaluate.ts#L376-L450) resolves lexical functions, registry entries, builtins, external functions, and inline bodies.
2. Registry and inline JSON bodies enter [`callJSONFunction`](../../../typescript/src/evaluate.ts#L670-L697).
3. Non-contract bodies enter [`buildScope`](../../../typescript/src/evaluate.ts#L489-L668).
4. [`buildScope`’s parameter loop](../../../typescript/src/evaluate.ts#L548-L586) calls [`normalizeParams`](../../../typescript/src/params.ts#L30-L138), then binds arguments and fields.

The current loop is permissive in three places:

- lines 583–584 bind a missing required positional parameter to `null`;
- it never checks for arguments beyond the final fixed slot;
- lines 556–574 turn omitted/non-object patterns and missing required fields into `null`.

Runtime-contract wrappers are a separate branch in `callJSONFunction`. [`prepareRuntimeContractCall`](../../../typescript/src/runtime-contract.ts#L141-L161) already rejects contract-arm arity mismatches and should remain unchanged.

## Implementation plan

### 1. Add argument validation beside parameter normalization

Primary file: [`typescript/src/params.ts`](../../../typescript/src/params.ts)

Add a small runtime validator over `NormalizedParam[]` and `JSONType[]`. Keep descriptor validation in `normalizeParams`; do not start the stage-4 structured-error redesign here.

For each call:

1. Determine the fixed slot count and whether the final normalized slot is `rest`.
2. If there is no rest slot and `args.length` exceeds the fixed slot count, throw an exact-arity error.
3. Walk fixed slots by their existing `index`:
   - `required`: throw when `index >= args.length`;
   - `defaulted`: omission is valid;
   - `fields`: throw when omitted; when supplied, require a plain object and then require an own property for every `required` field binding;
   - `rest`: no additional validation.
4. Do not use truthiness to determine presence. `index < args.length` and `hasOwnProperty` preserve explicit `null`, `false`, `0`, and empty values.

Validate slot-by-slot rather than deriving only a numeric minimum. Until stage 3 rejects declarations such as a defaulted slot before a required slot, index-aware validation is necessary to identify which positional slot is actually absent.

Use ordinary `Error` messages, consistent with the evaluator’s existing runtime failures. Messages should include enough stable context for diagnostics and tests:

- expected exact/at-least argument count and actual count;
- one-based argument or parameter position for a missing slot;
- object-pattern position and received value kind;
- missing required field name and pattern position.

A dedicated public error class is unnecessary unless implementation work uncovers a host API that must distinguish these failures.

### 2. Validate once before constructing the scope

Primary file: [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts)

Normalize and validate at the start of the non-contract JSON-function path, then pass the normalized layout into `buildScope`. This avoids normalizing twice and ensures invalid calls fail before local-function closure construction.

Concretely:

- update [`callJSONFunction`](../../../typescript/src/evaluate.ts#L670-L697) to normalize and validate before `buildScope`;
- update [`buildScope`](../../../typescript/src/evaluate.ts#L489-L668) to accept the normalized layout rather than reading `$params` itself;
- simplify the binding loop at lines 548–586:
  - retain rest slicing;
  - retain lazy `pendingDefaults`;
  - retain own-property reads and explicit values, including `null`;
  - remove required-positional and required-field `null` repair;
  - remove the lenient non-object branch because validation makes it unreachable.

No other call entry point needs an independent gate: registry calls, inline calls, builtin callbacks into JSON functions, `callProgram`, and prepared-program entries all eventually use `callJSONFunction`.

### 3. Preserve the contract and closure paths

Relevant files:

- [`typescript/src/runtime-contract.ts`](../../../typescript/src/runtime-contract.ts#L141-L161)
- [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts#L588-L668)
- [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts#L869-L1076)

Do not change runtime-contract arm selection, lazy default evaluation, cycle detection, parameter shadowing, or escaping-closure capture. The binding refactor must keep defaults visible in the same recursive scope and must not force an unused default.

### 4. Migrate higher-order callback call sites

Primary runtime reference: [`typescript/src/stdlib.ts`](../../../typescript/src/stdlib.ts#L401-L579)

Several builtins deliberately invoke callbacks with their complete callback shape:

- `map`, `filter`, `find`, `findIndex`, `some`, `every`, `count`, `flatMap`, `groupBy`, and `sortBy`: `(value, index)`;
- `mapValues`: `(value, key)`;
- `reduce`: `(accumulator, value, index)`;
- `sort` comparator: `(left, right)`;
- `pipe`: one argument;
- `apply`: the supplied argument array.

Strict runtime validation will therefore reject a one-parameter JSON callback passed to a builtin that supplies two arguments. Do not add a hidden “builtin callback” exemption: it would violate stage 1 and defer failures based on call context.

Run the conformance suite to locate affected JSON callbacks and update declarations to the shape the builtin actually invokes, using explicit ignored parameter names or a rest parameter where appropriate. Likely migration areas include:

- [`spec/cases/higher-order.json`](../../../spec/cases/higher-order.json)
- [`spec/cases/higher-order-2.json`](../../../spec/cases/higher-order-2.json)
- [`spec/cases/search-quantify.json`](../../../spec/cases/search-quantify.json)
- [`spec/cases/objects.json`](../../../spec/cases/objects.json)
- [`spec/cases/object-helpers.json`](../../../spec/cases/object-helpers.json)
- [`spec/cases/comparison-logic.json`](../../../spec/cases/comparison-logic.json)
- [`spec/cases/escaping-closures.json`](../../../spec/cases/escaping-closures.json)
- [`spec/cases/local-recursion.json`](../../../spec/cases/local-recursion.json)

Native/external functions remain outside this validator, so only JSON function bodies require migration. Stage 5 can later align contextual checker rules and declared builtin callback types without weakening runtime behavior.

## Tests

### Focused evaluator tests

Add a focused file such as `typescript/test/strict-parameter-runtime.test.ts`, or keep the cases beside the existing default tests in [`typescript/test/parameter-defaults.test.ts`](../../../typescript/test/parameter-defaults.test.ts).

Cover:

- missing required positional argument;
- exact positional call;
- omitted defaulted positional and explicit `null`;
- extra argument without rest;
- rest with zero and multiple collected arguments;
- missing required fixed slot before a rest parameter;
- omitted object-pattern slot, including an all-defaulted field pattern;
- object-pattern argument of `null`, number, string, boolean, and array;
- missing required own field;
- inherited required field (must count as absent);
- absent defaulted own field;
- explicit `null` field suppressing its default;
- extra object keys remaining ignored;
- direct body, registry name, inline body, `callProgram`, and `prepareProgram(...).invokeEntry(...)` entry paths;
- malformed descriptors still producing the existing `Invalid JSON expression` failures;
- unused defaults remaining lazy and default/local dependency cycles retaining current behavior.

Update old permissive expectations in [`typescript/test/parameter-defaults.test.ts`](../../../typescript/test/parameter-defaults.test.ts):

- lines 28–31: required omission must throw; defaulted omission still succeeds;
- lines 116–124: preserve rest behavior, replace “ignored extra arguments” with an error;
- lines 150–167: omitted pattern and supplied non-objects must throw;
- lines 191–195: an inherited required field should throw; inherited defaulted fields should still use their default.

### Shared conformance cases

The shared runner already supports error substrings through [`typescript/test/run-cases.ts`](../../../typescript/test/run-cases.ts#L25-L38).

Add `spec/cases/strict-parameter-runtime.json` for too-few, too-many, rest, pattern-type, required-field, defaults, and explicit-null cases. Update [`spec/cases/destructured-params.json`](../../../spec/cases/destructured-params.json):

- lines 34–37: absent required key changes from `null` to an error;
- lines 49–82: number, omitted argument, `null`, and array cases change to errors;
- retain valid object binding, extra-key, mixed-slot, rest, shadowing, and arity-introspection cases.

The strict tests should assert stable message fragments, not serialized function bodies.

### Checker parity and regression checks

[`checkArity`](../../../typescript/src/check/checker.ts#L321-L332) already rejects exact-count mismatches for the current callable shape. Do not alter it in stage 1, but add runtime mirrors of its too-few/too-many cases so unchecked execution cannot silently repair calls.

From `typescript/`, run:

```sh
bun test
bun run check
```

The full test run is required because higher-order callback failures will be distributed across the shared conformance suites rather than confined to parameter tests.

## Documentation updates

The current source-of-truth docs explicitly specify permissive behavior and must change as part of stage 1:

- [`docs/language.md`](../../../docs/language.md#L232-L285): replace “missing arguments default to `null`” and lenient object-pattern rules with required/default/rest and pattern-error behavior;
- [`docs/shorthand-spec.md`](../../../docs/shorthand-spec.md#L471-L504): make the same semantic update while leaving lowering syntax unchanged.

Parser and printer cases do not need semantic changes because stage 1 does not alter canonical syntax:

- [`typescript/src/shorthand/parser.ts`](../../../typescript/src/shorthand/parser.ts)
- [`typescript/src/shorthand/printer.ts`](../../../typescript/src/shorthand/printer.ts)
- [`spec/parse-cases/destructured-params.json`](../../../spec/parse-cases/destructured-params.json)

## Files expected to change

Core:

- `typescript/src/params.ts`
- `typescript/src/evaluate.ts`

Focused tests and conformance:

- `typescript/test/parameter-defaults.test.ts`
- a new strict-runtime test file if cases are split out
- `spec/cases/destructured-params.json`
- a new `spec/cases/strict-parameter-runtime.json`
- conformance files containing underspecified JSON callbacks

Docs:

- `docs/language.md`
- `docs/shorthand-spec.md`

Expected unchanged:

- `typescript/src/check/checker.ts`
- `typescript/src/runtime-contract.ts`
- `typescript/src/utils.ts`
- shorthand parser/printer and parse cases

## Final verification checklist

- Unchecked JSON execution rejects every missing required slot/field and every extra non-rest argument.
- All JSON-function entry paths share the same errors.
- Explicit `null` remains distinguishable from omission.
- Defaults remain lazy, memoized, and recursively scoped.
- Rest collection and valid object destructuring are unchanged.
- Higher-order builtins have no runtime arity exemption, and affected JSON callbacks declare compatible shapes.
- Runtime-contract behavior remains green.
- TypeScript tests and checks pass.
- Language and shorthand reference docs no longer describe null-filling or ignored extra arguments.
