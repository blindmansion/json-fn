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

The direct suite contains 168 cases:

- `spec/cases/builtins/arithmetic/floor.json`: 3
- `spec/cases/builtins/arithmetic/max.json`: 4
- `spec/cases/builtins/arrays/*.json`: 88 across 19 builtin suites
- `spec/cases/builtins/comparison/*.json`: 23 across 6 builtin suites
- `spec/cases/builtins/coercion/num.json`: 10
- `spec/cases/builtins/higher-order/*.json`: 14 across 4 builtin suites
- `spec/cases/builtins/introspection/arity.json`: 10
- `spec/cases/builtins/logic/*.json`: 14 across 3 builtin suites
- `spec/cases/builtins/debugging/tap.json`: 2

These establish direct coverage, and the corresponding duplicate eval cases have been removed. Direct case counts are not expected to map one-to-one to eval cases: one direct case may replace part of a combined eval case, while direct callback and observation cases may add coverage that did not previously exist.

Migration status:

- Direct builtin cases added: 168
- Candidate eval cases removed: 153 / 538
- Candidate eval cases reclassified as integration coverage: 8 / 538
- Fully migrated source files: 6 / 19
- Partially covered source files: `numeric.json`, `indexed-callbacks.json`

## Candidate inventory

| Source eval file            | Candidate cases | Direct coverage                    | Eval candidates removed | Status                                       |
| --------------------------- | --------------: | ---------------------------------- | ----------------------: | -------------------------------------------- |
| `arity.json`                |              10 | `arity.json` (10 direct cases)     |                      10 | Fully migrated                               |
| `array-accessors.json`      |              73 | 17 array suites (77 direct cases)  |                      71 | Fully migrated; 2 integration cases retained |
| `coercion.json`             |              11 | `num.json` (10 direct cases)        |                      10 | Fully migrated; 1 integration case retained  |
| `collection-ops.json`       |              20 | 5 builtin suites (20 direct cases) |                      20 | Fully migrated                               |
| `comparison-logic.json`     |        35 of 36 | 9 builtin suites (37 direct cases) |                      31 | Fully migrated; 4 integration cases retained |
| `effects-constructors.json` |              14 | —                                  |                       0 | Not started                                  |
| `effects-handle.json`       |        27 of 28 | —                                  |                       0 | Not started                                  |
| `higher-order-2.json`       |              43 | —                                  |                       0 | Not started                                  |
| `indexed-callbacks.json`    |              15 | `mapIndexed.json` (5 direct cases) |                       0 | Partial direct coverage                      |
| `numeric.json`              |              55 | `floor.json` (3), `max.json` (4)   |                       7 | Partial direct coverage                      |
| `object-helpers.json`       |              28 | —                                  |                       0 | Not started                                  |
| `objects.json`              |        32 of 34 | —                                  |                       0 | Not started                                  |
| `regex.json`                |        33 of 35 | —                                  |                       0 | Not started                                  |
| `search-quantify.json`      |              32 | —                                  |                       0 | Not started                                  |
| `smaller-conveniences.json` |              19 | —                                  |                       0 | Not started                                  |
| `standard-math.json`        |              16 | —                                  |                       0 | Not started                                  |
| `string-helpers.json`       |        42 of 43 | —                                  |                       0 | Not started                                  |
| `tap.json`                  |               5 | `tap.json` (2 direct cases)        |                       4 | Fully migrated; 1 integration case retained  |
| `type-predicates.json`      |              28 | —                                  |                       0 | Not started                                  |
| **Total**                   |         **538** | **168 direct cases**               |                 **153** |                                              |

### Direct coverage details

`arity.json` has been fully migrated. Its direct cases cover registered builtins, named and inline language functions, zero and rest parameters, unknown names, and `arity` itself. The direct harness now has a portable named-function fixture for cases that need to add a language function to the registry.

`numeric.json` has direct coverage for these builtin dimensions:

- `floor`: positive decimal, negative decimal, and unchanged integer
- `max`: largest result, negative/decimal values, empty-array rejection, and non-number rejection

The directly covered `floor` and `max` cases have been removed from the eval suite. The remaining dimensions are zero, a single-element array, and non-array rejection. Joint `floor`/`ceil` and `max`/`min` cases remain as integration coverage.

`indexed-callbacks.json` has partial direct coverage for `mapIndexed`:

- exact value/index callback arguments
- callback dispatch to another builtin
- empty-input callback suppression
- callback error propagation
- non-array validation
- builtin-local meter charging

Its original `map and mapIndexed use unary and indexed callbacks` case combines two builtins, so it is not considered migrated until `map` also has direct coverage and the combined eval case is either removed or explicitly retained as integration coverage.

`tap.json` has direct coverage for:

- unlabeled logging and identity
- labeled logging and identity

The direct cases additionally assert logger observations, which the removed eval cases did not. The higher-order callback case is deliberately retained as evaluator integration coverage.

`array-accessors.json` has been fully migrated into one direct suite for each represented array builtin: `head`, `last`, `tail`, `slice`, `reverse`, `indexOf`, `includes`, `length`, `concat`, `range`, `take`, `drop`, `zip`, `unique`, `repeat`, `rangeFrom`, and `rangeBy`. Its 77 direct cases preserve the source's results, validation failures, Unicode behavior, and structural-equality behavior. Six source cases bundled multiple invocations; splitting those invocations accounts for the direct count exceeding the 71 removed eval cases.

Two cases remain in `array-accessors.json` as evaluator integration coverage: `head` and `last` composed through bindings and arithmetic, and `range` passed by name as a `map` callback.

`coercion.json` has been fully migrated to direct `num` coverage for integer, decimal, negative, and zero strings; booleans; null; number passthrough; unparseable input; and non-finite string results. The integer-string case additionally asserts builtin-local metering. The arithmetic composition case remains in the eval suite as integration coverage.

`collection-ops.json` has been fully migrated into direct suites for `chunk`, `partition`, `scan`, `countBy`, and `frequencies`. The direct callback fixtures preserve callback argument and ordering behavior, while meter observations cover collection traversal. No eval cases remain because all 20 cases specified individual builtin behavior.

`comparison-logic.json` has been fully migrated into direct suites for `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `not`, `and`, and `or`. The direct cases split bundled truth tables and comparison checks while preserving structural equality, non-coercion, truthiness, and boolean validation behavior. Four candidate cases remain as evaluator integration coverage: `neq` and `not` in filter callbacks, `eq` around a nested call, and the four comparisons composed through `$and`. The conditional case remains as the baseline's excluded language-integration case.

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
