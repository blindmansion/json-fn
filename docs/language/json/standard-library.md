# Standard Library

All standard-library functions, signatures, and descriptions are listed in the
generated [Builtins reference](../../builtins/builtins.md).

## Arithmetic

Arithmetic builtins reject results that are `NaN` or infinite, since those are
not JSON numbers.

Portable numeric semantics use finite IEEE 754 binary64 values. Implementations
round each primitive arithmetic operation to binary64 and preserve the
operation order specified by a builtin. Aggregate folds are evaluated from left
to right.

`mean` first sums its input from left to right and divides the finite sum by the
array length. If that sum overflows, it recomputes from left to right by adding
each value divided by the length. The fallback permits a finite mean when the
unscaled sum is not finite; using it only after overflow avoids needless
underflow for subnormal inputs.

Transcendental builtins such as `sin`, `cos`, and `log` use the host math
library. Their least-significant bits are not guaranteed to agree across
implementations.

## Comparison

`eq`/`neq` are **structural**: arrays and objects are compared recursively and object key order does not matter (on scalars this is just `===`). This is the only equality — json-fn values are immutable JSON, so there is no observable reference identity to compare. Equality does **not** coerce types, so `true` is not `1` and `"1"` is not `1`. The same structural equality backs `includes`/`indexOf` element membership. (`$match` compares its subject against case values by equality too, but restricts both to scalars — see [Scalar Value Match](expressions.md#scalar-value-match--match-cases-else).)

## Arrays

`range(end)` and `flatten(array)` remain unary so they can be passed directly
to ordinary one-argument higher-order functions. Use `rangeFrom(start, end)`,
`rangeBy(start, end, step)`, and `flattenDepth(array, depth)` for their
fixed-arity extended forms.

## Regex

Patterns are plain strings. Flags are specified via inline `(?flags)` prefix: `i` (case-insensitive), `m` (multiline), `s` (dotall), `u` (Unicode). Example: `"(?i)hello"`.

Match results are objects with `match` (full matched text), `index` (start position), `groups` (positional captures, `null` for unmatched optional groups), and `named` (named capture groups, empty object if none).

## Higher-Order Functions

Higher-order functions take **callback first, data second**. This is consistent
across all HOFs: `map(callback, arr)`, `filter(callback, arr)`,
`partition(callback, arr)`, `countBy(callback, arr)`,
`reduce(callback, init, arr)`, `scan(callback, init, arr)`, and so on.

Higher-order functions can invoke json-fn callbacks. The callback argument can be a function reference (`{ "$fn": "name" }`), an inline function body, or a string name.

At runtime, a callback may be an inline function, a function reference, or a
plain string name. The static checker contextually types bare inline functions
and checks typed function references; it does not resolve string names.
Bare contextual callbacks must declare the exact required, optional, and rest
shape supplied by the builtin; those three parts are compared independently.
Referenced and `$sig`-annotated callbacks must also have a compatible complete
shape. When a referenced function intentionally has a different public shape,
use an explicit wrapper that declares the builtin's full callback shape and
forwards the arguments the function accepts.

The ordinary array HOFs supply only the item (`reduce` supplies accumulator and
item). Their `*Indexed` counterparts additionally supply the integer index.
This is a breaking API change: remove an unused index parameter from callbacks
passed to an ordinary HOF, or rename the call to its `*Indexed` counterpart when
the callback uses the index. For an indexed wrapper that ignores the supplied
index, declare it explicitly with an ignored name such as `_index`.

`groupBy`, `groupByIndexed`, and `countBy` convert numeric keys to strings before
using them as object keys. `frequencies` performs the same conversion for every
scalar value, so numeric `1` and string `"1"` share a bucket. Counting safely
supports object-special keys such as `__proto__` and `constructor`.
`flatMap` and `flatMapIndexed` splice array callback results into the output and
keep non-array results as single elements; nested arrays are therefore
flattened by exactly one level.
`reReplaceWith` callbacks must return `string`; the runtime rejects other
return values. `mapValues` is typed as a string-keyed map and does not preserve
exact input keys. `filter` and `find` do not infer type predicates from callback
logic.

## Tasks & Effects

These build and run **tasks** — the effect representation described under [Tasks & Effects](tasks-and-effects.md). Constructors build inert, tagged records; `handle` interprets them in-language.

`isTask(a)` reports whether a value is a task.

## Debugging

`tap` is a debugging helper that passes a value and optional label to
the host-configured logger, then returns the value unchanged:

```json
{
  "$call": "map",
  "$args": [
    { "$params": ["x"], "$return": { "$call": "tap", "$args": [{ "$var": "x" }, "item"] } },
    [1, 2, 3]
  ]
}
```

By default, `tap` is inert and produces no output. Host integrations may pass a logger when constructing the standard library to capture or emit logs. The output destination and format are host-defined.

> **Note: lazy bindings.** A `tap` call placed in an unreferenced
> [`$let`](expressions.md#let-binding--let-in) binding is never evaluated. To log inside a
> function body, either put the `tap` call in the path of `$return`, or
> reference the debug binding from `$in` so it is forced.

