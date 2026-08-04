# Patterns

## Calling a registered function

Register the function body in the function registry, call it by name:

```json
{ "$call": "myFunction", "$args": [1, 2, 3] }
```

## Inline anonymous function

Use a function body directly as the `$call` callee:

```json
{
  "$call": {
    "$params": ["x"],
    "$return": { "$call": "mul", "$args": [{ "$var": "x" }, { "$var": "x" }] }
  },
  "$args": [5]
}
```

## Pipeline (filter -> map -> reduce)

Use `$let` bindings to name intermediate steps:

```json
{
  "$let": {
    "nums": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "evens": { "$call": "filter", "$args": [{ "$fn": "isEven" }, { "$var": "nums" }] },
    "doubled": { "$call": "map", "$args": [{ "$fn": "double" }, { "$var": "evens" }] }
  },
  "$in": { "$call": "reduce", "$args": [{ "$fn": "add" }, 0, { "$var": "doubled" }] }
}
```

Or use `pipe`:

```json
{ "$call": "pipe", "$args": [[{ "$fn": "neg" }, { "$fn": "abs" }, { "$fn": "str" }], -5] }
```

## Currying / Partial Application

Return a function body from a function to capture arguments:

```json
{
  "$params": ["a"],
  "$return": {
    "$params": ["b"],
    "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
  }
}
```

## Dynamic Apply

Use `apply` to call a function with a dynamically constructed argument array:

```json
{ "$call": "apply", "$args": [{ "$var": "targetFn" }, { "$var": "collectedArgs" }] }
```

## Object Transformation

Use `entries` -> HOF -> `fromEntries` to transform objects:

```json
{
  "$let": {
    "pairs": { "$call": "entries", "$args": [{ "$var": "obj" }] },
    "filtered": {
      "$call": "filter",
      "$args": [
        {
          "$params": ["pair"],
          "$return": { "$call": "gt", "$args": [{ "$get": 1, "$from": { "$var": "pair" } }, 3] }
        },
        { "$var": "pairs" }
      ]
    }
  },
  "$in": { "$call": "fromEntries", "$args": [{ "$var": "filtered" }] }
}
```

