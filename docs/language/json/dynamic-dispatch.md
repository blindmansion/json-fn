# Dynamic Dispatch

The callee `$call` can be a `$var` reference or any expression that evaluates to a function name or body.

```json
{
  "$params": ["fnName"],
  "$return": { "$call": { "$var": "fnName" }, "$args": [3, 4] }
}
```

Called with `["add"]` returns `7`. Called with `["mul"]` returns `12`.

