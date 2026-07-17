# Stage 5: contextual callback arity

Source plan: [`plans/active/strict-parameter-semantics.md`](../strict-parameter-semantics.md), implementation order item 5: “remove or redesign contextual callback arity exceptions.”

## Decision

Remove the builtin-only fewer-parameter exception.

A contextually typed callback body must declare the same structural callable
shape that the builtin declares and invokes:

- the same required positional count;
- the same omittable positional count;
- the same rest-parameter presence.

The expected callable continues to provide the schemas for those declared
slots and for the return. Contextual typing may supply types, but it must not
change which calls the body accepts.

Current higher-order builtins continue to declare the callback shape they
actually invoke. For example, `map` invokes its callback with `(value, index)`,
so its callback type has two required parameters. A callback that ignores the
index must still declare that required position:

```jfn
map((value, _index) => transform(value), values)
```

Do not redesign that callback as `(value, index?)`. Callable optionality means
the caller may omit an argument. `map` does not omit the index, so an optional
index would describe the wrong invocation contract and would not make a
one-parameter body structurally compatible under the source plan's
conservative function-assignability rule.

Changing ordinary collection builtins to invoke unary callbacks, adding
indexed variants, or adding an explicit discard-parameter syntax are separate
language/API proposals. They must change the actual runtime contract rather
than reintroduce contextual checker leniency.

## Completion criteria

Stage 5 is complete when:

- bare inline callbacks at builtin call sites no longer receive a
  fewer-fixed-parameter allowance;
- contextual callback checking compares the body's stage-4
  `ParameterLayout` with the expected stage-2 callable shape;
- a successful contextual check uses the complete expected required,
  optional, and rest schemas without slicing away trailing slots;
- callback return inference, type-variable inference, callable-rule ownership,
  and final callback validation retain their current behavior;
- named and `$sig`-annotated callback behavior remains unchanged;
- checker acceptance implies that the callback can accept the argument shape
  that the builtin supplies at runtime;
- tests and reference documentation no longer claim that a bare callback may
  omit trailing builtin-supplied arguments.

## Prerequisites and scope boundaries

This stage follows stages 1–4 and assumes:

1. unchecked runtime invocation rejects missing required arguments and extra
   non-rest arguments;
2. callable schemas use mandatory `required` and `optional` arrays plus an
   optional `rest`;
3. required positional declarations precede omittable declarations;
4. `analyzeParameters` returns an authoritative `ParameterLayout`, and all
   checker paths use it rather than recounting raw `$params`.

Stage 1 should already have migrated executable JSON callbacks to declare the
shape that each builtin actually supplies. Stage 5 closes the remaining
checker/runtime gap.

This stage does **not**:

- change any builtin's runtime callback arguments;
- add unary/indexed builtin pairs;
- mark always-supplied callback arguments optional;
- add an implicit ignored-parameter or open-tail function shape;
- add optional/default parameter shorthand;
- change direct-call or builtin-overload argument-count policy;
- implement general required/optional call-range checking;
- change conservative function assignability;
- type-check default expressions;
- change object-field local binding types;
- change runtime-contract arm selection;
- change `arity` introspection;
- reconcile the Go, Python, or Rust implementations.

The later checker-support sequence still owns shared call ranges, default
checking, local binding corrections, and final function assignability.

## Preceding state

### Runtime behavior after stage 1

Higher-order builtins invoke callbacks with complete, fixed shapes in
[`typescript/src/stdlib.ts`](../../../typescript/src/stdlib.ts):

- `map`, `filter`, `find`, `findIndex`, `some`, `every`, `count`, `flatMap`,
  `groupBy`, and `sortBy`: `(value, index)`;
- `mapValues`: `(value, key)`;
- `reduce`: `(accumulator, value, index)`;
- `sort` comparator: `(left, right)`;
- `pipe`: one value;
- `apply`: the supplied argument array.

After strict runtime validation, a one-parameter JSON body called by `map`
with two arguments is an error. There is no runtime notion of a “contextual
lambda” and no builtin callback exemption.

### Callable representation after stage 2

The corresponding callback `$fnType` in
[`spec/builtins.json`](../../../spec/builtins.json) represents the real
invocation shape. Conceptually, `map` expects:

```json
{
  "$fnType": {
    "required": [{ "$tvar": "T" }, { "type": "integer" }],
    "optional": [],
    "returns": { "$tvar": "U" }
  }
}
```

The index is required because the builtin always supplies it. The fact that a
callback body may not use a binding does not make its argument omittable.

### Structured body layout after stage 4

`analyzeParameters(body.$params)` provides:

```ts
type ParameterLayout = {
  slots: readonly NormalizedParameter[];
  fixedCount: number;
  requiredCount: number;
  omittableCount: number;
  rest: Extract<NormalizedParameter, { kind: "rest" }> | null;
};
```

Contextual callback checking must consume this result. It must not independently
scan `$params`, find a rest index, or infer counts from the raw array.

### Remaining checker exception

Today,
[`inferLambdaReturn`](../../../typescript/src/check/builtin-rules.ts) treats a
bare unannotated inline body specially:

- fewer fixed parameters than the expected callback are accepted;
- only more fixed parameters are rejected;
- expected trailing schemas are discarded when constructing the synthetic
  `$sig`;
- a declared rest parameter may collect the expected trailing schemas even
  when the expected callable itself has no rest parameter.

This is not ordinary contextual typing. It changes the body's apparent
callable shape according to one call site, applies only to builtin overloads
and callable rules, and disagrees with strict runtime invocation.

Other contextual paths are already stricter:

- `checkLambda` requires an unannotated body checked against a user function
  type to match its expected fixed/rest shape;
- `checkInjectedBodyArity` requires an environment-injected body to match its
  contextual signature;
- named and `$sig`-annotated callbacks retain their concrete function type and
  pass through ordinary function subsumption.

Stage 5 removes the builtin asymmetry.

## Structural compatibility rule

Add or reuse one checker helper that compares a successful
`ParameterLayout` with an expected callable shape:

```ts
type CallableLayout = {
  required: readonly Schema[];
  optional: readonly Schema[];
  rest?: Schema;
};

function contextualShapeMatches(
  layout: ParameterLayout,
  expected: CallableLayout,
): boolean;
```

The match succeeds exactly when:

```text
layout.requiredCount  === expected.required.length
layout.omittableCount === expected.optional.length
(layout.rest !== null) === (expected.rest !== undefined)
```

Because stage 3 guarantees a required-then-omittable order, those three checks
also align every fixed slot position. `fixedCount` may be asserted against the
combined expected fixed count as an internal consistency check, but it must not
replace the independent required/optional comparisons.

For this structural comparison:

- a required object pattern counts as one required positional slot;
- a defaulted or optional positional descriptor counts as one omittable slot;
- field optionality inside an object pattern does not affect positional arity;
- a body rest parameter matches only an expected callable rest parameter;
- an expected rest parameter cannot be synthesized for a body that does not
  declare one;
- a body rest parameter cannot be used merely to absorb trailing fixed
  arguments from a non-rest callback shape.

This is declaration-shape compatibility, not general function assignability.
Parameter contravariance and return covariance for concrete function values
remain in `subsumption.ts`. Contextual bodies have no independently declared
parameter schemas; once their layout matches, the expected schemas are pushed
into their aligned bindings.

## Implementation steps

### 1. Centralize contextual shape validation

Primary files:

- [`typescript/src/check/checker.ts`](../../../typescript/src/check/checker.ts)
- [`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts)
- [`typescript/src/params.ts`](../../../typescript/src/params.ts), only if the
  stage-4 layout needs a small neutral shape helper

Create one checker-level operation that:

1. receives an already analyzed `ParameterLayout`;
2. compares required, optional, and rest structure;
3. reports one focused diagnostic on mismatch;
4. returns a success/failure result so callers do not build a fabricated scope
   after failure.

Use the same operation, where practical, for `checkLambda` and
`checkInjectedBodyArity`. Their diagnostic wording may remain context-specific,
but they should not retain independent count logic.

Do not move schema data into `ParameterLayout`. The layout remains syntax-only;
the checker helper combines it with a callable shape at the checking boundary.

### 2. Replace the fewer-parameter branch in contextual return inference

In [`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts):

- remove the `fixed > expectedFixed` one-sided test;
- remove expected-schema slicing based on the body's shorter declaration;
- remove the special conversion of unbound trailing fixed schemas into a body
  rest schema;
- analyze the body once and apply the exact structural rule;
- on success, construct the synthetic `$sig` from the complete expected
  `required`, `optional`, `rest`, and return shape;
- bind each normalized body slot to its aligned expected schema;
- synthesize the callback return under that scope exactly as today.

Rename `inferLambdaReturn` if its old name or comments imply that it owns a
special arity policy. A name such as `contextualLambdaReturn` is sufficient;
avoid introducing another public abstraction.

Malformed parameter layouts remain stage 4 errors. Do not replace their precise
descriptor diagnostic with a generic arity mismatch.

### 3. Preserve overload inference and diagnostic suppression

The builtin overload pipeline currently defers bare contextual lambdas until
concrete arguments bind input type variables. Preserve that ordering:

1. synthesize non-contextual arguments;
2. bind and instantiate type variables;
3. contextually check callback bodies under the instantiated callable shape;
4. use callback returns to bind output variables;
5. revalidate callbacks when shared parameter/return variables widen.

Apply structural callback validation on every contextual pass, but report an
arity mismatch only once. The existing wrong-builtin-arity suppression must
remain: if the outer builtin call has the wrong number of arguments, do not
also check its callback under an underconstrained `any` scope.

Likewise, a callback shape mismatch must stop return synthesis for that
callback. Do not continue into its body with missing parameter schemas and
produce cascading unknown-variable or return-type diagnostics.

### 4. Apply the rule through callable-rule services

`contextualTypeCallback` in
[`typescript/src/check/builtin-rules.ts`](../../../typescript/src/check/builtin-rules.ts)
is also used by rules in
[`typescript/src/check/callable-rules.ts`](../../../typescript/src/check/callable-rules.ts),
including `core.bind` and `core.flatMap`.

Ensure rule-owned callbacks use the same structural comparison as portable
builtin overloads. Keep:

- declared `contextualArguments` ownership;
- exactly-once contextualization checks;
- fallback reruns that suppress diagnostics for rule-owned arguments;
- rule-specific return computations.

No callable rule may opt back into a prefix-only callback policy. If a rule
needs another callback shape, it must request that exact shape.

### 5. Keep builtin callback declarations honest

Review nested callback `$fnType` entries in
[`spec/builtins.json`](../../../spec/builtins.json) against
[`typescript/src/stdlib.ts`](../../../typescript/src/stdlib.ts).

This is a semantic audit, not a migration to optional indexes:

- arguments always supplied by the builtin remain in `required`;
- `optional` is used only if the builtin may genuinely omit that trailing
  argument on some valid invocation;
- `rest` is used only if the builtin may supply an unbounded tail;
- declared order and schema match the runtime call.

No current `(value, index)`, `(value, key)`, `(accumulator, value, index)`, or
comparator callback should change merely to preserve one-parameter source
syntax.

If the audit discovers a real declaration/runtime mismatch, fix the declaration
or runtime contract directly and add a focused test. Do not compensate in
contextual typing.

### 6. Migrate checker fixtures and examples

Stage 1 owns runtime migrations in shared conformance cases. Stage 5 must update
remaining checker-only fixtures, documentation snippets, and examples that
still depend on contextual prefix acceptance.

For a callback whose builtin supplies an unused trailing argument, prefer an
explicit, descriptive ignored name:

```jfn
filter((value, _index) => keep(value), values)
mapValues((value, _key) => transform(value), object)
reduce((acc, value, _index) => combine(acc, value), initial, values)
```

Do not use an optional descriptor: the argument is supplied. Use a rest
parameter only when the expected callback type itself has rest; under the exact
shape rule, `..._rest` is not compatible with a fixed callback tail.

Named and `$sig`-annotated callbacks should need no policy migration because
they were already checked as concrete function values. Any remaining named
one-parameter function passed to a two-parameter builtin is an existing
function-shape mismatch and needs an exact wrapper or a function declaration
with the complete callback shape.

### 7. Update diagnostics

Prefer a diagnostic at the callback argument's `$params` path that describes
both structures. For example:

```text
Contextual callback expects 2 required parameter(s), 0 optional parameter(s),
and no rest parameter; body declares 1 required parameter(s), 0 optional
parameter(s), and no rest parameter.
```

Keep the message structural:

- distinguish required from optional counts;
- distinguish rest presence;
- do not say only “at most” or imply prefix compatibility;
- do not report type mismatch terminology when only declaration shape differs.

The builtin argument path remains useful context, while the nested `$params`
path identifies the declaration to change.

## Tests

### Focused builtin contextual tests

Update
[`typescript/test/check/builtins.test.ts`](../../../typescript/test/check/builtins.test.ts)
to cover:

- exact two-required-parameter `map` callback succeeds;
- one-required-parameter `map` callback reports one structural diagnostic;
- three-required-parameter `map` callback reports one structural diagnostic;
- a body rest parameter does not match `map`'s fixed second parameter;
- an optional/defaulted second body slot does not match `map`'s required index;
- exact `(value, key)` `mapValues` callback succeeds;
- exact three-required-parameter `reduce` callback succeeds;
- omitted `reduce` index is rejected;
- exact comparator shape for `sort` succeeds;
- wrong outer builtin arity still suppresses callback cascades;
- callback return mismatches still point to `$return` after shape success;
- shared-variable revalidation still occurs for `reduce`;
- a lambda in a non-function argument position reports rather than throws.

Delete or invert the current test asserting that a bare callback may omit
trailing builtin-supplied parameters. Replace the rest-collection test with an
exact-rest contextual fixture only if a builtin or test-only callable
legitimately expects rest.

### Callable-rule tests

Cover both portable and rule-owned contextual paths:

- `core.flatMap` rejects a prefix-only callback just as its fallback signature
  does;
- `core.bind` accepts its exact unary callback;
- rule ownership still removes fallback diagnostics only for arguments the
  rule actually contextualized;
- a rule cannot bypass structural validation by constructing a shorter
  expected shape than the runtime operation invokes.

### Cross-path parity

Add a compact matrix showing that the same body layout is treated consistently
when checked as:

- a builtin inline callback;
- a callback expected by a user function type;
- an environment-injected body;
- a named or annotated concrete callback.

The contextual paths should agree on declaration shape. Concrete callbacks also
retain their ordinary parameter-type and return-type checks.

### Runtime/checker regression

For representative `map`, `mapValues`, and `reduce` callbacks:

- every callback accepted by the checker accepts the arguments the runtime
  builtin supplies;
- a prefix-only callback is rejected statically and, if executed as unchecked
  canonical JSON, rejected by stage-1 runtime validation;
- explicit ignored bindings evaluate successfully and do not alter results.

Shared conformance cases need changes only if stage 1 left a callback
underspecified. Do not add a checker-only exception to preserve an outdated
fixture.

## Documentation updates

Update:

- [`docs/builtin-signatures.md`](../../../docs/builtin-signatures.md) — replace
  the prefix-omission rule with exact structural contextual typing;
- [`docs/language.md`](../../../docs/language.md) — remove the claim that bare
  inline callbacks may omit trailing builtin-supplied arguments;
- [`docs/narrowing.md`](../../../docs/narrowing.md) — update wrapper examples so
  the wrapper itself declares the complete callback shape;
- examples and CLI snippets that show one-parameter callbacks for builtins that
  supply more arguments.

Document the distinction explicitly:

- contextual typing supplies schemas to declared bindings;
- unused bindings may be named conventionally, such as `_index`;
- omission means the caller may leave an argument out;
- not using a supplied argument is not omission.

Do not document prospective indexed builtin variants or discard syntax as if
they exist.

## Files expected to change

Core checker:

- `typescript/src/check/builtin-rules.ts`
- `typescript/src/check/checker.ts`
- possibly a small shared checker helper module

Callable declarations, only if the audit finds drift:

- `spec/builtins.json`
- `typescript/src/check/callable-rules.ts`

Tests:

- `typescript/test/check/builtins.test.ts`
- `typescript/test/check/checker.test.ts`
- callable-rule and environment tests where useful for parity
- any stage-1 strict-runtime fixture left underspecified

Docs and examples:

- `docs/builtin-signatures.md`
- `docs/language.md`
- `docs/narrowing.md`
- affected `.jfn` examples and CLI snippets

Expected unchanged:

- `typescript/src/evaluate.ts` strict call validation;
- `typescript/src/stdlib.ts` callback invocation behavior, absent a real audit
  defect;
- shorthand grammar and canonical parameter descriptor syntax;
- runtime-contract selection;
- `arity` builtin result shape;
- final function subsumption policy;
- Go, Python, and Rust implementations.

## Final verification checklist

- No builtin checker path accepts a callback declaration that the builtin's
  runtime invocation would reject for arity.
- Contextual callback bodies match required count, optional count, and rest
  presence independently.
- Always-supplied callback arguments remain required in callable signatures.
- Expected trailing schemas are never silently sliced away.
- Fixed trailing schemas are never silently converted into a body rest schema.
- Contextual return and type-variable inference remain precise after a
  successful shape match.
- Shape failures stop callback-body checking and produce one focused
  diagnostic.
- Portable overloads and callable rules enforce the same policy.
- Named and annotated callback behavior is unchanged.
- Checker, runtime, docs, and examples agree on callback invocation shapes.
- No documentation claims that bare callbacks may omit supplied arguments.
- TypeScript tests and checks pass.
