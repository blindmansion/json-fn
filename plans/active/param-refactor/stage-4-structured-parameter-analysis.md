# Stage 4: structured parameter analysis

Source plan: [`plans/active/strict-parameter-semantics.md`](../strict-parameter-semantics.md), implementation order item 4: “refactor parameter normalization to return structured results.”

## Completion criteria

Stage 4 is complete when the canonical TypeScript implementation has one authoritative analysis of a function body's canonical `$params` representation.

That analysis must:

- return either a normalized parameter layout or a structured validation issue;
- distinguish required, optional, defaulted, rest, and object-pattern slots;
- distinguish required, optional, and defaulted object-field bindings;
- retain each slot's and field's canonical location;
- retain default expressions for later runtime evaluation, closure analysis, and static checking;
- enforce the descriptor and ordering rules established by stages 1–3;
- detect duplicate binding names across the entire parameter layout;
- never throw from the core analysis operation;
- never treat malformed descriptors as ordinary parameters or silently bind them as `any`.

The evaluator, checker, closure machinery, shorthand printer, arity introspection, and other TypeScript consumers must use the normalized layout rather than independently inspecting raw `$params`.

Runtime execution may adapt a failed result into an exception, and the checker may adapt it into a diagnostic, but both must use the same issue code, path, and message.

## Prerequisites and scope boundaries

This stage follows the first three implementation-order items and assumes their canonical forms and semantics are settled:

1. strict runtime invocation and destructuring errors;
2. the required/optional callable shape;
3. trailing positional omission and its declaration-order rule.

In particular, stage 3 owns the final canonical spelling of optional parameter and optional field descriptors. The examples below use the source plan's expected forms:

```json
{ "$param": "punct", "$optional": true }
```

and the analogous field form:

```json
{ "$field": "punct", "$optional": true }
```

If stage 3 chooses a different canonical spelling, use that spelling without changing the normalized model in this plan.

This stage does **not**:

- change which argument counts a callable signature accepts;
- remove or redesign contextual callback arity exceptions;
- add more permissive function assignability;
- type-check default expressions;
- perform static default-dependency or cycle analysis;
- change lazy runtime evaluation or memoization of defaults;
- add whole-object parameter defaults;
- add optional/default shorthand syntax not already introduced by stage 3;
- reconcile the Go, Python, or Rust implementations.

Stage 5 owns contextual callback arity. The later checker-support sequence owns local binding types, default-expression checking, shared call arity, and final function assignability.

## Current state

### Existing normalization

[`typescript/src/params.ts`](../../../typescript/src/params.ts) currently exports:

```ts
normalizeParams(params: unknown, expression: JSONType): NormalizedParam[]
```

It recognizes required, defaulted, rest, and object-pattern slots. It validates descriptor keys, rest placement, and duplicate names, but it reports every failure by calling `exprError` with the complete function expression. It has no structured result, issue code, or exact parameter path.

The `expression` argument exists only to format the thrown error. This couples otherwise pure parameter analysis to evaluator error presentation.

### Direct consumers

All current direct calls to `normalizeParams` are in [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts):

- `buildScope` binds arguments and registers pending defaults;
- `replaceVars` masks a nested body's parameter names during closure capture;
- `classifyExpressionType` validates function-body descriptors while classifying an expression.

`collectBodyLevelLocalFnRefs` in the same file separately walks raw `$params` to find local-function references in positional and field defaults.

### Duplicate readers

Other consumers implement partial and inconsistent readers:

- [`typescript/src/check/checker.ts`](../../../typescript/src/check/checker.ts)
  - `bindParams` recognizes plain names, rest names, and string-only field patterns;
  - `checkLambda`, `iifeBodyContext`, and `checkInjectedBodyArity` independently count fixed and rest slots.
- [`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts)
  - `inferLambdaReturn` independently locates a rest slot and counts fixed slots.
- [`typescript/src/utils.ts`](../../../typescript/src/utils.ts)
  - `getArity` counts the raw array and checks only whether its final string starts with `...`.
- [`typescript/src/shorthand/printer.ts`](../../../typescript/src/shorthand/printer.ts)
  - `renderParam` assumes every non-string slot is a string-only `$fields` pattern.

The checker currently ignores valid defaulted descriptors during binding and can therefore omit their local bindings. Malformed descriptors can also bypass the evaluator's validation when code is checked but not executed.

## Target result and layout

### Structured path

Parameter issue paths are relative to `$params` and use JSON-property and array-index segments:

```ts
type ParameterPath = readonly (string | number)[];
```

Examples:

```text
[]                              -> $params
[2]                             -> $params[2]
[2, "$param"]                   -> $params[2].$param
[1, "$fields"]                  -> $params[1].$fields
[1, "$fields", 0]               -> $params[1].$fields[0]
[1, "$fields", 1, "$default"]   -> $params[1].$fields[1].$default
```

Keep the internal path structured. A shared formatter converts it to the existing diagnostic style only at presentation boundaries. This avoids embedding array syntax into the data model and lets future tools consume paths without parsing strings.

### Validation issue

Define a stable issue type in [`typescript/src/params.ts`](../../../typescript/src/params.ts):

```ts
type ParameterIssueCode =
  | "params-not-array"
  | "invalid-slot"
  | "invalid-param-name"
  | "invalid-param-descriptor"
  | "invalid-fields-pattern"
  | "invalid-field-name"
  | "invalid-field-descriptor"
  | "duplicate-binding"
  | "rest-not-final"
  | "required-after-omittable";

type ParameterIssue = {
  code: ParameterIssueCode;
  path: ParameterPath;
  message: string;
};
```

Codes are for programmatic stability. Messages remain concise user-facing explanations and may include the offending binding name or expected descriptor shape.

Return the first issue in canonical left-to-right traversal order. Fail-fast analysis gives runtime and checker consumers the same deterministic result, avoids recovery rules for malformed slots, and satisfies the source plan's “layout or structured validation error” contract. Separate malformed function bodies can still produce separate checker diagnostics.

### Normalized layout

Use one slot sequence because canonical `$params` is positional and consumers frequently need source order:

```ts
type NormalizedField =
  | { kind: "required"; name: string; fieldIndex: number }
  | { kind: "optional"; name: string; fieldIndex: number }
  | {
      kind: "defaulted";
      name: string;
      fieldIndex: number;
      defaultExpression: JSONType;
    };

type NormalizedParameter =
  | { kind: "required"; name: string; index: number }
  | { kind: "optional"; name: string; index: number }
  | {
      kind: "defaulted";
      name: string;
      index: number;
      defaultExpression: JSONType;
    }
  | { kind: "fields"; bindings: NormalizedField[]; index: number }
  | { kind: "rest"; name: string; index: number };

type ParameterLayout = {
  slots: readonly NormalizedParameter[];
  fixedCount: number;
  requiredCount: number;
  omittableCount: number;
  rest: Extract<NormalizedParameter, { kind: "rest" }> | null;
};
```

The counts summarize positional slots, not object fields:

- an object pattern occupies one positional slot;
- a required object pattern remains a required positional slot even when all of its fields are omittable;
- `fixedCount` excludes rest;
- `requiredCount` is the leading required positional count established by stage 3;
- `omittableCount` is the trailing optional/defaulted positional count;
- `fixedCount === requiredCount + omittableCount`.

For a `fields` slot, add a slot-level classification if the stage-3 model permits an omittable whole object. Under the current source plan it does not: the whole object argument is required, so `fields` contributes to `requiredCount`.

Do not store a mutable `Set` of bound names in the public layout. Provide small helpers that derive names and defaults in canonical order:

```ts
boundParameterNames(layout): readonly string[]
defaultBindings(layout): readonly {
  name: string;
  expression: JSONType;
  path: ParameterPath;
}[]
```

The layout is a syntax analysis result. It must not contain checker schemas, runtime argument values, or evaluation state.

### Analysis API

Replace the throwing core with:

```ts
type ParameterAnalysis =
  | { ok: true; layout: ParameterLayout }
  | { ok: false; issue: ParameterIssue };

function analyzeParameters(params: unknown): ParameterAnalysis;
```

`undefined` means an empty parameter list, preserving the existing body representation.

Also provide:

```ts
function formatParameterPath(path: ParameterPath): string;
function formatParameterIssue(issue: ParameterIssue): string;
```

`formatParameterPath` includes the `$params` root. `formatParameterIssue` includes that path and the issue message, but not the serialized function body.

Keep a narrow evaluator adapter if it makes call sites clearer:

```ts
function requireParameterLayout(params: unknown, expression: JSONType): ParameterLayout;
```

The adapter calls `analyzeParameters`. On failure it uses `exprError(expression, formatParameterIssue(issue))` so unchecked execution remains a hard error and retains the evaluator's existing `Invalid JSON expression` prefix. The core operation itself remains non-throwing.

Do not export these APIs from the package root in this stage. They are internal interpreter infrastructure, and making them public would prematurely commit host users to the analysis representation.

## Validation rules and paths

Move every descriptor rule into `analyzeParameters`. Consumers must not add their own descriptor-validity rules.

### Top-level layout

- An absent `$params` value succeeds as an empty layout.
- Any present non-array value fails with `params-not-array` at `[]`.
- Every array entry must match exactly one stage-3 canonical slot form.
- Rest must be named and final.
- Required positional slots may not follow optional or defaulted positional slots.
- A rest slot may follow required or omittable fixed slots but nothing may follow rest.

Stage 3 should already enforce the same ordering. Stage 4 centralizes that rule rather than preserving a separate stage-3 validation pass.

### Descriptor exactness

Descriptors accept only their canonical keys:

- defaulted positional: exactly `$param` and `$default`;
- optional positional: exactly `$param` and `$optional`, with `$optional: true`;
- object pattern: exactly `$fields`;
- defaulted field: exactly `$field` and `$default`;
- optional field: exactly `$field` and `$optional`, with `$optional: true`.

A missing `$default`, a present JavaScript `undefined` default in unchecked host input, a false/non-boolean `$optional`, or extra keys is invalid. Canonical JSON cannot contain `undefined`, but the TypeScript API must reject it rather than constructing a layout that cannot be represented in JSON.

Descriptor failures point to the narrowest useful location:

- wrong descriptor keys or combinations: the slot or field-entry path;
- wrong `$param`/`$field` value: that property;
- wrong `$optional` value: `$optional`;
- invalid `$fields` value: `$fields`;
- invalid entry within `$fields`: the entry index.

### Names and duplicates

Preserve existing name rules unless stage 3 deliberately tightens them:

- a rest spelling must have a non-empty name after `...`;
- a defaulted or optional descriptor cannot encode rest through its name;
- duplicate names are invalid across positional parameters, rest, and every object-pattern field.

The duplicate issue points to the later declaration and names the earlier declaration's formatted path in its message. This is more actionable than pointing only to the whole function expression.

### Defaults

Analysis records a present `$default` expression without validating its expression form or type. Expression validity remains the general expression validator's responsibility; type compatibility belongs to the later default-checking stage.

The exact `$default` path is retained through `defaultBindings` so runtime errors, closure scanning, and later checker diagnostics can all identify the same declaration.

## Implementation plan

### 1. Replace throwing normalization with pure analysis

Primary file: [`typescript/src/params.ts`](../../../typescript/src/params.ts)

Refactor the current `normalizeParams` traversal into `analyzeParameters`:

1. validate a slot in canonical left-to-right order;
2. return a `ParameterIssue` instead of calling `exprError`;
3. track each first binding declaration by name and path;
4. construct normalized slots only after that slot is valid;
5. compute layout counts and rest metadata once;
6. expose shared name, default, path, and slot helpers.

Delete `normalizeParams` after all consumers migrate. A compatibility alias would leave two apparent APIs and preserve the old throwing contract without a caller that needs it.

Keep runtime call validation separate from descriptor analysis:

- `analyzeParameters` answers whether a declaration is well formed and what it means;
- the stage-1 argument validator answers whether a particular `args` array fits a valid layout.

The argument validator should accept `ParameterLayout` and must never inspect raw `$params`.

### 2. Analyze once before runtime scope construction

Primary file: [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts)

For a non-contract JSON function call:

- call `requireParameterLayout` before constructing locals or closures;
- pass the valid layout into the argument validator;
- pass the same layout into `buildScope`;
- bind required, optional, defaulted, field, and rest slots from normalized variants only.

`buildScope` must no longer read `fn.$params`.

Preserve:

- strict missing/extra argument behavior from stage 1;
- explicit `null` as supplied data;
- lazy and memoized defaults;
- recursive visibility among defaults, parameters, locals, and local functions;
- runtime default-cycle detection;
- escaping-closure behavior.

Runtime-contract wrappers remain a separate branch. Their synthetic body may eventually enter the same layout path, but stage 4 does not redesign contract arm selection or validation.

### 3. Replace closure-specific raw walks

Primary file: [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts)

Use `boundParameterNames(layout)` when `replaceVars` masks a nested body's bindings.

Use `defaultBindings(layout)` in `collectBodyLevelLocalFnRefs` instead of checking for `$param`, `$field`, and `$default` keys manually. Continue treating nested function bodies as scope boundaries.

If closure processing encounters a malformed nested body before that body is called, surface the same formatted parameter issue immediately. A malformed descriptor must not alter capture behavior merely because execution has not reached the function.

Add regressions for:

- a free outer variable shadowed by each parameter kind;
- a local function referenced only by a positional default;
- a local function referenced only by a field default;
- nested and escaping closures containing optional/defaulted descriptors.

### 4. Make checker body entry require a valid layout

Primary files:

- [`typescript/src/check/checker.ts`](../../../typescript/src/check/checker.ts)
- [`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts)

Add one checker adapter that:

1. calls `analyzeParameters(body.$params)`;
2. maps a failed issue to the body's existing `CheckContext` path;
3. reports `formatParameterIssue(issue)`;
4. returns `null` so that body is not checked under a fabricated parameter scope.

Do not recover by interpreting valid-looking prefixes or binding unknown slots as `any`. After the hard descriptor diagnostic, skip parameter binding and return/default checking for that body to avoid cascaded unknown-variable and type errors based on an invalid declaration.

Pass a successful layout into `buildTypeScope` and `bindParams`. Bind every normalized name against its aligned `$sig` schema:

- required, optional, and defaulted positional slots use their fixed slot index;
- rest binds as an array of the signature's rest schema;
- object fields project from the fixed slot's object schema;
- field binding kind is available for the later local-type correction, but this stage preserves the checker binding policy established before that later step.

Post-stage-2, fixed schemas always come from the shared required-then-optional callable helper. Do not reconstruct that ordering in parameter code.

Replace raw fixed/rest counting in:

- `checkLambda`;
- `iifeBodyContext`;
- `checkInjectedBodyArity`;
- `inferLambdaReturn`.

This migration changes how declaration shape is read, not the arity policy at those sites. In particular, retain any contextual fewer-parameter exception until stage 5.

### 5. Move arity introspection onto the layout

Primary files:

- [`typescript/src/utils.ts`](../../../typescript/src/utils.ts)
- the `arity` builtin tests.

`getArity` must analyze a JSON function body and return `layout.fixedCount`. A malformed body throws the same formatted invalid-expression error rather than returning a plausible count from raw array length.

This preserves the current single-number introspection contract. Whether a future arity API exposes minimum and maximum accepted counts is separate language design work; do not change the `arity` builtin's result shape in stage 4.

Native functions and builtin arity markers remain unchanged.

### 6. Make the shorthand printer consume normalized slots

Primary file: [`typescript/src/shorthand/printer.ts`](../../../typescript/src/shorthand/printer.ts)

Analyze the body's `$params` once before rendering its function header. Render each normalized variant using the syntax available after stage 3.

The printer must:

- report the same descriptor issue and exact canonical path for malformed input;
- align fixed parameter schemas with normalized fixed slot indexes;
- align the rest schema only with the normalized rest slot;
- never assume every object field is a string;
- never silently print an unsupported optional/default form as a required binding.

The parser may keep its token-aware syntax diagnostics. Its lowering output must pass `analyzeParameters`; add a parser-test assertion or internal test helper rather than running a redundant analyzer after every successful production parse.

### 7. Remove duplicate readers

After migration, search the TypeScript source for:

- direct `$params` array loops;
- `startsWith("...")` used to infer function-body layout;
- `$fields` checks outside parser lowering and `params.ts`;
- `$param` or `$field` checks outside parser lowering and `params.ts`;
- default-expression walks over raw parameter descriptors.

Review each result. Parser lowering and canonical type declarations may still mention these keys. Runtime, checker, closure, printer, and introspection consumers should not.

## Diagnostics

### Runtime

Keep the evaluator's existing outer format for invalid canonical expressions:

```text
Invalid JSON expression: <body>. $params[1].$fields[0].$field: Expected a string field name.
```

Tests should assert the path and stable message fragment, not the serialized body.

### Checker

Prefix the relative issue path with the current body's context. For a module function `main`, an invalid second field descriptor should produce a diagnostic equivalent to:

```text
main.$params[1].$fields[1].$optional
```

Use the checker's existing path-segment conventions when storing the diagnostic. The structured `ParameterPath` remains the source; formatting it into `$params[1]...` is an adapter concern.

### Printer and utilities

Throw an ordinary `Error` containing `formatParameterIssue(issue)`. Do not invent printer-specific interpretations of malformed canonical descriptors.

## Tests

### Focused analysis tests

Add [`typescript/test/params.test.ts`](../../../typescript/test/params.test.ts) for the pure operation.

Successful layouts:

- absent and empty `$params`;
- one and multiple required positional parameters;
- optional and defaulted positional parameters;
- required followed by multiple omittable parameters;
- required/omittable parameters followed by rest;
- required, optional, and defaulted object fields;
- multiple object patterns mixed with positional slots;
- fixed/required/omittable counts;
- bound-name and default-binding helper order;
- exact slot, field, and default paths.

Failures:

- present non-array `$params`;
- unknown primitive or object slot;
- missing, extra, or mixed descriptor keys;
- non-string positional or field names;
- false or non-boolean `$optional`;
- missing or `undefined` `$default`;
- empty/non-array `$fields`;
- invalid field entries;
- unnamed, non-final, or descriptor-encoded rest;
- required positional parameter after optional/defaulted;
- duplicate positional names;
- duplicate fields in one pattern;
- duplicates across patterns and positional/rest bindings.

For every failure category assert:

- `ok: false`;
- the stable issue code;
- the structured path;
- the formatted path and message.

### Evaluator regressions

Update [`typescript/test/parameter-defaults.test.ts`](../../../typescript/test/parameter-defaults.test.ts) and the stage-1 strict-runtime tests:

- preserve all valid binding and default behavior;
- assert exact paths for malformed descriptors;
- verify direct, registry, inline, program, and prepared-program paths agree;
- verify malformed nested bodies fail during closure processing;
- preserve default laziness, memoization, recursive scope, and cycle errors.

Do not duplicate the pure analyzer's exhaustive invalid-shape matrix at every runtime entry point. One representative malformed descriptor is enough to prove each adapter uses the shared result.

### Checker regressions

Update:

- [`typescript/test/check/checker.test.ts`](../../../typescript/test/check/checker.test.ts);
- [`typescript/test/check/builtins.test.ts`](../../../typescript/test/check/builtins.test.ts);
- environment/injected-body tests.

Cover:

- every valid normalized slot kind binds a local;
- object-field bindings use the matching fixed slot schema;
- malformed `$params` produces one path-specific hard diagnostic;
- malformed bodies are not subsequently checked under `any` bindings;
- direct, contextual, IIFE, builtin-callback, and injected-body paths reject the same malformed descriptor;
- existing arity behavior remains unchanged apart from using the normalized layout.

### Printer and arity regressions

Cover:

- every supported parameter variant prints and reparses without semantic loss;
- malformed descriptors fail with the shared path;
- typed fixed slots remain aligned across required and optional callable arrays;
- rest alignment remains correct;
- `arity` counts each non-rest slot once, including object patterns and omittable slots;
- malformed JSON functions do not produce an arity value.

### Verification

From `typescript/`, run:

```sh
bun test
bun run check
```

Then inspect remaining raw `$params` descriptor readers and confirm each is a producer, type declaration, parser lowering site, or test fixture rather than an independent consumer.

## Documentation updates

Update:

- [`docs/language.md`](../../../docs/language.md) — canonical parameter descriptor grammar, ordering invariants, duplicate-name rule, and required/defaulted/optional/rest/field distinctions;
- [`docs/shorthand-spec.md`](../../../docs/shorthand-spec.md) — alignment between shorthand parameter forms and canonical normalized meanings;
- [`docs/type-syntax-spec.md`](../../../docs/type-syntax-spec.md) — alignment of normalized fixed slots with `$sig.required`, `$sig.optional`, and `$sig.rest`.

Document semantic rules, not the TypeScript `ParameterLayout` interface. Other implementations should be able to implement the same analysis and issue locations without copying TypeScript-specific types.

Do not yet document default-expression type checking or claim that contextual callback exceptions have been removed.

## Files expected to change

Core analysis and runtime consumers:

- `typescript/src/params.ts`
- `typescript/src/evaluate.ts`
- `typescript/src/utils.ts`

Checker consumers:

- `typescript/src/check/checker.ts`
- `typescript/src/check/builtin-rules.ts`

Shorthand:

- `typescript/src/shorthand/printer.ts`
- parser tests or a parser validation test helper

Tests:

- a new `typescript/test/params.test.ts`
- `typescript/test/parameter-defaults.test.ts`
- stage-1 strict-runtime tests
- `typescript/test/check/checker.test.ts`
- `typescript/test/check/builtins.test.ts`
- environment/injected-body tests
- printer and arity tests

Docs:

- `docs/language.md`
- `docs/shorthand-spec.md`
- `docs/type-syntax-spec.md`

Expected unchanged:

- `typescript/src/runtime-contract.ts` contract selection and return enforcement;
- `typescript/src/stdlib.ts` callback invocation behavior;
- `spec/builtins.json`;
- callable signature validation introduced by stage 2;
- effect-manifest `params`;
- native/external JavaScript function arity;
- Go, Python, and Rust implementations.

Shared conformance cases need changes only if stage 4 standardizes user-visible malformed-descriptor errors across implementations now. Otherwise keep the exhaustive structured-result tests TypeScript-local and add cross-language cases when the other implementations adopt the same parameter grammar.

## Final verification checklist

- `analyzeParameters` is pure and returns a layout-or-issue discriminated union.
- Every issue has a stable code, exact structured path, and useful message.
- Runtime, checker, printer, and arity adapters format the same issue consistently.
- The normalized layout represents required, optional, defaulted, field, and rest semantics without checker or runtime state.
- Stage-3 ordering and duplicate-name rules exist only in the shared analyzer.
- Runtime call validation accepts a `ParameterLayout` and never reparses `$params`.
- `buildScope` binds only normalized slots and preserves lazy recursive defaults.
- Closure masking and local-function capture use normalized names and defaults.
- The checker reports malformed descriptors as hard diagnostics and never silently binds them as `any`.
- Direct, contextual, IIFE, builtin-callback, and injected checker paths use the same layout.
- `getArity` and the printer no longer infer rest or field structure from raw entries.
- No consumer outside parser lowering and `params.ts` independently branches on canonical descriptor keys.
- Contextual callback arity, default type checking, call-range checking, and function assignability remain deferred to their designated stages.
- TypeScript tests and checks pass.
