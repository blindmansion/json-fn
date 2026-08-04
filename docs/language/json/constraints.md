# Constraints

- `$var` must be the sole key; its value is a plain variable name (no path notation, no `$get` sibling).
- `$let`/`$in` must be the only two keys; both are required, and `$let` must be
  a non-empty object of bindings.
- `$get`/`$from` must be the only two keys; both are required. This is the only property-access form.
- `$if`/`$then`/`$else` must all be present, exactly three keys.
- `$cond` may have only `$cond` and optional `$else`; each entry must be a two-element array.
- `$match` must have `$match`, `$cases`, and `$else`; `$match` and case values must evaluate to scalar JSON values.
- `$and` must be the sole key; value must be an array of expressions.
- `$or` must be the sole key; value must be an array of expressions.
- `$raw` must be the sole key.
- A function call has exactly `$call` (the callee) and `$args` (an array of arguments) and no other keys.
- A function reference has `$fn` as its sole key; `$fn` is never an array.
- `$return` cannot coexist with `$call` or `$fn`.
- A source function body has `$return` and only optional `$params`, `$sig`, and
  string-valued `$comment`; `$captures` and `$runtimeContract` are reserved
  runtime fields, and `$types` is module-only.
- `$comment` (with a string value) is allowed as a sibling key in any expression form and does not count toward "sole key" / "exactly N keys" constraints. In plain data objects it is stripped from the output.
- Truthiness: `0`, `""`, `null`, `false` are falsy; everything else is truthy.
