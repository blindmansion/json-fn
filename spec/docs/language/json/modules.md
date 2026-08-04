# Modules and scope

A module is an object that maps names to expressions. Its entries form the
outermost lexical scope.

- Every entry is available through `$var`.
- An entry whose literal value is a function body is also callable by name.
- Entries are lazy, memoized, order-independent, mutually recursive, and
  cycle-checked.
- Module functions remain available by name and are not copied into a closure's
  `$captures`.

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
2. function parameters and `$captures`;
3. enclosing expression scopes;
4. module entries;
5. builtins and host functions.

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

