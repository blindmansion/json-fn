# Function Bodies

A source function body is a closed structural record:

- `$return` — required result expression;
- `$params` — optional parameter layout;
- `$sig` — optional static signature;
- `$comment` — optional string comment.

Evaluator-produced function values may additionally contain `$captures` and
`$runtimeContract`:

- `$captures` is a non-null object mapping names to function bodies. Captured
  functions are available by `$var`, `$fn`, and `$call` in parameter defaults
  and `$return`.
- `$runtimeContract` is evaluator-owned serializable callable-boundary state.

These are runtime closure/boundary state, not authoring-level local bindings.
The shorthand printer rejects them rather than silently dropping them.
`$types` is module-only and is never valid on a function body. Any other
ordinary or reserved field is invalid.

## Parameters — `$params`

An ordered array of parameter **slots**. Each slot is one of:

- a name string — a required positional parameter;
- `{ "$param": name, "$optional": true }` — an optional positional parameter;
- `{ "$param": name, "$default": expression }` — a defaulted positional parameter;
- `"...rest"` — a rest collector (see [Rest Parameters](#rest-parameters));
- `{ "$fields": [...] }` — an object pattern (see
  [Object-Pattern Parameters](#object-pattern-parameters--fields)).

Descriptor objects have exactly the keys shown. Fixed arguments are bound
positionally, one per slot.

```json
{
  "$params": ["a", { "$param": "b", "$default": 1 }],
  "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
}
```

A name string is required: omitting its argument is an error. An optional
parameter may be omitted and then binds `null`. A defaulted parameter may be
omitted, in which case its `$default` expression is evaluated lazily when the
binding is first read. Calls cannot skip a positional slot: passing `null`
explicitly supplies `null` and suppresses either omission behavior.

Required positional slots—including object patterns—must precede all optional
and defaulted positional slots. Optional and defaulted slots may be mixed in
the omittable suffix, followed only by a final rest parameter. For example,
`["required", { "$param": "fallback", "$default": 0 }, "...rest"]` is valid,
while `[{ "$param": "fallback", "$default": 0 }, "required"]` is not.

Every name bound by a parameter list must be unique across positional
parameters, object-pattern fields, and the rest parameter. Repeating a name in
the same `$params` array is invalid, including repetitions across two different
object patterns.

A function without a rest parameter rejects any argument beyond its exact
number of fixed slots; extra fixed arguments are not ignored. A rest parameter
allows additional arguments as described below.

## Rest Parameters

A final parameter starting with `...` collects all arguments remaining after
the fixed slots into an array. It receives an empty array when there are no
remaining arguments.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

Called with args `[1, 2, 3]`: `first` = `1`, `rest` = `[2, 3]`.

## Object-Pattern Parameters — `$fields`

A `$params` slot may be an **object pattern** instead of a name string: an object
of the exact shape `{ "$fields": [...] }`. Its non-empty array contains required
field-name strings, optional descriptors of the form
`{ "$field": name, "$optional": true }`, and/or defaulted descriptors of the
form `{ "$field": name, "$default": expression }`. Field descriptors have
exactly the keys shown. The pattern destructures one positional object argument,
binding each field to a local of the same name.

```json
{
  "$params": [{ "$fields": ["from", "to"] }],
  "$return": { "$call": "sub", "$args": [{ "$var": "to" }, { "$var": "from" }] }
}
```

Called with args `[{ "from": 3, "to": 7 }]`: `from` = `3`, `to` = `7`, result `4`. The **calling convention is unchanged** — this is an ordinary positional call passing one plain-data object; the "named-ness" lives entirely in the parameter.

Binding rules for a pattern slot at position `i`, where `v` is the supplied
`i`-th argument:

- The whole pattern argument is required, even if every field is optional or
  defaulted.
- `v` must be a plain object (not an array and not `null`). Any other value,
  including explicit `null`, is an error.
- A required field-name string must be an own property of `v`; an absent or
  inherited field is an error.
- An absent optional field binds `null`.
- A defaulted field uses its `$default` only when the own property is absent.
  The default is evaluated lazily when the binding is first read.
- An own property whose value is `null` is supplied data: it binds `null` and
  suppresses a field default.
- Extra object keys are ignored.

Supplied field bindings are established at call time; defaulted bindings remain
lazy. Within the body they are visible via `$var` to `$return`, including any
nested `$let`, and they **shadow** same-named outer bindings until an inner
`$let` binds the same name.

Additional rules:

- `$fields` must be a **non-empty** array of field-name strings and/or
  `{ "$field": name, "$optional": true }` or
  `{ "$field": name, "$default": expression }` descriptors. Field names must
  not contain `.` or `[`.
- A `$fields` object is valid only as a `$params` slot; it may not be preceded by `...`.
- A pattern slot consumes exactly **one required** positional argument, so it
  may appear with other required slots before optional/defaulted slots, and
  before a final rest parameter (`["label", { "$fields": ["x", "y"] }]`,
  `[{ "$fields": ["x"] }, "...rest"]`).
- Optional/defaulted fields affect property omission only. Even a pattern whose
  fields are all omittable remains a required positional slot and cannot follow
  an optional or defaulted positional parameter.
- `arity` counts every non-rest slot once, including optional/defaulted slots
  and object patterns.

Rename and nested patterns are not supported.

## Expression-local bindings

Use [`$let`/`$in`](expressions.md#let-binding--let-in) wherever an expression needs local
bindings. Inside a function's `$return`, its bindings can reference the
function parameters and runtime captures. A nested `$let` shadows parameters,
captures, and enclosing bindings with the same name.

```json
{
  "$params": ["x", "y"],
  "$return": {
    "$let": {
      "sum": { "$call": "add", "$args": [{ "$var": "x" }, { "$var": "y" }] },
      "doubled": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] }
    },
    "$in": { "$var": "doubled" }
  }
}
```

