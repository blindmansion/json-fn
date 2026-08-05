# Builtin conformance migration

This document records the audit of `spec/cases/eval/*.json` performed before the direct builtin conformance suite was introduced. It is the migration baseline for moving builtin-specific behavior into `spec/cases/builtins/` while retaining evaluator integration coverage where it is useful.

## Baseline

- Audit scope: 49 eval case files
- Total eval cases: 1,003
- Builtin-focused migration candidates: 538
- Non-candidates: 465
- Candidate share: 53.6%
- Files containing candidates: 19

A case was counted when its primary intent was to specify a registry builtin's result, validation, edge cases, callback behavior, or short-circuit behavior. A case was excluded when builtins were incidental to language syntax, scoping, closures, composition, evaluator limits, or another runtime concern.

The baseline is fixed. Do not reduce the candidate count when cases are migrated; update the progress columns instead.

## Current progress

The direct suite contains 529 cases:

- `spec/cases/builtins/arithmetic/*.json`: 90 across 27 builtin suites
- `spec/cases/builtins/arrays/*.json`: 109 across 22 builtin suites
- `spec/cases/builtins/comparison/*.json`: 23 across 6 builtin suites
- `spec/cases/builtins/coercion/num.json`: 10
- `spec/cases/builtins/higher-order/*.json`: 85 across 29 builtin suites
- `spec/cases/builtins/introspection/arity.json`: 10
- `spec/cases/builtins/logic/*.json`: 14 across 3 builtin suites
- `spec/cases/builtins/objects/*.json`: 39 across 8 builtin suites
- `spec/cases/builtins/regex/*.json`: 29 across 5 builtin suites
- `spec/cases/builtins/strings/*.json`: 47 across 10 builtin suites
- `spec/cases/builtins/tasks-effects/*.json`: 28 across 5 builtin suites
- `spec/cases/builtins/type-checking/*.json`: 43 across 7 builtin suites
- `spec/cases/builtins/debugging/tap.json`: 2

These establish direct coverage, and the corresponding duplicate eval cases have been removed. Direct case counts are not expected to map one-to-one to eval cases: one direct case may replace part of a combined eval case, while direct callback and observation cases may add coverage that did not previously exist.

Migration status:

- Direct builtin cases added: 529
- Candidate eval cases removed: 494 / 538
- Candidate eval cases reclassified as integration coverage: 44 / 538
- Fully migrated source files: 19 / 19
- Partially covered source files: none

## Candidate inventory

| Source eval file            | Candidate cases | Direct coverage                    | Eval candidates removed | Status                                       |
| --------------------------- | --------------: | ---------------------------------- | ----------------------: | -------------------------------------------- |
| `arity.json`                |              10 | `arity.json` (10 direct cases)     |                      10 | Fully migrated                               |
| `array-accessors.json`      |              73 | 17 array suites (77 direct cases)  |                      71 | Fully migrated; 2 integration cases retained |
| `coercion.json`             |              11 | `num.json` (10 direct cases)        |                      10 | Fully migrated; 1 integration case retained  |
| `collection-ops.json`       |              20 | 5 builtin suites (20 direct cases) |                      20 | Fully migrated                               |
| `comparison-logic.json`     |        35 of 36 | 9 builtin suites (37 direct cases) |                      31 | Fully migrated; 4 integration cases retained |
| `effects-constructors.json` |              14 | 5 builtin suites (12 direct cases) |                      10 | Fully migrated; 4 integration cases retained |
| `effects-handle.json`       |        27 of 28 | `handle.json` (20 direct cases)    |                      20 | Fully migrated; 7 integration cases retained |
| `higher-order-2.json`       |              43 | 8 builtin suites (41 direct cases) |                      36 | Fully migrated; 7 integration cases retained |
| `indexed-callbacks.json`    |              15 | 22 builtin suites (40 direct cases) |                     11 | Fully migrated; 4 integration cases retained |
| `numeric.json`              |              55 | 16 builtin suites (56 direct cases) |                     53 | Fully migrated; 2 integration cases retained |
| `object-helpers.json`       |              28 | 7 builtin suites (20 direct cases) |                      20 | Fully migrated; 8 integration cases retained |
| `objects.json`              |        32 of 34 | 8 builtin suites (30 direct cases) |                      30 | Fully migrated; 2 integration cases retained |
| `regex.json`                |        33 of 35 | 6 builtin suites (33 direct cases) |                      33 | Fully migrated; 2 excluded cases retained    |
| `search-quantify.json`      |              32 | 8 builtin suites (30 direct cases) |                      31 | Fully migrated; 1 integration case retained  |
| `smaller-conveniences.json` |              19 | 6 builtin suites (30 direct cases) |                      19 | Fully migrated                               |
| `standard-math.json`        |              16 | 7 builtin suites (16 direct cases) |                      16 | Fully migrated                               |
| `string-helpers.json`       |        42 of 43 | 10 builtin suites (43 direct cases) |                     42 | Fully migrated; 1 excluded case retained     |
| `tap.json`                  |               5 | `tap.json` (2 direct cases)        |                       4 | Fully migrated; 1 integration case retained  |
| `type-predicates.json`      |              28 | 4 builtin suites (27 direct cases) |                      27 | Fully migrated; 1 integration case retained  |
| **Total**                   |         **538** | **529 direct cases**                |                 **494** |                                              |

### Direct coverage details

`arity.json` has been fully migrated. Its direct cases cover registered builtins, named and inline language functions, zero and rest parameters, unknown names, and `arity` itself. The direct harness now has a portable named-function fixture for cases that need to add a language function to the registry.

`numeric.json` has been fully migrated into direct suites for `add`, `sub`, `mul`, `div`, `mod`, `floor`, `ceil`, `round`, `max`, `min`, `sum`, `sqrt`, `pow`, `product`, `argmin`, and `argmax`. The direct cases preserve finite-result validation, division-by-zero behavior, rounding boundaries, array validation and identities, extrema tie-breaking, and empty-array behavior. The joint `floor`/`ceil` bracket and `max`/`min` range cases remain as evaluator integration coverage.

`object-helpers.json` has been fully migrated into direct suites for `keys`, `values`, `entries`, `merge`, `hasKey`, `pick`, and `omit`. The direct cases preserve empty and single-entry results, argument validation, own-property checks, and safe handling of `__proto__`, `constructor`, and inherited property names. Eight cases remain as evaluator integration coverage for sorting or counting helper results, composing keys and values with other builtins, and explicitly coercing numeric keys with `str`.

`objects.json` has been fully migrated into direct suites for `entries`, `fromEntries`, `merge`, `hasKey`, `isObject`, `pick`, `omit`, and `mapValues`. The direct cases preserve object-order results, pair and key validation, merge precedence, plain-object recognition, key selection, callback value/key arguments, named-function dispatch, empty-input behavior, and builtin-local metering. The `entries`/`fromEntries` roundtrip and merge-through-binding cases remain as candidate integration coverage. The two entries/filter/map/fromEntries recipes remain as the baseline's excluded pipeline integration cases.

`regex.json` has been fully migrated into direct suites for `reTest`, `reMatch`, `reMatchAll`, `reReplace`, `reSplit`, and `reReplaceWith`. The direct cases preserve inline flags, anchoring, Unicode code-point behavior, numbered and named captures, unmatched optional groups, global matching and replacement, callback match objects, callback result validation, and builtin-local metering. The property-access and match-extraction pipelines remain as the baseline's two excluded evaluator integration cases.

`search-quantify.json` has been fully migrated into direct suites for `find`, `findIndex`, `findIndexIndexed`, `some`, `every`, `count`, `countIndexed`, and `sort`. The direct cases preserve first-match and no-match behavior, empty-array identities, callback arguments and short-circuiting, object results, default numeric and Unicode string ordering, comparator validation, custom ascending and descending ordering, and sort stability. The joint `find`/`findIndex` consistency case remains as evaluator integration coverage.

`smaller-conveniences.json` has been fully migrated into direct suites for `mean`, `clamp`, `trunc`, `sign`, `isInteger`, and `padEnd`. The direct cases preserve mean validation and numerically stable overflow and underflow behavior, inclusive clamping and reversed-bound validation, rounding toward zero, sign classification, integer recognition without coercion, and Unicode-aware right padding. Bundled eval assertions were split into individual direct cases, and no eval cases remain.

`standard-math.json` has been fully migrated into direct suites for `exp`, `log`, `log10`, `sin`, `cos`, `tan`, and `atan2`. The direct cases preserve exact values at standard reference points and finite-result validation for exponential overflow and logarithms outside their finite domain. No eval cases remain.

`string-helpers.json` has been fully migrated into direct suites for `strcat`, `lower`, `trim`, `join`, `split`, `startsWith`, `endsWith`, `replace`, `padStart`, and the string overload of `repeat`. The direct cases preserve variadic concatenation and validation, whitespace handling, splitting and joining, Unicode code-point behavior, boundary checks, literal replacement, left padding, string repetition, and builtin-local metering. The trim/split pipeline remains as the baseline's excluded evaluator integration case.

`type-predicates.json` has been fully migrated into direct suites for `isBool`, `isNumber`, `isString`, and `isArray`. The direct cases preserve positive and negative classification across booleans, numbers, strings, null, arrays, and objects. The conditional dispatch case remains as evaluator integration coverage.

`indexed-callbacks.json` has been fully migrated into paired direct suites for the ordinary and indexed forms of `map`, `filter`, `reduce`, `find`, `findIndex`, `some`, `every`, `count`, `flatMap`, `groupBy`, and `sortBy`. Scripted callback traces directly distinguish unary callbacks from value/index callbacks and accumulator/value callbacks from accumulator/value/index callbacks; the direct cases also preserve short-circuit behavior, stable results, and builtin-local metering. The four callback-arity rejection cases remain as evaluator integration coverage because their errors come from invoking language function declarations with the wrong number of arguments rather than from the builtins themselves.

`tap.json` has direct coverage for:

- unlabeled logging and identity
- labeled logging and identity

The direct cases additionally assert logger observations, which the removed eval cases did not. The higher-order callback case is deliberately retained as evaluator integration coverage.

`array-accessors.json` has been fully migrated into one direct suite for each represented array builtin: `head`, `last`, `tail`, `slice`, `reverse`, `indexOf`, `includes`, `length`, `concat`, `range`, `take`, `drop`, `zip`, `unique`, `repeat`, `rangeFrom`, and `rangeBy`. Its 77 direct cases preserve the source's results, validation failures, Unicode behavior, and structural-equality behavior. Six source cases bundled multiple invocations; splitting those invocations accounts for the direct count exceeding the 71 removed eval cases.

Two cases remain in `array-accessors.json` as evaluator integration coverage: `head` and `last` composed through bindings and arithmetic, and `range` passed by name as a `map` callback.

`coercion.json` has been fully migrated to direct `num` coverage for integer, decimal, negative, and zero strings; booleans; null; number passthrough; unparseable input; and non-finite string results. The integer-string case additionally asserts builtin-local metering. The arithmetic composition case remains in the eval suite as integration coverage.

`collection-ops.json` has been fully migrated into direct suites for `chunk`, `partition`, `scan`, `countBy`, and `frequencies`. The direct callback fixtures preserve callback argument and ordering behavior, while meter observations cover collection traversal. No eval cases remain because all 20 cases specified individual builtin behavior.

`comparison-logic.json` has been fully migrated into direct suites for `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `not`, `and`, and `or`. The direct cases split bundled truth tables and comparison checks while preserving structural equality, non-coercion, truthiness, and boolean validation behavior. Four candidate cases remain as evaluator integration coverage: `neq` and `not` in filter callbacks, `eq` around a nested call, and the four comparisons composed through `$and`. The conditional case remains as the baseline's excluded language-integration case.

`effects-constructors.json` has been fully migrated into direct suites for `perform`, `pure`, `bind`, `raise`, and `isTask`. The direct cases preserve constructor shapes, accepted values, continuation storage, task recognition, and argument validation. Four cases remain as evaluator integration coverage because they specify runtime-value behavior across evaluator constructs: inert array and object storage, lazy local suppression, and returning a constructed task through a closure.

`effects-handle.json` has been fully migrated to direct `handle` coverage for pure completion, named and wildcard dispatch, resume argument flow, chained binds, return clauses, short-circuiting, raise, multi-shot resume, result annotations, zero-parameter continuations, malformed tasks, and non-task rejection. The direct harness now dispatches language callback functions through the implementation's call adapter; a temporary callback fault caused 13 direct cases to fail. Seven candidate cases remain as evaluator integration coverage for nested bubbling, the state-handler program, function-valued result contracts at their eventual call sites, and recursive escaping closures. The fuel-limit case remains as the baseline's excluded runtime-limit case.

`higher-order-2.json` has been fully migrated into direct suites for `flatten`, `flattenDepth`, `setAt`, `flatMap`, `flatMapIndexed`, `groupBy`, `sortBy`, and `pipe`. The direct cases preserve flattening depth, replacement validation, callback arguments and result flattening, grouping keys, stable sorting, Unicode ordering, pipeline threading, and builtin-local meter observations. The direct harness now decodes callback and builtin fixtures nested inside arrays so `pipe` can receive a fixture pipeline; without recursive decoding, its three callback-dispatch cases failed. Seven cases remain as evaluator integration coverage for a builtin passed through `map`, nested `setAt` calls, named-function grouping, and pipelines containing inline or named language functions.

## Excluded eval files

These 30 files contain 465 cases that were not classified as direct builtin migration candidates:

| Eval file                          |   Cases | Primary concern                                |
| ---------------------------------- | ------: | ---------------------------------------------- |
| `assertions.json`                  |      21 | Runtime assertion and checked-ascription forms |
| `captured-data.json`               |       2 | Captured data semantics                        |
| `comments.json`                    |      21 | `$comment` language behavior                   |
| `composition.json`                 |       2 | Multi-feature composition                      |
| `conditionals.json`                |      39 | Conditional language forms                     |
| `curry.json`                       |      20 | User-defined closure and currying patterns     |
| `destructured-params.json`         |      20 | Parameter destructuring                        |
| `effects-lib.json`                 |      18 | Guest effects-library acceptance               |
| `escaping-closures.json`           |       6 | Escaping closure semantics                     |
| `fn-calls.json`                    |       4 | Function-call mechanics                        |
| `fuel-limits.json`                 |      37 | Evaluator fuel accounting                      |
| `function-body-validation.json`    |       3 | Function-body validation                       |
| `higher-order.json`                |      11 | User-function and pipeline integration         |
| `inline-functions.json`            |       2 | Anonymous-function semantics                   |
| `let-regressions.json`             |      16 | `$let` regressions                             |
| `local-recursion.json`             |      15 | Local recursion                                |
| `memory-limits.json`               |      14 | Runtime value-size limits                      |
| `method-calls.json`                |       7 | Method-call syntax                             |
| `name-resolution.json`             |      14 | Name resolution                                |
| `named-functions.json`             |      10 | Named functions and recursion                  |
| `parameter-defaults.json`          |      29 | Parameter defaults                             |
| `primitives.json`                  |       6 | Literal evaluation                             |
| `property-access.json`             |      57 | Property-access semantics                      |
| `safety-limits.json`               |      14 | Evaluator safety limits                        |
| `scoping.json`                     |      10 | Lexical scoping                                |
| `special-object-keys.json`         |      25 | Object-key and construction-route safety       |
| `strict-parameter-runtime.json`    |      22 | Runtime parameter enforcement                  |
| `structural-depth.json`            |       5 | Structural-depth limits                        |
| `trailing-parameter-omission.json` |       6 | Parameter omission                             |
| `variables.json`                   |       2 | Variable semantics                             |
| **Total**                          | **465** |                                                |

## Borderline decisions

The following decisions define the 538-case baseline:

- `curry.json` was excluded because `curry` and `autoCurry` are user-defined json-fn functions, not registry builtins.
- `higher-order.json` was excluded because its primary intent is exercising user functions and pipelines through `map`, `filter`, and `reduce`.
- `fn-calls.json` builtin calls were excluded because they are smoke tests for call mechanics.
- One `comparison-logic.json` case, `$eq: can be used directly in conditionals`, was excluded because the conditional and parameter binding are the subject.
- `num: used in arithmetic after coercion` was included because `num` remains the subject despite the subsequent arithmetic operation.
- `trim then split pipeline` was excluded as integration, while the explicit `split and join roundtrip` case was included as joint builtin behavior.
- Two `objects.json` entries/filter/map/fromEntries recipes were excluded as pipelines. Direct merge behavior remained included.
- Two `regex.json` property-access and extraction pipelines were excluded as integration.
- The `handle` fuel-budget case was excluded; the other 27 `effects-handle.json` cases were included.
- `effects-lib.json` was excluded as guest-library acceptance rather than individual builtin behavior.
- Limit suites were excluded even when a builtin was used to trigger the limit.
- `special-object-keys.json` was excluded because object-key safety is the primary concern.
- `assertions.json` was excluded because `$nonnull` and checked `$as` are language forms, not registry builtins.

The most sensitive judgment is `num: used in arithmetic after coercion`. Excluding it would make the baseline 537. The recorded baseline keeps it included.

## Migration procedure

For each builtin:

1. Create `spec/cases/builtins/<category>/<builtin>.json`.
2. Move or rewrite direct result, validation, edge-case, callback, and short-circuit behavior using `builtin.schema.json`.
3. Add direct cases for behavior that the eval wrapper could not observe, such as callback invocation traces, logger output, or builtin-local metering.
4. Run the direct suite and inject a temporary implementation fault when introducing a new harness dimension.
5. Review the corresponding eval cases:
   - remove cases that only duplicate direct builtin behavior;
   - retain a small number of dispatch and composition smoke tests;
   - move integration cases to a more accurately named eval suite when useful.
6. Update this document's direct coverage, removed count, and status.

A source file is **fully migrated** when every candidate case has either been removed in favor of direct coverage or explicitly reclassified and retained as evaluator integration coverage.
