# Modules and scope

A module is an object that maps names to expressions. Its entries form the
outermost lexical scope.

- Every entry is available through `$var`.
- An entry whose literal value is a function body is also callable by name.
- Entries are strict and dependency-ordered. When an entry is selected for
  invocation, the value entries in its **static reference closure** — the
  same transitive `$var` / named-`$call` / `$fn` relation, with the same
  call-position exemption, as
  [`$let` dependency order](expressions.md#dependency-order) — evaluate at
  invocation start, dependency-ordered, before the entry function is invoked.
  Entries outside that closure do not evaluate.
- Entry evaluation is per invocation; there is no cross-invocation
  memoization. Resumed continuations do not re-enter module entries: captured
  values ride the continuation record, and module functions stay available by
  name.
- Entries need not be topologically sorted in source. Sibling functions may
  recurse mutually through calls; dependency cycles among evaluated entries
  are errors, with the same
  [error identity](execution-limits.md#circular-variable-dependencies) as
  `$let` cycles.
- Module functions remain available by name and are not copied into a closure's
  `$captures`. Module *value* entries referenced from a closure body are the
  other half of the same rule: they are captured by value into its record.

```json
{
  "W": 20,
  "H": 12,
  "SIZE": { "$call": "mul", "$args": [{ "$var": "W" }, { "$var": "H" }] },
  "area": {
    "$sig": { "required": [], "optional": [], "returns": { "type": "integer" } },
    "$params": [],
    "$return": { "$var": "SIZE" }
  }
}
```

Selecting `area` as the entry returns `240`.

## Name resolution

Names resolve from the innermost scope outward:

1. the current `$let`;
2. function parameters and the applied function value's capture record;
3. enclosing expression scopes;
4. module entries;
5. builtins and host functions.

The capture record resolves as one flat, mutually recursive binding group: a
function-valued or open-body record entry applied by name resolves its own
body through the same containing record (see
[Closures](closures.md#captured-local-functions)).

A `$let` shadows all outer variable bindings. A literal function-body binding
also shadows outer callables in `$call` position.

Only a binding whose literal value is a function body is added to callable
scope. A non-function module entry named `map`, for example, shadows
`{"$var":"map"}` but does not shadow `{"$call":"map",...}`. A literal module
function shadows both.

Parameter defaults can refer to captures, parameter bindings and defaults,
module entries, and outer callables. They cannot refer to a `$let` inside the
function's `$return`.

A module root is not a function body or a `$let`. It may contain named entries
and `$types`. Modules do not define imports, exports, or re-exports.

