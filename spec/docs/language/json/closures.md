# Closures

When a function-body expression is evaluated, outer variables are captured by
substituting their current values for `$var` references. This also occurs when
the body is used directly as a call's callee. Substitution respects scope:

- `$params` and `$captures` shadow outer names;
- `$let` names shadow outer names recursively in both their binding expressions
  and `$in`;
- unrelated outer references within those scopes are still captured.

```json
{
  "$params": ["x"],
  "$return": {
    "$params": ["y"],
    "$return": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] }
  }
}
```

Called with `[10]`, returns:

```json
{
  "$params": ["y"],
  "$return": { "$call": "add", "$args": [10, { "$var": "y" }] }
}
```

The returned value remains callable as a function body.

## Captured local functions

If a closure refers to an enclosing
[local function](functions.md#local-recursive-functions), that function is
stored under the closure's `$captures` field. Names in call position remain
names, preserving recursion and mutual recursion after the closure leaves the
defining `$let`.

```json
{
  "$params": ["base"],
  "$return": {
    "$let": {
      "go": {
        "$params": ["x"],
        "$return": {
          "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
          "$then": { "$var": "base" },
          "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
        }
      }
    },
    "$in": { "$var": "go" }
  }
}
```

Called with `[42]`, this returns:

```json
{
  "$params": ["x"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
    "$then": 42,
    "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
  },
  "$captures": {
    "go": {
      "$params": ["x"],
      "$return": {
        "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 0] },
        "$then": 42,
        "$else": { "$call": "go", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
      }
    }
  }
}
```

Only transitively referenced local functions are captured. A name shadowed by
the returned body's `$params`, `$captures`, or nested `$let` is not captured
from an outer scope.

Module functions and builtins are not captured. They resolve by name when the
closure is called.

