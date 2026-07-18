# Suggested stdlib candidates

These builtins were proposed because they replace callback-heavy, recursive, or
allocation-heavy guest implementations. They are not currently implemented by
the canonical TypeScript interpreter.

## Highest-value collection operations

- `product(array<number>) -> number` — multiply all elements; the empty product
  is `1`. Reject non-numeric elements and non-finite results.
- `range(end)`, `range(start, end)`, `range(start, end, step)` — extend the
  existing one-argument, half-open range. Reject a zero step.
- `chunk(array<T>, size) -> array<array<T>>` — consecutive fixed-size chunks,
  with a possibly shorter final chunk. Require a positive integer size.
- `partition(predicate, array<T>) -> [array<T>, array<T>]` — return matching and
  non-matching elements after one predicate call per element.
- `scan(callback, initial, array<T>) -> array<U>` — return each intermediate
  accumulator, in input order.
- `countBy(keyFn, array<T>) -> object<number>` and/or
  `frequencies(array<scalar>) -> object<number>` — count directly instead of
  allocating grouped arrays.
- `argmin(array<number>)` / `argmax(array<number>) -> integer | null` — return
  the first best index, or `null` for an empty array.
- `flatten(array, depth)` — extend the existing one-level `flatten`; require a
  non-negative integer depth.

## Smaller conveniences

- `mean(array<number>)` — reject an empty array.
- `clamp(value, min, max)`
- `trunc(value)`
- `sign(value)`
- `isInteger(value)`
- `padEnd(string, length, fill?)`

Implementation priority should favor operations that fuse traversal or remove
interpreted callbacks: aggregates and expanded `range`, then `chunk`,
`partition`, and `scan`, followed by scalar conveniences.
