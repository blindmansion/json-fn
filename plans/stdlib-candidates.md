# Suggested stdlib candidates

These builtins were proposed because they replace callback-heavy, recursive, or
allocation-heavy guest implementations. The highest-value collection operations
are now implemented by the canonical TypeScript interpreter; smaller
conveniences remain candidates.

## Implemented: highest-value collection operations

- `product(array<number>) -> number` — multiply all elements; the empty product
  is `1`. Reject non-numeric elements and non-finite results.
- `range(end)`, `rangeFrom(start, end)`, `rangeBy(start, end, step)` — separate
  fixed-arity, half-open ranges. Reject a zero step.
- `chunk(array<T>, size) -> array<array<T>>` — consecutive fixed-size chunks,
  with a possibly shorter final chunk. Require a positive integer size.
- `partition(predicate, array<T>) -> [array<T>, array<T>]` — return matching and
  non-matching elements after one predicate call per element.
- `scan(callback, initial, array<T>) -> array<U>` — return each intermediate
  accumulator, in input order.
- `countBy(keyFn, array<T>) -> object<number>` and
  `frequencies(array<scalar>) -> object<number>` — count directly instead of
  allocating grouped arrays.
- `argmin(array<number>)` / `argmax(array<number>) -> integer | null` — return
  the first best index, or `null` for an empty array.
- `flatten(array)` and `flattenDepth(array, depth)` — retain exact unary
  flattening and provide a separate depth-aware form requiring a non-negative
  integer depth.

## Smaller conveniences

- `mean(array<number>)` — reject an empty array.
- `clamp(value, min, max)`
- `trunc(value)`
- `sign(value)`
- `isInteger(value)`
- `padEnd(string, length, fill?)`

Future implementation priority should focus on the remaining scalar
conveniences.
