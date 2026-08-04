# Standard library

All standard-library functions, signatures, and descriptions are listed in the
generated [builtins reference](../../builtins/builtins.md). This page defines
shared semantic rules that are not evident from individual signatures.

## Arithmetic

Arithmetic builtins reject results that are `NaN` or infinite, since those are
not JSON numbers.

Numbers are finite IEEE 754 binary64 values. Each primitive arithmetic
operation rounds to binary64. Aggregate folds run from left to right.

`mean` first sums its input from left to right and divides the finite sum by the
array length. If that sum overflows, it recomputes from left to right by adding
each value divided by the length. The fallback permits a finite mean when the
unscaled sum is not finite; using it only after overflow avoids needless
underflow for subnormal inputs.

Transcendental builtins such as `sin`, `cos`, and `log` are not guaranteed to
produce bit-identical least-significant digits across environments.

## Comparison

`eq` and `neq` compare arrays and objects recursively. Object key order does
not matter. Equality does not coerce types, so `true`, `1`, and `"1"` are
distinct. There is no reference-identity equality.

`includes` and `indexOf` use the same structural equality. `$match` uses it for
scalar subjects and cases.

## Arrays

`range(end)` and `flatten(array)` are unary. Their extended forms are
`rangeFrom(start, end)`, `rangeBy(start, end, step)`, and
`flattenDepth(array, depth)`.

## Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall), `u` (Unicode). Example: `"(?i)hello"`.

Match results are objects with `match` (full matched text), `index` (start position), `groups` (positional captures, `null` for unmatched optional groups), and `named` (named capture groups, empty object if none).

## Higher-order functions

Higher-order functions take the callback before the data:
`map(callback, arr)`, `filter(callback, arr)`,
`partition(callback, arr)`, `countBy(callback, arr)`,
`reduce(callback, init, arr)`, and `scan(callback, init, arr)`.

A callback may be a function reference, an inline function body, or a string
name.

Inline callbacks receive a contextual type. Their required, optional, and rest
parameters must exactly match the shape supplied by the builtin. Referenced and
`$sig`-annotated callbacks must have a compatible complete shape. String names
are not statically resolved. Use a wrapper when a function's public parameter
shape differs from the callback shape.

Ordinary array functions supply only the item; `reduce` and `scan` supply the
accumulator and item. Their `*Indexed` forms also supply the integer index.

`groupBy`, `groupByIndexed`, and `countBy` convert numeric keys to strings.
`frequencies` converts every scalar key to a string, so numeric `1` and string
`"1"` share a bucket. Object-special keys such as `__proto__` and `constructor`
are ordinary keys.

`flatMap` and `flatMapIndexed` splice array callback results into the output and
keep non-array results as single elements; nested arrays are therefore
flattened by exactly one level.

`reReplaceWith` callbacks must return strings. `mapValues` has a string-keyed
map result type and does not preserve exact input keys. `filter` and `find` do
not infer type predicates from callback bodies.

## Tasks and effects

Task builtins are defined in [Tasks and effects](tasks-and-effects.md).
Constructors build inert records; `handle` interprets them.
`isTask(value)` reports whether a value is a plain object with a string-valued
`@task` tag.

`isTask(a)` reports whether a value is a task.

## Debugging

`tap(value, label?)` sends its arguments to a configured logger and returns
`value` unchanged. Without a logger it produces no output. A `tap` in an
unreferenced lazy binding is not evaluated.

