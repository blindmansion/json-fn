# Stage 3: trailing positional omission

Source plan: [`plans/active/strict-parameter-semantics.md`](../strict-parameter-semantics.md), implementation order item 3: “enforce trailing positional omission.”

## Completion criteria

Stage 3 is complete when the canonical TypeScript implementation rejects every
function body whose positional `$params` layout places a required slot after a
defaulted slot.

With the parameter forms available at this stage, the valid order is:

```text
required positional or object-pattern slots*
defaulted positional slots*
optional final rest slot
```

Concretely:

- plain string parameters are required;
- object patterns are required as whole positional slots, even when every field
  in the pattern has a default;
- `{ "$param": name, "$default": expression }` slots are omittable;
- once a defaulted positional slot appears, no plain string or object-pattern
  slot may follow it;
- any number of additional defaulted slots may follow;
- a rest parameter may follow required or defaulted slots and must still be the
  final entry;
- field order inside `$fields` remains unrestricted because fields are named,
  not positional;
- every path that validates or invokes a JSON function observes the same
  declaration error.

This stage establishes a declaration invariant; it does not change the value
binding of any valid call. Required arguments still use stage 1's strict
runtime checks, omitted defaults remain lazy, explicit `null` remains supplied
data, rest collection is unchanged, and extra non-rest arguments remain errors.

## Scope boundaries

This is intentionally a narrow validation stage. It does **not**:

- add the canonical `{ "$param": name, "$optional": true }` descriptor;
- add optional object-field descriptors;
- add shorthand `?` or `=` parameter syntax;
- infer or populate `$sig.optional` from runtime `$params` descriptors;
- change direct-call, builtin, environment, or runtime-contract arity checking;
- teach the checker to bind defaulted or optional descriptors;
- check default expressions against parameter schemas;
- change function assignability;
- change `getArity`, which continues to report the number of fixed slots;
- refactor parameter normalization to return structured success/error results;
- redesign contextual callback arity exceptions.

Those changes belong to stage 4, stage 5, or the checker-support sequence in the
source plan. In particular, the eventual optional descriptor will join
defaulted parameters in the omittable suffix, but adding that descriptor and
its checker semantics should happen together rather than introducing another
runtime-only form here.

There is also no whole-object default in this stage. A pattern such as:

```json
{
  "$fields": [
    { "$field": "x", "$default": 0 },
    { "$field": "y", "$default": 0 }
  ]
}
```

still consumes one required positional object argument. Its field defaults do
not make the pattern slot omittable.

## Preceding state

After stage 1, [`normalizeParams`](../../../typescript/src/params.ts) validates
descriptor shapes, duplicate bindings, and rest placement, while runtime call
validation distinguishes required, defaulted, fields, and rest slots. It must
still validate missing slots by index because a declaration such as:

```json
[
  { "$param": "prefix", "$default": "" },
  "value"
]
```

is currently accepted.

After stage 2, callable schemas use separate `required` and `optional` arrays,
but that representation does not yet derive omission behavior from a function
body. Existing producers still emit `optional: []`, and checker arity remains
exact over the complete fixed sequence.

Stage 3 closes only the runtime declaration-order gap. It does not connect the
body layout to the callable signature yet.

## Implementation plan

### 1. Enforce the order during parameter normalization

Primary file: [`typescript/src/params.ts`](../../../typescript/src/params.ts)

Extend the existing single pass in `normalizeParams` with a local
`seenOmittable` state:

1. A valid defaulted positional descriptor sets `seenOmittable`.
2. A later plain required parameter throws when `seenOmittable` is set.
3. A later object-pattern slot throws for the same reason.
4. Additional defaulted descriptors remain valid.
5. A final rest parameter remains valid and does not need a new state.

Keep the check in `normalizeParams`, not in `evaluate.ts`. Normalization is
already the shared boundary used by invocation, expression classification, and
closure processing, so placing the invariant there prevents unchecked
canonical JSON from bypassing it.

Validate the current slot's descriptor and bound names before applying the
ordering rule. This preserves the more specific existing failures for malformed
descriptors and duplicate names instead of masking them with an ordering error.
For a well-formed but misplaced required slot, use an ordinary `exprError`
message that includes:

- that required positional parameters must precede defaulted parameters;
- the one-based position of the misplaced slot;
- whether the slot is a named parameter or an object pattern when useful.

Do not add a new error class or path-result type. Stage 4 will replace these
throwing validation branches with structured results and exact parameter paths.

### 2. Treat object patterns as required positional slots

Primary file: [`typescript/src/params.ts`](../../../typescript/src/params.ts)

Apply the ordering check to the outer `fields` slot, not to its individual
bindings:

- `{ "$fields": ["x"] }` after a defaulted positional parameter is invalid;
- `{ "$fields": [{ "$field": "x", "$default": 0 }] }` after a defaulted
  positional parameter is also invalid;
- either pattern may appear before the first defaulted positional parameter;
- required and defaulted field bindings may appear in any order inside the same
  `$fields` array.

This follows the source plan's distinction between positional omission and
named-property omission. Field defaults affect whether a property may be absent
from a supplied object; they do not affect whether the object argument itself
may be absent.

Avoid deriving the outer slot's category from its field contents. Doing so
would accidentally reintroduce whole-object omission and would disagree with
stage 1's strict object-pattern validation.

### 3. Preserve every existing normalization consumer

Relevant files:

- [`typescript/src/evaluate.ts`](../../../typescript/src/evaluate.ts)
- [`typescript/src/utils.ts`](../../../typescript/src/utils.ts)

No independent ordering check should be added to:

- `callJSONFunction` or `buildScope`;
- `replaceVars` closure masking;
- local-function reference collection;
- `classifyExpressionType`;
- `getArity`.

The evaluator paths should continue to consume `normalizeParams` as established
by stage 1. A malformed body must fail consistently whether it is:

- called directly;
- reached through a registry name;
- used as an inline callee;
- invoked through `callProgram`;
- invoked through a prepared program;
- encountered while validating or closing over a nested function body.

`getArity` remains fixed-slot introspection in this stage. For valid layouts, it
continues to count a defaulted descriptor as one fixed slot and excludes a
final rest slot. Defining minimum/maximum callable arity belongs with the later
shared arity model, not with declaration ordering. Do not make this stage
depend on `getArity` validating malformed bodies; its current implementation
inspects slot count without normalizing.

### 4. Migrate invalid fixtures without changing valid semantics

Primary test file:
[`typescript/test/parameter-defaults.test.ts`](../../../typescript/test/parameter-defaults.test.ts)

The current arity test constructs a defaulted slot followed by a required slot:

```ts
fn([defaulted("value", 1), "required"], null)
```

That body becomes invalid. Replace it with separate assertions that:

- a required slot followed by a defaulted slot still reports two fixed slots;
- a defaulted slot followed by rest still reports one fixed slot;
- invoking a body with a defaulted slot followed by a required slot throws the
  declaration-order error.

Do not rewrite valid tests merely because defaults appear in them. Multiple
defaulted parameters, dependencies between defaults, default/local cycles,
escaping closure capture, and defaulted field order all remain valid.

## Tests

### Focused normalization tests

Extend the positional-default validation section in
[`typescript/test/parameter-defaults.test.ts`](../../../typescript/test/parameter-defaults.test.ts)
with:

- required followed by one defaulted parameter;
- several required parameters followed by several defaults;
- a defaulted parameter followed by rest;
- required, defaulted, then rest;
- a defaulted parameter followed by a required string;
- several defaults followed by a required string;
- a defaulted parameter followed by an object pattern;
- a required object pattern followed by a defaulted positional parameter;
- an all-defaulted field pattern followed by a required positional parameter,
  proving the pattern itself is still required;
- required and defaulted fields in both internal orders, proving field order is
  unrestricted;
- duplicate and malformed descriptors after a defaulted slot, preserving their
  existing specific validation failures;
- a rest parameter before another slot, preserving the existing rest-final
  failure.

Where a test is about declaration validity rather than call arity, supply all
arguments needed by the valid layout so stage 1's missing-argument errors do not
obscure the intended assertion.

### Entry-path parity

Use one misplaced required slot to verify the same stable error fragment through:

- direct `callFunction`;
- registry dispatch;
- `callProgram`;
- `prepareProgram(...).invokeEntry(...)`;
- an inline function body.

Do not duplicate the full behavior matrix for every path. The stage 1 tests
already establish that they converge on normalization; one focused regression
per major public entry is sufficient.

### Shared conformance

Add a focused suite such as
`spec/cases/trailing-parameter-omission.json` containing:

- valid required/default/rest layouts;
- required-after-default errors;
- pattern-after-default errors;
- a required pattern containing only defaulted fields;
- explicit `null` supplied to a defaulted slot;
- omitted trailing defaults.

Assert a stable declaration-order substring for invalid cases rather than the
serialized body. Keep optional descriptors out of this suite until their
canonical shape and checker behavior land.

### Verification

From `typescript/`, run:

```sh
bun test
bun run check
```

The full TypeScript test run is appropriate even for this small change because
`normalizeParams` is used by evaluation, closure capture, prepared programs,
and expression validation.

## Documentation updates

Update:

- [`docs/language.md`](../../../docs/language.md) — state that required
  positional and object-pattern slots must precede defaulted positional slots,
  with rest last;
- [`docs/shorthand-spec.md`](../../../docs/shorthand-spec.md) — state the same
  canonical runtime invariant where function parameter semantics are described,
  while making clear that shorthand syntax for defaults and optionals is still
  pending;
- [`typescript/src/types.ts`](../../../typescript/src/types.ts) — replace the
  stale parameter-default comment link with the active strict-parameter source
  plan.

Include examples of:

```json
["required", { "$param": "fallback", "$default": 0 }, "...rest"]
```

and the invalid reverse order. Explicitly note that defaults within `$fields`
do not make the containing positional object pattern omittable.

No callable-type documentation changes are needed. Stage 2 already documents
the structural `required`/`optional` split, and stage 3 neither populates
`optional` from body descriptors nor changes accepted checker arities.

## Files expected to change

Core:

- `typescript/src/params.ts`

Focused tests and conformance:

- `typescript/test/parameter-defaults.test.ts`
- a new `spec/cases/trailing-parameter-omission.json`

Docs:

- `docs/language.md`
- `docs/shorthand-spec.md`
- `typescript/src/types.ts` (comment-only source-plan link)

Expected unchanged:

- `typescript/src/evaluate.ts`
- `typescript/src/utils.ts`
- `typescript/src/check/**`
- `typescript/src/runtime-contract.ts`
- `typescript/src/shorthand/**`
- `spec/builtins.json`
- callable `$sig` and `$fnType` fixtures
- Go, Python, and Rust implementations

## Final verification checklist

- Every valid positional layout is required slots, then defaulted slots, then
  optional rest.
- A required string after a defaulted positional descriptor is rejected.
- An object pattern after a defaulted positional descriptor is rejected,
  regardless of its field descriptors.
- Field ordering inside an object pattern remains unrestricted.
- Existing malformed-descriptor, duplicate-name, and rest-placement diagnostics
  remain more specific than the new ordering error.
- Direct, registry, inline, program, prepared-program, validation, and closure
  paths share the invariant through `normalizeParams`.
- Valid default evaluation remains lazy, memoized, recursively scoped, and
  suppressed by every explicitly supplied value including `null`.
- Strict missing/extra argument and object-pattern behavior from stage 1 is
  unchanged.
- Callable shape, checker arity, function assignability, runtime contracts,
  `getArity`, and contextual callbacks are unchanged.
- Optional descriptors and shorthand omission syntax remain deferred.
- TypeScript tests and checks pass.
