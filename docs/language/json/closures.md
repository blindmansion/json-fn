# Closures

When a function body is returned as a value (not called), outer variables are
captured by substitution. The interpreter walks the returned body and replaces
`$var` references with their current values, respecting scope boundaries.
Inner `$params`, `$captures`, and `$let` names shadow outer names. A `$let`
masks its names recursively in both its binding expressions and its `$in`,
while unrelated outer references inside either part are still substituted.

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

The returned body is a valid function body that can be called subsequently.

## Escaping closures carry the local functions they call

Capture also keeps an escaping closure **self-contained** when it calls an
enclosing [local function](functions.md#local-recursive-functions) by name. Names in call
position that resolve to a local function stay literal (so recursion and mutual
recursion keep dispatching by name), and capture serializes the required
closed-over definitions under the returned body's `$captures` field. A closure
that recurses—or calls a sibling local function—therefore remains callable
after it leaves the `$let` scope that defined those functions.

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

Called with `[42]`, this returns a body whose `$captures` carries `go` so it
still recurses when invoked later:

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

Only the local functions actually referenced (transitively) are captured. A
name shadowed by the returned body's own `$params`, `$captures`, or nested
`$let` is not captured from outside—the inner binder wins.

**Module-level (registry) functions are not captured.** `$captures` applies only
to functions defined by an enclosing expression scope that disappears when the
closure escapes it. A top-level module function persists in the program
registry and resolves by name at call time like a stdlib builtin. A closure
serialized outside the program therefore carries required `$let` functions,
but still relies on the target host providing the module and stdlib registry.

