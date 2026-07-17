# Strict parameter semantics

Status: proposed foundation for parameter defaults and optionals.

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
