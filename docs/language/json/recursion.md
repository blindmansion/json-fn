# Recursion

Functions can call themselves by name if registered in the function registry.

```json
{
  "$params": ["n"],
  "$return": {
    "$if": { "$call": "lte", "$args": [{ "$var": "n" }, 1] },
    "$then": 1,
    "$else": {
      "$call": "mul",
      "$args": [
        { "$var": "n" },
        { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "n" }, 1] }] }
      ]
    }
  }
}
```

## Local Recursive Functions

`$let` bindings whose literal values are function bodies can be called by name
within their scope. This enables recursion without registering them in the
persistent module/host registry. Mutual recursion between sibling bindings
works too.

```json
{
  "$let": {
    "fact": {
      "$sig": {
        "required": [{ "type": "integer" }],
        "optional": [],
        "returns": { "type": "integer" }
      },
      "$params": ["x"],
      "$return": {
        "$if": { "$call": "lte", "$args": [{ "$var": "x" }, 1] },
        "$then": 1,
        "$else": {
          "$call": "mul",
          "$args": [
            { "$var": "x" },
            { "$call": "fact", "$args": [{ "$call": "sub", "$args": [{ "$var": "x" }, 1] }] }
          ]
        }
      }
    }
  },
  "$in": { "$call": "fact", "$args": [5] }
}
```

Local function names can shadow persistent registry functions and do not leak
outside their `$let`.

