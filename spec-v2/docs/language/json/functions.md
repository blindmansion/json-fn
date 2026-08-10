# Functions

A source function body is a closed object with:

- `$return`: required result expression;
- `$params`: optional parameter layout;
- `$sig`: optional static signature;
- `$comment`: optional string comment.

Evaluated function values may also contain:

- `$captures`: the capture record — a plain object mapping the body's free
  variable names to captured values, omitted when empty (see
  [Closures](closures.md));
- `$runtimeContract`: serializable argument and result contract state.

Captured values are available through `$var` and `$fn` in parameter defaults
and `$return`; a function-valued or open-body record entry is additionally
callable by name through `$call`. `$captures` and `$runtimeContract` are not
source fields. `$types` is valid only at module scope. All other fields are
invalid.

## Parameters — `$params`

`$params` is an ordered array of slots. Each slot is one of:

- a name string — a required positional parameter;
- `{ "$param": name, "$optional": true }` — an optional positional parameter;
- `{ "$param": name, "$default": expression }` — a defaulted positional parameter;
- `"...rest"` — a rest collector (see [Rest Parameters](#rest-parameters));
- `{ "$fields": [...] }` — an object pattern (see
  [Object-Pattern Parameters](#object-pattern-parameters--fields)).

Descriptor objects have exactly the keys shown. Fixed arguments bind
positionally, one per slot.

```json
{
  "$params": ["a", { "$param": "b", "$default": 1 }],
  "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
}
```

A string slot requires an argument. An omitted optional slot binds `null`. An
omitted defaulted slot evaluates its `$default` lazily when first read. Passing
`null` explicitly supplies a value and does not trigger omission behavior.

Lazy defaults — positional `$default` and `$fields` field defaults — are the
language's one documented exception to strict evaluation: everywhere else,
including `$let` and module bindings, expressions evaluate eagerly. The
exception is sound because whether and when a default is first read is itself
determined by values, so the
[cost trace](../../runtime/execution-limits.md#determinism) remains a pure
function of values.

Required slots, including object patterns, precede optional and defaulted
slots. Optional and defaulted slots may be mixed, followed only by a final rest
parameter.

Every name bound by one parameter list must be unique across positional
parameters, object-pattern fields, and the rest parameter.

A function without a rest parameter rejects extra arguments.

## Rest parameters

A final string beginning with `...` collects the remaining arguments into an
array. It receives an empty array when no arguments remain.

```json
{
  "$params": ["first", "...rest"],
  "$return": { "$var": "rest" }
}
```

With arguments `[1, 2, 3]`, `first` is `1` and `rest` is `[2, 3]`.

## Object-pattern parameters — `$fields`

A `$params` slot may be an object pattern with the exact shape
`{ "$fields": [...] }`. Its non-empty array contains required field-name
strings, optional descriptors of the form
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

With arguments `[{ "from": 3, "to": 7 }]`, `from` is `3`, `to` is `7`, and the
result is `4`. The pattern still consumes one positional argument.

Binding rules for a pattern slot at position `i`, where `v` is the supplied
`i`-th argument:

- The pattern argument is required even if every field is omittable.
- `v` must be a plain object (not an array and not `null`). Any other value,
  including explicit `null`, is an error.
- A required field must be an own property of `v`.
- An absent optional field binds `null`.
- A defaulted field uses its `$default` only when the own property is absent.
  The default is evaluated lazily when the binding is first read.
- An own property whose value is `null` is supplied data: it binds `null` and
  suppresses a field default.
- Extra object keys are ignored.

Supplied fields bind at call time; defaults remain lazy. Field bindings are
available through `$var` in `$return`. They shadow outer bindings and can
themselves be shadowed by an inner `$let`.

Additional rules:

- `$fields` must be a non-empty array of field-name strings and/or
  `{ "$field": name, "$optional": true }` or
  `{ "$field": name, "$default": expression }` descriptors. Field names must
  not contain `.` or `[`.
- A `$fields` object is valid only as a `$params` slot; it may not be preceded by `...`.
- A pattern slot consumes exactly one required positional argument, so it
  may appear with other required slots before optional/defaulted slots, and
  before a final rest parameter (`["label", { "$fields": ["x", "y"] }]`,
  `[{ "$fields": ["x"] }, "...rest"]`).
- Optional and defaulted fields affect property omission only. The pattern
  remains a required positional slot.
- `arity` counts every non-rest slot once, including optional/defaulted slots
  and object patterns.

Rename and nested patterns are not supported.

## Recursion

Named module functions can call themselves by name.

### Local recursive functions

A `$let` binding whose literal value is a function body can be called by name
within that scope. Sibling function bindings may call one another. Local
function names shadow outer callables and do not escape their `$let` unless
captured by a [closure](closures.md#captured-local-functions).

