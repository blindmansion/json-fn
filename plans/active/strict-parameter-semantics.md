# Strict parameter semantics

Status: runtime and representation foundations complete; checker support planned
below.

## Overall goal

Make function calls and parameter declarations strict, explicit, and simple to
implement consistently across languages. Invalid calls should fail directly
instead of being repaired through implicit `null` values or context-specific
arity rules. Defaults and optionals should be the only ways to omit arguments.

This favors clear diagnostics for AI-authored programs and a small portable
semantic model over permissive or highly flexible function compatibility.

## Change policy

There is no internal or external backward-compatibility requirement for this
work. Prefer the clearest language design even when it requires broad changes to
canonical forms, implementations, documentation, or tests; minimizing churn is
not a goal.

Existing tests record previous assumptions, not permanent requirements. As
these semantics change, reconsider failing tests and update or delete them when
their assumptions no longer match the intended language. Preserve tests only
when they still express behavior this plan deliberately retains.

## Decisions

### 1. Strict runtime invocation

- Missing required arguments are errors.
- Extra arguments are errors unless a rest parameter accepts them.
- Supplying a non-object to an object parameter pattern is an error.
- Explicit `null` is a supplied value, not an omission.

The evaluator and checker should agree on which calls are valid, including when
canonical JSON is executed without first being checked.

### 2. Trailing omittable parameters

Positional parameters must appear in this order:

1. required parameters;
2. optional or defaulted parameters;
3. an optional final rest parameter.

A required parameter after an omittable parameter is invalid. This avoids
positions that cannot be omitted independently and makes accepted arities
obvious. Object fields are named and do not need this ordering restriction.

### 3. Structural callable arity

Replace the current callable shape:

```ts
{ params: Schema[]; rest?: Schema; returns: Schema }
```

with an explicit required/optional split:

```ts
{
  required: Schema[];
  optional: Schema[];
  rest?: Schema;
  returns: Schema;
}
```

This represents the accepted arity range directly without parallel `minArgs`
metadata. Default expressions remain implementation details in the function
body; the ability to omit an argument is part of the callable type.

Plain optional parameters need an explicit canonical body descriptor, such as:

```json
{ "$param": "punct", "$optional": true }
```

Nullability alone must not imply omission because a required parameter may
legitimately accept `null`.

### 4. Conservative function assignability

Initially, assignable function types must have the same:

- required parameter count;
- optional parameter count;
- rest-parameter presence.

Parameter types remain contravariant and return types covariant within that
matching shape. More permissive callable-range subtyping can be considered only
if real programs require it.

Contextual builtin callbacks should not have separate arity exceptions. A
builtin should declare the exact callback shape it invokes, or expose a distinct
builtin or overload for another shape.

### 5. One structured parameter analysis

Refactor parameter normalization into a shared operation that returns either:

- a normalized required/optional/defaulted/rest/field layout; or
- a structured validation error with the exact parameter or field path.

The evaluator, checker, printer, closure machinery, and other TypeScript
consumers should use this model. Malformed descriptors are hard errors, not
reasons to degrade to `any`. The same normalization rules should be specified
for every implementation.

### 6. Precise object-field bindings

Object parameter fields use these rules:

- required property without a default binds as `T`;
- optional property without a default binds as `T | null`;
- optional property with a valid default binds as `T`;
- a default on a required property is an error because it is unreachable in a
  checked call;
- omitting the whole object argument is an error unless whole-object defaults
  are introduced separately;
- explicit `null` is accepted only when the property schema permits it.

This separates the caller's input-property requirements from the type of the
local binding after destructuring and defaulting.

### 7. Static checking of every default

Every default expression is checked against its binding schema, even if runtime
demand never evaluates it. Defaults are checked in the function body's
recursive scope and may reference parameters, fields, body locals, and local
functions.

Diagnostics should point directly to the relevant `$default`. Runtime
memoization, laziness, and cycle detection remain runtime concerns; the checker
does not need static dependency-cycle analysis.

## Implementation order

Before extending the checker for defaults:

1. adopt strict runtime call and destructuring errors;
2. adopt the required/optional callable shape;
3. enforce trailing positional omission;
4. refactor parameter normalization to return structured results;
5. remove or redesign contextual callback arity exceptions.

Then implement checker support:

1. bind normalized defaulted and optional descriptors;
2. correct optional-field local binding types;
3. check default expressions;
4. apply the shared arity model to direct calls, builtins, inline functions,
   environment-injected functions, and contextual lambdas;
5. update function assignability and add focused diagnostics and tests.

## Checker support implementation plan

### Scope

This phase changes only the TypeScript checker over canonical, lowered
JSON/AST. It assumes parameter descriptors and callable signatures have already
been produced and validated in their canonical forms.

In scope:

- aligning a successful `ParameterLayout` with a `$sig` or contextual callable
  shape;
- assigning precise local types to required, optional, defaulted, field, and
  rest bindings;
- statically checking every default expression;
- applying required/optional/rest arity ranges at checker call sites;
- enforcing the same declaration shape for annotated bodies, contextual
  lambdas, builtin callbacks, and environment-injected bodies;
- updating conservative function assignability;
- checker-focused tests and reference documentation needed to describe these
  semantics.

Out of scope:

- shorthand parsing, lowering, printing, or round-trip tests;
- adding shorthand syntax for optional or defaulted parameters;
- changing canonical parameter descriptor forms;
- evaluator behavior, runtime default laziness, memoization, or cycle
  detection;
- changing builtin runtime callback arguments;
- whole-object parameter defaults;
- static default-dependency or cycle analysis;
- Go, Python, or Rust.

Expected unchanged implementation files include
`typescript/src/shorthand/parser.ts`,
`typescript/src/shorthand/printer.ts`, and their tests.

### Current checker state

The preparation work leaves the checker with the right raw building blocks:

- `typescript/src/params.ts` exposes `analyzeParameters`, a normalized
  `ParameterLayout`, exact slot and field locations, and retained default
  expressions.
- `typescript/src/check/schema.ts` represents callables as separate
  `required`, `optional`, and optional `rest` schemas. `fixedParamSchemas`
  provides their required-then-optional positional sequence.
- `typescript/src/check/checker.ts` analyzes a body once and passes its layout
  into parameter binding, contextual checking, IIFE checking, and injected-body
  checking.
- `typescript/src/check/builtin-rules.ts` also analyzes contextual callback
  bodies through the shared checker adapter.

The remaining behavior is intentionally incomplete:

1. `bindParams` aligns all normalized names with signature positions, but it
   gives optional positional and optional field bindings their supplied-value
   schema rather than adding the `null` produced by omission.
2. Defaults are retained by the layout but are never checked by the checker.
3. `checkArity`, overload trial matching, and IIFE arity still use total fixed
   count as the minimum, so non-empty `optional` arrays do not yet create an
   accepted argument range.
4. `checkLambda` and `checkInjectedBodyArity` compare only total fixed count and
   rest presence. They do not distinguish required from omittable slots.
5. Annotated bodies are not generally checked to ensure their `$params`
   required/optional/rest structure agrees with their own `$sig`.
6. `inferLambdaReturn` still permits a bare builtin callback to declare a
   prefix of the fixed parameters the builtin supplies and can reinterpret the
   remainder as a body rest parameter.
7. `fnSubsumes` requires equal total fixed counts but does not independently
   require equal required and optional counts.

These are one connected soundness boundary. For example, a `$sig` with one
required and one optional schema currently permits neither a one-argument call
nor a precise nullable local, while a body with two plain required descriptors
can incorrectly claim that signature. Implement the pieces together rather
than temporarily making calls permissive without validating declarations.

### Semantic invariants

#### Callable shape agreement

Use one checker-level structural comparison between a `ParameterLayout` and a
callable shape. It succeeds exactly when:

```text
layout.requiredCount  === shape.required.length
layout.omittableCount === shape.optional.length
(layout.rest !== null) === (shape.rest !== undefined)
```

This comparison applies to:

- a body and its own `$sig`;
- an unannotated lambda and its expected function type;
- an environment-injected body and the injected signature;
- a bare contextual builtin or callable-rule callback and its expected
  function type.

A required object pattern counts as one required positional slot. Optional and
defaulted fields inside that object do not affect positional callable shape.

Do not use total fixed count as a substitute for the separate required and
optional comparisons. Shapes `(required: 1, optional: 1)` and
`(required: 2, optional: 0)` have the same fixed count but different valid
calls.

#### Accepted call range

For a callable shape:

```text
minimum arguments = shape.required.length
fixed maximum     = shape.required.length + shape.optional.length
```

- without rest, accept every count from the minimum through the fixed maximum;
- with rest, accept every count greater than or equal to the minimum;
- supplied arguments first fill required slots, then optional slots, then rest;
- omission is only trailing; an explicit `null` remains a supplied argument and
  is checked against the slot schema.

The callable signature stores the schema of a supplied optional argument. The
local binding adds `null` to represent omission; the call-site schema itself
must not be made nullable automatically.

#### Local binding types

Given an aligned supplied-value schema `T`:

- required positional parameter: `T`;
- optional positional parameter: `T | null`;
- defaulted positional parameter: `T`;
- rest parameter: `T[]`;
- required object field: `T`;
- optional object field: `T | null`;
- defaulted object field: `T`.

Use the checker's existing `unionOf` helper to add `{ type: "null" }`, so an
already-nullable schema is not duplicated and `any` remains `any`.

Object-field `T` comes from the aligned object parameter schema:

- a named property uses its declared property schema;
- a map schema uses its `additionalProperties` schema;
- an open object falls back to `any`;
- a closed object with no matching property is a declaration mismatch rather
  than a silent `any` binding.

The signature describes what checked callers may omit. Therefore:

- a required field descriptor must correspond to a property guaranteed by the
  object schema; otherwise a checked caller could omit the field and fail only
  at runtime;
- an optional or defaulted field descriptor may correspond only to a property
  the input schema permits to be absent;
- in particular, a default on a required property is an error because that
  default is unreachable for every checked call.

Report field/signature alignment errors at the field descriptor path, not at
the whole function or object schema. Do not continue checking that binding as
`any` after an unsound alignment error.

#### Default-expression checking

Every normalized default is checked against the non-null binding schema:

- positional default against its aligned optional signature schema;
- field default against the field's projected schema.

Defaults are checked even when the binding is unused and even when a particular
call supplies the argument or field.

Construct the complete recursive body scope first, then check defaults in that
scope. This permits defaults to reference:

- required, optional, defaulted, field, and rest parameters;
- earlier or later parameter defaults;
- body locals;
- local functions;
- recursive local definitions already supported by `buildTypeScope`.

The checker does not evaluate defaults and does not attempt to reject runtime
dependency cycles. A self-reference or mutual default cycle is checked only
for type compatibility.

A mismatch diagnostic is rooted at the exact normalized default path:

```text
$params[i].$default
$params[i].$fields[j].$default
```

Nested diagnostics append their normal expression path beneath that root. The
diagnostic should carry the expected binding schema and synthesized actual
schema just like other checked expressions.

### Implementation steps

#### 1. Centralize callable-shape and call-range helpers

Primary files:

- `typescript/src/check/checker.ts`
- optionally a small internal helper in `typescript/src/check/schema.ts`

Add small checker-internal helpers with distinct responsibilities:

1. compare `ParameterLayout` required/optional/rest structure with a `Sig`;
2. describe both structures for diagnostics;
3. calculate whether an argument count is within a `Sig`'s accepted range.

The shape comparison should return a boolean or structured result and leave
reporting to the caller so paths can remain context-specific. Use it from every
body/contextual entry point; do not duplicate count arithmetic.

Update `checkArity` to:

- use `sig.required.length` as the minimum;
- use `fixedParamSchemas(sig).length` as the no-rest maximum;
- retain a boolean result so arity-dependent callback checking can suppress
  cascades;
- report a range for optional callables, an exact count when minimum equals
  maximum, and “at least” when rest is present.

`paramAt` can keep its required-then-optional-then-rest position lookup.

#### 2. Build one typed parameter-binding plan

Primary file: `typescript/src/check/checker.ts`

Refactor the current `bindParams` work so alignment and local typing happen in
one place. Given a valid layout and `Sig | null`, produce the eager bindings and
enough metadata to check defaults. A practical internal result is:

```ts
type TypedDefault = {
  expression: JSONType;
  expected: Schema;
  path: ParameterPath;
};

type TypedParameterBindings = {
  eager: Record<string, Schema>;
  defaults: TypedDefault[];
  valid: boolean;
};
```

The exact interface is not important, but avoid separately re-projecting field
schemas during binding and default checking.

For an untyped body with no contextual signature, preserve current graceful
degradation by using `any` as the supplied-value schema. The normalized
descriptor still determines whether the local is nullable and whether a
default must be traversed.

For object patterns:

1. resolve the aligned fixed schema through `$ref`;
2. confirm it is an object schema before relying on properties;
3. project each field schema;
4. validate required/omittable field agreement;
5. apply `T` versus `T | null` according to the normalized binding kind;
6. retain each default with its exact path and non-null expected schema.

If the aligned slot is not an object, report a focused declaration error at the
pattern path. Do not invent field schemas from a non-object parameter type.

#### 3. Validate every body's declaration shape

Primary file: `typescript/src/check/checker.ts`

At `checkBody` entry, after successful parameter analysis and before building
the scope:

- when the body has its own `$sig`, compare the layout with that signature;
- when an injected signature is supplied, compare the layout with the injected
  signature;
- report one structural mismatch at `$params`;
- stop checking that body after a mismatch to avoid binding names against
  misaligned schema positions.

The diagnostic must state required count, optional count, and rest presence for
both sides. Do not collapse the message to “fixed parameters.”

Replace `checkInjectedBodyArity` with this shared shape operation. This also
closes the existing gap where an annotated body can use required descriptors
for slots its `$sig` marks optional.

#### 4. Correct local bindings and check defaults

Primary file: `typescript/src/check/checker.ts`

Change `buildTypeScope` to consume the typed binding result or return its
default metadata alongside `{ env, guards }`.

After the complete `env` and guards exist:

1. create the body context;
2. check each retained default under that context and at its exact parameter
   path;
3. then check `$return`;
4. then recurse into nested function bodies as today.

Default checks must run before `$return` only for deterministic diagnostic
ordering; they must not alter the environment or infer a new declared parameter
type.

Apply the same default-check operation in checker paths that build a body scope
without calling ordinary `checkBody`, notably:

- unannotated IIFE synthesis/checking;
- contextual builtin callback return inference.

`checkLambda` already delegates to `checkBody` after installing an expected
signature and should not separately check defaults.

#### 5. Apply required/optional ranges to direct and IIFE calls

Primary file: `typescript/src/check/checker.ts`

Direct known-signature calls already route through `checkArity` and `paramAt`.
After the shared arity helper changes, verify:

- omitted optional arguments are accepted;
- supplied optional arguments are checked against their optional-slot schema;
- rest begins only after all fixed optional positions;
- too few required and too many non-rest arguments still stop
  arity-dependent contextual work but all ordinary argument expressions are
  still traversed for independent errors.

Update `iifeBodyContext` to use the body's `requiredCount`, `fixedCount`, and
rest presence:

- accept the same argument-count range as an equivalent annotated callable;
- synthesize all supplied argument types in the caller's scope;
- construct a synthetic signature with required schemas aligned to required
  slots and optional schemas aligned to omittable slots;
- use `any` for omitted unannotated omittable slots;
- include a rest schema derived from supplied tail arguments when the body
  declares rest;
- build the typed local scope and check defaults before synthesizing/checking
  the IIFE return.

Do not infer omission from nullable argument types. Only the normalized
optional/defaulted descriptor creates an omittable IIFE slot.

#### 6. Apply ranges to builtin overload selection

Primary file: `typescript/src/check/builtin-rules.ts`

Replace exact-fixed arity checks in overload trial matching with the shared
range semantics:

- too few means fewer than `required.length`;
- too many means beyond required plus optional when no rest exists;
- rest removes the upper bound;
- `paramAt` continues to align supplied arguments.

Ensure overload diagnostics render optional ranges accurately. Two overloads
that differ only by optional tails must be trialed against the actual argument
count rather than rejected because every fixed slot was treated as required.

Keep the existing ordering for polymorphic inference:

1. choose viable overloads by range and concrete arguments;
2. bind input type variables;
3. contextualize lambdas under instantiated callable schemas;
4. bind output variables from callback returns;
5. revalidate callbacks if shared variables widen.

Optional arguments and defaults do not themselves introduce a new type-variable
inference policy.

#### 7. Remove contextual callback prefix compatibility

Primary files:

- `typescript/src/check/builtin-rules.ts`
- `typescript/src/check/checker.ts`

Replace `inferLambdaReturn`'s one-sided fixed-count test with the shared exact
layout-to-callable shape comparison:

- required counts must match;
- optional counts must match;
- rest presence must match.

On success, install the complete expected `required`, `optional`, `rest`, and
return schemas. Do not:

- slice expected fixed schemas to the shorter body declaration;
- reinterpret fixed trailing schemas as a body rest type;
- permit a defaulted or optional body slot where the builtin declares an
  always-supplied required callback argument.

Use the same structural helper from `checkLambda` and callable-rule services.
A shape failure stops callback body and default checking and reports once at
the callback's `$params` path.

This changes checker policy only. Builtin declarations and runtime callback
invocations remain unchanged unless a separate audit discovers an actual
declaration/runtime mismatch.

#### 8. Make function assignability shape-exact

Primary files:

- `typescript/src/check/subsumption.ts`
- `typescript/src/check/builtin-rules.ts`

Update `fnSubsumes` to require independently equal:

- required parameter counts;
- optional parameter counts;
- rest presence.

Only after shape agreement:

- compare all required and optional parameters contravariantly in their shared
  positional order;
- compare rest contravariantly;
- compare returns covariantly.

Update function-template matching in builtin inference to use the same shape
criteria before inferring from a callback return. A callback with the same total
fixed count but a different required/optional split must not influence type
variables as though it were compatible.

Do not add callable-range subtyping in this phase. The conservative exact-shape
decision remains intentional.

#### 9. Keep diagnostic recovery deliberate

Across all changes:

- malformed canonical descriptors continue to use the existing structured
  parameter issue and skip the body;
- body/signature shape mismatches produce one diagnostic at `$params` and skip
  scope construction;
- field/signature mismatches point to the exact field entry and suppress only
  work that depends on the invalid binding plan;
- default type errors point to `$default`;
- wrong outer call arity continues to suppress underconstrained contextual
  callback diagnostics;
- independently invalid ordinary argument expressions are still traversed;
- repeated contextual validation continues to deduplicate diagnostics.

Do not recover from a known declaration mismatch by binding the affected slot
as `any`; that would hide the runtime/checker disagreement this work is meant
to remove.

### Test plan

#### Body shape and binding tests

Extend `typescript/test/check/checker.test.ts` with:

- an annotated body whose required, optional, and rest descriptors exactly
  match its `$sig`;
- same-total-count mismatches between required and optional slots;
- missing or extra rest on either side;
- optional positional local used where `T | null` is expected;
- optional positional local rejected where bare `T` is required;
- defaulted positional local retaining bare `T`;
- optional field local as `T | null`;
- defaulted field local as `T`;
- required field whose object schema permits absence rejected;
- defaulted field whose object schema requires presence rejected as unreachable;
- closed-object missing field and non-object pattern schema diagnostics.

Update existing fixtures that pair plain required descriptors with
`$sig.optional`; those fixtures currently encode the inconsistency this phase
must reject.

#### Default checking tests

In `typescript/test/check/checker.test.ts`, cover positional and field defaults:

- matching scalar default;
- mismatching default with expected/actual schemas and exact path;
- unused mismatching default still reports;
- default references a required parameter;
- default references an optional parameter and therefore observes `T | null`;
- default references another defaulted parameter;
- forward reference to a later parameter;
- reference to a body local;
- reference to a local function;
- nested function defaults use the nested recursive scope;
- self and mutual default cycles do not cause checker recursion or a special
  static cycle diagnostic;
- multiple bad defaults report in canonical parameter/field order.

Repeat representative cases through:

- an annotated module function;
- an unannotated IIFE;
- an unannotated contextual lambda;
- an environment-injected body.

Avoid duplicating the entire matrix at every entry point; one parity case per
adapter is enough after focused default tests cover the core operation.

#### Call-range tests

For a callable with one required and two optional slots, verify direct calls
with:

- zero arguments rejected;
- one, two, and three accepted;
- four rejected without rest;
- supplied optional arguments type-checked at their exact `$args[i]` path;
- explicit `null` rejected or accepted solely according to the supplied-value
  schema.

Repeat the count boundaries with rest, then add equivalent coverage for:

- unannotated IIFEs;
- single- and multi-overload builtins;
- environment-provided functions.

Assert diagnostic wording distinguishes exact, ranged, and at-least arity.

#### Contextual callback tests

Extend `typescript/test/check/builtins.test.ts` and contextual-lambda tests with:

- exact required/optional/rest callback shape accepted;
- same total fixed count but different required/optional split rejected;
- defaulted callback slot rejected when the builtin callback slot is required;
- optional callback slot rejected when the builtin callback slot is required;
- prefix-only callback rejected;
- body rest no longer absorbs expected fixed trailing arguments;
- callback defaults checked after successful contextual shape alignment;
- wrong outer builtin arity still suppresses callback cascades;
- callable-rule contextual services enforce the same shape.

Existing tests asserting that `map`, `mapValues`, `filter`, or similar callbacks
may omit builtin-supplied trailing parameters must be inverted and their valid
fixtures updated to declare explicit ignored bindings.

#### Function subsumption tests

Extend `typescript/test/check/subsumption.test.ts` with:

- equal required/optional/rest shape and compatible variance succeeds;
- equal total fixed count but different required/optional split fails in both
  directions;
- rest-presence mismatch fails;
- required and optional parameter types are both contravariant;
- return remains covariant;
- builtin generic callback matching does not infer through a shape mismatch.

### Documentation

Update only checker-relevant semantic documentation:

- `docs/language.md` for static local types and default checking;
- `docs/type-syntax-spec.md` for body/signature shape agreement, accepted call
  ranges, and conservative function compatibility;
- `docs/builtin-signatures.md` to remove contextual callback prefix
  compatibility.

Do not edit `docs/shorthand-spec.md` in this phase. It already records that
optional/defaulted canonical descriptors have no shorthand surface syntax.

### Verification

From `typescript/`, run:

```sh
bun test test/check/checker.test.ts
bun test test/check/subsumption.test.ts
bun test test/check/builtins.test.ts
bun test test/environment.test.ts
bun test
bun run check
```

Then search checker sources for remaining total-fixed assumptions:

- exact comparisons against `fixedParamSchemas(sig).length`;
- arity minimums derived from total fixed count;
- contextual schema slicing based on a shorter body;
- rest synthesis from leftover fixed callback schemas;
- function compatibility that compares only combined fixed count.

Every remaining occurrence should be positional schema lookup or diagnostic
rendering, not an independent required/optional policy.

### Completion criteria

- Every checked body agrees structurally with its own or contextual callable
  signature.
- Calls accept the full required-through-optional range and no counts outside
  it, with rest removing only the upper bound.
- Optional positional and field locals include `null`; defaulted locals do not.
- Every default expression is checked once per checker pass against its binding
  schema in the complete recursive body scope.
- Default diagnostics use exact normalized `$default` paths.
- Object field descriptors cannot claim a caller contract that permits a
  runtime destructuring failure.
- Direct calls, IIFEs, builtin overloads, contextual lambdas, callable rules,
  and environment-injected functions use the same required/optional/rest
  semantics.
- Function assignability independently matches required count, optional count,
  and rest presence before applying variance.
- No checker path retains prefix-only contextual callback compatibility.
- No shorthand parser, printer, or round-trip path changes.
- TypeScript tests and checks pass.
