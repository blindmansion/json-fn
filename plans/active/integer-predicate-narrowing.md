# Primitive predicate narrowing

Status: proposed.

## Summary

Extend the checker's existing type-predicate narrowing family to recognize
`isInteger`, and replace its current arm-filtering approximation with a proper
intersection for the true branch. This makes all built-in type guards behave
coherently:

```jfn
if isInteger(value)
  then range(value)
  else []
```

When `value: number | string`, the true branch should see `value: integer`.
The false branch must remain `number | string`, because the current schema
fragment cannot express "number but not integer."

There is no backward-compatibility constraint for checker behavior. The
implementation should therefore correct the existing predicates at the same
time instead of preserving their current conservative handling of `any` and
broad overlapping arms.

## Current implementation

Type-predicate awareness is explicit in
`typescript/src/check/narrowing.ts`. `TYPE_PREDICATES` maps unshadowed builtin
names such as `isNull`, `isNumber`, and `isString` to schema categories.
`factsFromCondition` applies `restrictToType` on the true branch and
`removeType` on the false branch.

The checker does not derive guard behavior from `spec/builtins.json`. A
signature of `(any) -> boolean` is insufficient to prove that a callable is a
sound type guard, so predicate recognition should remain an explicit checker
rule. The existing `isUnshadowed` check must remain: a user binding with the
same name wins runtime dispatch and must not produce builtin narrowing facts.

The current helpers are not sufficient for `isInteger`:

- `restrictToType` filters union arms that overlap a category but does not
  compute their intersection, so `number` would remain `number` rather than
  become `integer`;
- `valueTypeMatches` treats every JavaScript number as matching both `number`
  and `integer`, so a literal such as `1.5` would incorrectly survive an
  integer guard; and
- `any` remains `any` on a positive type predicate instead of narrowing to the
  tested category.

## Required semantics

### True branch: intersection

The true branch computes the subject schema intersected with the predicate's
runtime category:

| Subject schema | `isInteger` true |
| --- | --- |
| `any` | `integer` |
| `number` | `integer` |
| `integer` | `integer` |
| `string` | `never` |
| `number \| string` | `integer` |
| `integer \| string` | `integer` |
| `1 \| 1.5 \| string` | `1` |

Apply the same real-intersection rule to existing predicates. For example,
`isString(x)` with `x: any` narrows `x` to `string`, and `isNumber(x)` with
`x: integer | string` retains the more precise `integer` arm.

For a refined numeric schema, changing a `number` arm to `integer` must retain
compatible constraints such as bounds and enums. Do not widen a refined arm to
a bare primitive.

### False branch: representable subtraction

The false branch removes the tested category only where the remaining type is
representable:

| Subject schema | `isInteger` false |
| --- | --- |
| `any` | `any` |
| `number` | `number` |
| `integer` | `never` |
| `string` | `string` |
| `number \| string` | `number \| string` |
| `integer \| string` | `string` |
| `1 \| 1.5 \| string` | `1.5 \| string` |

Keeping `number` on the false branch is intentional and sound. The checker has
no schema for non-integral numbers, so subtracting `integer` from `number`
cannot be represented exactly. Narrowing must over-approximate rather than
exclude valid non-integral values.

Constants and finite enums can be filtered exactly. Integer membership means
`typeof value === "number" && Number.isInteger(value)`, matching the runtime
implementation in `typescript/src/stdlib.ts`.

## Implementation plan

### 1. Correct runtime-category matching

In `typescript/src/check/narrowing.ts`, update `valueTypeMatches` so:

- `number` matches every numeric JSON value;
- `integer` matches only numeric values satisfying `Number.isInteger`; and
- the other categories continue to use `valueType`.

This function is used for constant and enum filtering and must reflect the
actual `isInteger` builtin.

### 2. Replace overlap filtering with schema intersection

Replace or refactor `restrictToType` into a recursive primitive-category
intersection:

1. resolve `$ref` aliases with the existing `resolveDeep` behavior;
2. map `any` to the predicate category and preserve `never`;
3. recurse into every union arm and rebuild with `unionOf`;
4. filter constants and enums with `valueTypeMatches`;
5. preserve exact matching primitive and composite schemas;
6. preserve `integer` when intersecting with `number`;
7. convert `number` to `integer` when intersecting with `integer`, retaining
   compatible refinements; and
8. return `never` for disjoint categories.

Rebuilding unions with `unionOf` retains the existing flattening,
deduplication, and covered-literal cleanup in
`typescript/src/schema/schema.ts`.

Avoid implementing general JSON Schema intersection. This helper only needs
the finite set of runtime categories represented by `TYPE_PREDICATES`.

### 3. Make subtraction recursive and conservative

Refactor `removeType` to recurse through union arms rather than only dropping
arms that are wholly subschemas of the predicate category. Keep its existing
subschema-based behavior where exact, but add the integer-specific overlap:

- remove an `integer` arm for `isInteger` false;
- retain a `number` arm unchanged;
- filter constants and enums exactly; and
- retain `any` unchanged.

This should also preserve current exact behavior for `null`, strings,
booleans, arrays, objects, and `isNumber` removing both `number` and `integer`
arms.

### 4. Register the builtin guard

Add `isInteger: "integer"` to `TYPE_PREDICATES` in
`typescript/src/check/narrowing.ts`.

Do not move guard behavior into `spec/builtins.json` as part of this change.
The explicit table is small, auditable, and coupled to checker semantics rather
than callable signatures. Continue requiring the predicate call to have one
argument and an unshadowed builtin name.

### 5. Expand direct narrowing tests

Extend `typescript/test/check/narrowing.test.ts`, which directly pins the fact
maps returned by `factsFromCondition`.

Cover at least:

- `number` on the true and false branches;
- `integer | string` on both branches;
- `number | string` on both branches;
- constants and mixed enums containing integral numbers, fractional numbers,
  and non-numbers;
- `any` on both branches;
- refined number-to-integer intersection;
- a static field-path subject;
- a named boolean guard local;
- `not(isInteger(x))`; and
- a user binding shadowing `isInteger`.

Update existing predicate rows where the intentional no-compatibility cleanup
changes expected facts, especially positive predicates over `any`.

### 6. Add checker integration coverage

Add end-to-end cases in the appropriate checker suite under
`typescript/test/check/` to prove that branch facts affect actual calls, not
only the isolated fact map:

- an `isInteger` true branch may pass a `number | string` subject to an
  integer-only builtin such as `range`;
- the false branch of a bare `number` cannot be treated as a string or as an
  integer;
- an integral enum member is accepted in the true branch while fractional
  members remain in the false branch; and
- shadowed `isInteger` does not authorize an integer-only use.

Use declared function signatures so the tests exercise normal module checking
and diagnostics.

### 7. Update the narrowing reference

Update `docs/narrowing.md`:

- include `isInteger` in the fixed type-predicate family;
- define true-branch intersection and conservative false-branch subtraction;
- explain the unrepresentable `number - integer` case;
- include examples for `number | string` and `integer | string`; and
- retain the statement that shadowed builtin names do not narrow.

This is an extension and correction within recognized form 2, not a new
condition form. The document may remain frozen after its table and semantics
are updated.

## Non-goals

- User-defined type predicates or TypeScript-style predicate return types.
- Inferring guard behavior from arbitrary boolean-returning signatures.
- General JSON Schema intersection, negation, or `not` schemas.
- Introducing a first-class non-integral-number type.
- Narrowing dynamic subjects, call results, or computed paths.
- Expanding the frozen set of recognized condition forms beyond the existing
  type-predicate family.

## Acceptance criteria

- `isInteger` narrows static subjects according to the tables above.
- Fractional constants never survive the true branch.
- A broad `number` becomes `integer` only on the true branch and remains
  `number` on the false branch.
- Existing predicates use the same proper-intersection model, including
  narrowing `any` on positive branches.
- Shadowing, field paths, named guards, and boolean composition preserve their
  existing control-flow rules.
- `docs/narrowing.md` exactly matches the implemented fact table.
- `bun run check` and `bun test` pass from `typescript/`.
