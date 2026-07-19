# Strict object-key and index validation

Status: proposed.

## Summary

json-fn's type system and documentation distinguish object keys from sequence
indices:

- objects are read with string keys;
- arrays and strings are read with integer indices;
- object helpers such as `hasKey`, `pick`, and `omit` accept string keys; and
- conversion is explicit through `str` and `num`, except for builtins that
  specifically document normalization.

The canonical TypeScript evaluator does not enforce that distinction
consistently. Several operations currently inherit JavaScript property-key
coercion:

```jfn
({ "1": "one" })[1]       // checker error, evaluator returns "one"
hasKey({ "1": "one" }, 1) // checker error, evaluator returns true
pick({ "1": "one" }, [1]) // checker error, evaluator returns { "1": "one" }
```

`omit` also accepts non-string key values at runtime, although its accidental
behavior differs because `Set` does not coerce them. These are evaluator
validation gaps, not a reason to add general implicit coercion. Runtime behavior
should match the existing checker and require authors to write `str(value)` when
they intend to turn a value into an object key.

The recently tightened `fromEntries` behavior is the model: non-string keys are
rejected consistently by both the checker and evaluator.

## Decision

Use target-dependent, non-coercing key rules:

| Operation | Accepted key |
| --- | --- |
| object property access | string |
| array access | integer |
| string access | integer |
| `hasKey(object, key)` | string |
| `pick(object, keys)` | array of strings |
| `omit(object, keys)` | array of strings |
| `fromEntries(entries)` | every entry key is a string |

Missing valid keys and out-of-bounds valid indices continue to return `null`
where they do today. Negative integer indices remain valid key *types* but are
out of bounds and therefore return `null`; this plan does not introduce
JavaScript-style negative indexing.

Do not change builtins whose contracts intentionally normalize keys:
`groupBy`, `groupByIndexed`, and `countBy` explicitly accept string or numeric
callback results and convert numeric keys to strings. `frequencies` explicitly
normalizes scalar values. Those conversions are local, documented builtin
semantics rather than a language-wide coercion rule.

## Motivation

The strict behavior is already the language's effective static contract:

- the checker requires string keys for objects and integer indices for arrays
  and strings;
- map types are string-keyed;
- builtin signatures declare string keys for object helpers;
- template interpolation and equality do not coerce;
- `str` and `num` provide explicit conversion; and
- computed object keys now follow `fromEntries`' string-key contract.

Leaving the evaluator permissive creates programs that run when unchecked but
are rejected by `jfn check`. It also makes semantically equivalent operations
disagree: constructing `{ [1]: value }` fails, while reading the resulting
string-shaped key with `object[1]` can currently succeed.

## Scope

### 1. Centralize one-step property access

Refactor `typescript/src/eval/property-access.ts` so scalar access and each
segment of a folded static path use the same one-step helper. The helper should
inspect the current target before validating the key:

1. **Object target:** require `typeof key === "string"`.
2. **Array target:** require `typeof key === "number" &&
   Number.isInteger(key)`.
3. **String target:** require the same integer check.
4. **Other target:** preserve the existing invalid-target diagnostic.

After validation, a missing object key or out-of-bounds sequence index returns
`null`. Error messages should name both the target category and expected key
category, for example:

```text
Cannot index an object with key 1: object keys must be strings.
Cannot index an array with key "0": array indices must be integers.
Cannot index a string with key 1.5: string indices must be integers.
```

Folded paths must validate each segment against the value reached at that step.
For example, `data["items", 0, "name"]` remains valid, while a numeric segment
used when the current value is an object fails immediately.

Use own-property checks for object reads rather than allowing JavaScript's
prototype chain to supply a value. A json-fn object contains JSON data keys, so
an inherited property is a missing key and should produce `null`. Preserve
ordinary data keys such as `constructor` and `__proto__` when they are genuinely
present as own properties.

### 2. Validate object-helper arguments

In `typescript/src/stdlib.ts`, add explicit runtime checks matching the builtin
signatures:

- `hasKey`: first argument must be a plain object; second must be a string.
- `pick`: first argument must be a plain object; second must be an array whose
  elements are all strings.
- `omit`: same validation as `pick`.

Prefer a small shared validator for the `pick`/`omit` key-list contract so their
errors and edge cases stay aligned. Validation happens before iterating or
charging per-key work, consistent with other builtin argument checks.

`pick` should copy only own properties. `omit` already iterates `Object.keys`,
which is own-key-only; retain that behavior after validating its exclusion list.

### 3. Keep the checker contracts

No checker policy change is intended. The current checker already reports:

- `Index key must be a string.` for numeric object access;
- an integer-key mismatch for string access to arrays;
- signature mismatches for non-string `hasKey` keys; and
- signature mismatches for non-string members passed to `pick` or `omit`.

Add or adjust checker tests only if needed to pin these existing expectations.
Do not widen object keys to `string | number`.

### 4. Add conformance coverage

Extend `spec/cases/property-access.json` with evaluator cases for:

- valid string access on an object;
- numeric access on an object is rejected;
- valid integer access on arrays and strings;
- string access on an array is rejected;
- string access on a string is rejected;
- fractional numeric indices on arrays and strings are rejected;
- an invalid key category in the middle of a folded path is rejected;
- missing valid keys and out-of-bounds integer indices still return `null`; and
- object-special own keys are read as data while inherited properties are not.

Extend `spec/cases/object-helpers.json` with:

- `hasKey` rejecting a numeric key;
- `pick` and `omit` rejecting a non-array key list;
- `pick` and `omit` rejecting an array containing a non-string key;
- explicit `str(1)` keys succeeding; and
- own-key behavior for object-special names.

Keep the existing computed-key/fromEntries cases as the construction-side
counterpart to these access and helper tests.

The shared cases define the portable target behavior. TypeScript is the
canonical implementation and lands first; lagging evaluators can adopt the same
validation as their parity work proceeds.

### 5. Clarify the language reference

Update `docs/language.md`'s property-access section:

- replace “number index” with “integer index”;
- state explicitly that objects reject non-string keys;
- state explicitly that arrays and strings reject non-integer indices;
- explain that no property-key coercion occurs; and
- show `object[str(number)]` as the explicit conversion form.

The generated builtin documentation already exposes the correct signatures for
`hasKey`, `pick`, `omit`, and `fromEntries`; regenerate it only if
`spec/builtins.json` wording changes.

## Non-goals

- Supporting JavaScript `PropertyKey` semantics or symbols.
- Automatically stringifying numbers, booleans, or `null` in object operations.
- Changing the explicit normalization contracts of grouping/counting builtins.
- Adding negative array indexing.
- Changing missing-key or out-of-bounds results.
- Expanding map types beyond string keys.
- Reconciling unrelated argument-validation gaps in other builtins.

## Compatibility

This is a runtime compatibility tightening. Programs that relied on implicit
JavaScript coercion must become explicit:

```jfn
// Before: rejected by the checker, accidentally accepted by the evaluator.
object[numberKey]
hasKey(object, numberKey)
pick(object, [numberKey])

// After: accepted consistently.
object[str(numberKey)]
hasKey(object, str(numberKey))
pick(object, [str(numberKey)])
```

Well-typed programs are unaffected because the checker already rejects the
implicit forms.

## Acceptance criteria

- The evaluator rejects non-string keys used on objects.
- The evaluator rejects non-integer indices used on arrays and strings.
- Folded property paths enforce the same rule at every step.
- `hasKey`, `pick`, and `omit` validate their complete key contracts at runtime.
- Explicit `str(...)` conversion works for object access and helpers.
- Valid missing keys and out-of-bounds indices retain their existing results.
- Object reads and `pick` do not expose inherited prototype properties.
- Intentionally normalizing collection builtins retain their current behavior.
- Existing checker diagnostics remain valid.
- The TypeScript checker and test suite pass.
- The language reference matches the implemented runtime rules.
