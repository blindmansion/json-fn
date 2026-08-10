# Functions

A source function body is a closed object with:

- `$return`: required result expression;
- `$params`: optional parameter layout;
- `$returns`: optional result type schema;
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
invalid; there is no separate signature field (`$sig`) — types attach per
slot and as `$returns` (see
[Parameter and result types](#parameter-and-result-types--type-and-returns)).

## Parameters — `$params`

`$params` is an ordered array of slots. Each slot is one of:

- a name string — a required positional parameter;
- a rest string `"...rest"` — a rest collector (see
  [Rest parameters](#rest-parameters));
- a descriptor `{ "$param": name, ... }` with optional keys
  `"$optional": true`, `"$default": expression`, and `"$type": schema`.

Descriptors are closed: no keys other than the four named above are allowed.
`$optional` and `$default` are mutually exclusive, and at least one of the
three optional keys must be present — a descriptor carrying only `$param` is
invalid, because the bare name string is the one canonical spelling of that
layout. A rest slot in descriptor form carries the `...` prefix inside
`$param` and admits only `$type`. There is no other slot form; in particular,
an object-pattern slot (`{ "$fields": [...] }`) is not a canonical shape —
object patterns are shorthand sugar that lowers to a plain slot plus body-top
projections (see
[Object-pattern parameters](#object-pattern-parameters)).

Fixed arguments bind positionally, one per slot.

```json
{
  "$params": ["a", { "$param": "b", "$default": 1 }],
  "$return": { "$call": "add", "$args": [{ "$var": "a" }, { "$var": "b" }] }
}
```

A slot without `$optional` or `$default` requires an argument. An omitted
optional slot binds `null`. An omitted defaulted slot evaluates its `$default`
lazily when first read. Passing `null` explicitly supplies a value and does
not trigger omission behavior.

The positional `$default` is the language's **one** documented exception to
strict evaluation: everywhere else — `$let`, module bindings, and the lowered
pattern projections below — expressions evaluate eagerly. The exception is
sound because whether and when a default is first read is itself determined
by values, so the
[cost trace](../../runtime/execution-limits.md#determinism) remains a pure
function of values.

A positional default uses the function invocation scope: it may reference
other parameters, captures, and outer or module bindings. It cannot reference
a `$let` binding inside `$return` — including the lowered field projections
of a pattern slot.

Required slots precede optional and defaulted slots. Optional and defaulted
slots may be mixed, followed only by a final rest parameter.

A function without a rest parameter rejects extra arguments. `arity` counts
every non-rest slot once.

Uniqueness of the names bound by one parameter list — positional parameters,
pattern fields, and the rest parameter — is a shorthand parse rule (see
[Function literals](../shorthand/function-literals-and-local-bindings.md#parameters)).
Canonically the lowered field projections are ordinary `$let` bindings:
duplicates within one pattern are impossible (object keys are unique), and a
field name shadowing a positional parameter is the ordinary `$let` shadowing
rule, on a program the parser never emits.

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

A typed rest slot uses descriptor form:
`{ "$param": "...rest", "$type": {"type": "array", "items": {"type": "string"}} }`.
Its `$type` stores the array type **as written** and must be an array schema
without `prefixItems`; the
[interface derivation](#the-interface-description) takes its `items` as the
element schema.

## Parameter and result types — `$type` and `$returns`

A slot descriptor's `$type` holds a schema validating the parameter, and
`$returns` — an optional sibling of `$return` on any function body — holds a
schema for the function's result. In shorthand both are written with
[type syntax](../shorthand/type-syntax-spec.md):
`(color: Color) -> Color => ...` lowers to a `$type` on the `color` slot and
a `$returns` on the body.

Inline types are **static syntax**: the evaluator never consults them, and
they charge no fuel (see
[Execution limits](execution-limits.md#typing-is-free)). Runtime argument and
result validation remains the `$runtimeContract` wrapper and contract edges;
typing a function cannot change its result or its fuel. One program,
annotated and bare, evaluates identically and consumes identical fuel.

Schema payloads under `$type` and `$returns` are validated structurally
wherever function-body shape is validated — in source, and on hydrated values
including open-body capture entries.

Per-slot typing rules:

- `$type` validates a **supplied argument**;
- the local type of a plain optional parameter is `T | null`; the local type
  of a defaulted parameter is `T`;
- explicit `null` must be admitted by `T`;
- a `$default` expression is checked against `T` even when no call omits the
  slot.

Annotations need not be all-or-nothing: a partially annotated body is valid,
and its present annotations are used as declared. A **named** function — a
module entry or a reachable local binding whose literal value is a function
body — that is not fully annotated (every slot typed and `$returns` present)
is a missing-annotation **error**; the requirement is not configurable. Bare
inline lambdas remain typed contextually at higher-order call sites.

### The interface description

Every consumer of a function's callable shape — contract `functions` and
`entry` satisfaction, `$fnType` compatibility, the
[builtin registry](../../builtins/builtin-signatures.md)'s
concrete-function-value rule, and the checker's own check of a body against
its declared types — consumes one normative derivation from the inline form:

- `required` — the `$type` of each leading required slot, in order (`true`
  when untyped); a lowered pattern slot contributes its `$type`, the object
  schema;
- `optional` — the `$type` of each `$optional` or `$default` slot in source
  order (`true` when untyped); function types do not distinguish the two;
- `rest` — present iff a rest slot is; the **element** schema, taken as the
  `items` of the slot's array-shaped `$type` (`true` when untyped);
- `returns` — `$returns`, or `true` when absent. A function whose `$returns`
  is a `$taskType` satisfies a contract-entry `returns` of `{"task": A}`
  when its completion type satisfies `A`.

The derivation is one-way: nothing reconstructs a parameter layout from the
interface shape.

## Object-pattern parameters

An object-pattern parameter destructures one positional object argument into
named locals. It is **shorthand sugar**, not a canonical construct: the
parser desugars it, and the printer folds it back — the same posture as `do`.

A pattern at slot index `i` lowers to a plain required positional slot with
the synthesized name `__p<i>` (zero-based index in `$params`), carrying the
pattern's annotation as its `$type` when one is written, plus a **body-top
eager `$let` of strict-read projections** — one binding per field, wrapping
the authored result expression as its `$in`. Per field, where `p` is the
synthesized parameter:

- required `f` →
  `{ "$get": "f", "$from": { "$var": p } }` — a bare read; a missing field
  is the ordinary
  [miss error](expressions.md#misses-and-the-else-arm) naming the key;
- optional `f?` → the same read with `"$else": null` — absence binds `null`;
- defaulted `f = e` → the same read with `"$else": e` — the arm evaluates on
  absence only.

```jfn
route: ({ from, via?, weight = 1 }: Leg, scale: integer = 10) -> integer
  => ...
```

lowers to:

```json
{
  "$params": [
    { "$param": "__p0", "$type": { "$ref": "#/$defs/Leg" } },
    { "$param": "scale", "$default": 10, "$type": { "type": "integer" } }
  ],
  "$returns": { "type": "integer" },
  "$return": {
    "$let": {
      "from": { "$get": "from", "$from": { "$var": "__p0" } },
      "via": { "$get": "via", "$from": { "$var": "__p0" }, "$else": null },
      "weight": { "$get": "weight", "$from": { "$var": "__p0" }, "$else": 1 }
    },
    "$in": "..."
  }
}
```

The [interface derivation](#the-interface-description) gives this body
`{ "required": [{"$ref": "#/$defs/Leg"}], "optional": [{"type": "integer"}],
"returns": {"type": "integer"} }` — the pattern consumes one required slot
contributing its object schema; its fields consume no interface positions,
because they are ordinary `$let` bindings.

The identifier space `__p` followed by digits is
[reserved in shorthand](../shorthand/grammar.md): it is not a valid shorthand
identifier anywhere, as binder or reference. Canonical JSON may of course
contain the names — the lowering emits them — and hand-written canonical form
using the scheme is given a meaning by the ordinary rules rather than
policed, the same posture as `$captures`.

### Semantics by lowering

The lowering is the semantics; the pattern has no rules of its own:

- The projections are ordinary strict `$let` bindings: dependency-ordered,
  evaluated eagerly, exactly once, before the result — and captured, hashed,
  and printed as any bindings are.
- After the lowering, the parameter surface's absence-binds-`null`
  convention and the access site's absence-errors-or-selects-the-arm
  convention are **one mechanism**: an optional field *is* `?? null`, a
  defaulted field *is* `?? e`, projected at body top.
- The pattern argument is required, and it must be an object: the
  projections are reads, and [strict-read
  rules](expressions.md#misses-and-the-else-arm) make key-kind rejection and
  non-container traversal errors, not misses — an `$else` arm never swallows
  a non-object or `null` argument. A missing required field is the miss
  error naming the key. Extra object keys are ignored, as by any read.
- An own property whose value is `null` is supplied data: it binds `null`
  and suppresses a field default (`$else` fires on absence only).
- A field default evaluates **at bind time on absence** — body-top,
  dependency-ordered — not lazily on first read. An absent field whose
  default errors fails the call even when the binding is never read; move
  work into the branch that needs it. The positional `$default` is the
  language's one remaining lazy construct.
- Field defaults may reference parameters and sibling fields; these are
  ordinary dependency edges, so mutually referencing field defaults are a
  static cycle error. A positional default cannot reference a pattern field
  (the fields are `$let` bindings inside `$return`, outside the invocation
  scope defaults use).

Multiple pattern slots lower into **one** body-top `$let`, in parameter
order, then field order; field names cannot collide across patterns (the
parameter-list uniqueness rule).

The pattern surface keeps its parse rules: non-empty, identifier fields, no
renames, no nesting, no whole-pattern `?` or `=`, and `?` and `=` mutually
exclusive per field (see
[Function literals](../shorthand/function-literals-and-local-bindings.md#object-pattern-parameters)).
The lowering is the flat image that a future pattern dialect extends —
nested and renamed patterns arrive as extensions of this surface, never as a
re-lowering of it.

## Recursion

Named module functions can call themselves by name.

### Local recursive functions

A `$let` binding whose literal value is a function body can be called by name
within that scope. Sibling function bindings may call one another. Local
function names shadow outer callables and do not escape their `$let` unless
captured by a [closure](closures.md#captured-local-functions).
