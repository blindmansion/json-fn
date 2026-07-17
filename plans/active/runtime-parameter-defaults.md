# Runtime parameter defaults

Status: proposed.

## Summary

Add parameter defaults to canonical json-fn function bodies by enriching
`$params` entries. Defaults are attached directly to the binding they initialize:

```json
{
  "$params": [
    "required",
    { "$param": "count", "$default": 1 },
    {
      "$fields": [
        "name",
        { "$field": "punct", "$default": "!" }
      ]
    }
  ],
  "$return": {
    "required": { "$var": "required" },
    "count": { "$var": "count" },
    "name": { "$var": "name" },
    "punct": { "$var": "punct" }
  }
}
```

Default expressions participate in the function body's existing lazy,
memoized, recursive scope. A default is evaluated only when its binding is
needed, can refer to parameters and body locals in the same scope, and uses the
existing circular-dependency error when references form a cycle.

This phase is deliberately limited to canonical/lowered JSON and the canonical
TypeScript evaluator. It does not add `.jfn` syntax, printer support, optional
parameter types, checker arity rules, or shared cross-implementation
conformance cases.

## Goals

- Represent defaults next to the positional or field binding they initialize.
- Support both ordinary positional parameters and destructured object fields.
- Preserve the distinction between an absent value and an explicit `null`.
- Reuse the evaluator's lazy-local memoization and cycle detection.
- Preserve all current behavior for existing string and `{ "$fields": [...] }`
  parameter entries.
- Keep the initial implementation isolated from shorthand and typechecking.

## Non-goals

- `.jfn` syntax such as `(x = 1) => ...` or `{ x = 1 }`.
- Printing enriched `$params` entries as shorthand.
- Optional parameter syntax or `T | null` inference.
- Minimum/maximum arity checking.
- Defaults for rest parameters.
- Nested destructuring, field renaming, or array destructuring.
- Go, Python, or Rust implementation parity.
- Shared `spec/cases` coverage before the other interpreters are updated.

## Canonical representation

### Parameter entry grammar

The conceptual runtime types become:

```ts
type NamedParam =
  | string
  | {
      $param: string;
      $default: JSONType;
    };

type FieldBinding =
  | string
  | {
      $field: string;
      $default: JSONType;
    };

type FieldPattern = {
  $fields: FieldBinding[];
};

type Param = NamedParam | FieldPattern;
```

The existing `"...rest"` string remains the rest-parameter representation. It
is not a `NamedParam` for defaulting purposes and cannot be expressed as an
object descriptor.

Plain strings remain the compact representation for required bindings. An
object descriptor is used only when the binding has a default. Property
presence, rather than the value's truthiness, marks a default, so
`"$default": null` is valid and unambiguous.

The distinct `$param` and `$field` keys make the source of a binding explicit:

- `$param` consumes one positional argument;
- `$field` reads one property from the enclosing destructured positional
  argument.

This also leaves an intentional extension point for future field renaming,
without choosing that design now:

```json
{ "$field": "externalName", "$as": "localName", "$default": 0 }
```

`$as` is illustrative only and is not part of this proposal.

### Why defaults live in `$params`

Co-locating the default with its binding avoids several problems with a sibling
`$defaults` map:

- a binding and its default cannot drift apart after a rename or reorder;
- named positional and destructured field defaults use the same mechanism;
- no positional index encoding is needed;
- no path language is needed for destructured fields;
- a default of `null` remains distinguishable from no default;
- future syntax can lower directly into the relevant binding descriptor.

A `$default` sibling of `$fields` would instead default the whole object
argument. That is not included. The function observes the individual bound
fields, and field-level defaults cover the useful behavior without introducing
a second defaulting layer.

## Evaluation model

### Defaults are lazy bindings

Call arguments keep their current eager call-site evaluation. Parameter
defaults are different: they are unevaluated expressions owned by the callee.
When an argument or field is absent, the evaluator registers its `$default` as
a pending binding instead of evaluating it immediately.

Variable resolution uses this precedence:

1. a supplied positional or field value;
2. a previously evaluated and memoized default;
3. a pending default expression;
4. a body local;
5. the enclosing lexical scope and function registry.

Parameter names continue to shadow same-named body and outer bindings. A
required missing binding is installed as `null`, so it shadows exactly as it
does today.

When a pending default is requested, it is evaluated in the same scope used by
the function return and lazy locals. Its result is memoized in the current call
frame. Repeated references do not repeat work or effects represented by the
expression.

### Recursive scope

Defaults can refer to any parameter binding or body local, not only earlier
parameters. This follows the existing `letrec` model for function-body locals.

Forward dependency:

```json
{
  "$params": [
    { "$param": "a", "$default": { "$var": "b" } },
    { "$param": "b", "$default": 10 }
  ],
  "$return": { "$var": "a" }
}
```

Called with no arguments, `a` forces `b`, `b` evaluates to `10`, and the result
is `10`.

Default through a body local:

```json
{
  "$params": [
    {
      "$param": "answer",
      "$default": { "$call": "add", "$args": [{ "$var": "base" }, 2] }
    }
  ],
  "base": 40,
  "$return": { "$var": "answer" }
}
```

The result is `42`. `answer` and `base` are both memoized after evaluation.

Cycle:

```json
{
  "$params": [
    { "$param": "a", "$default": { "$var": "b" } },
    { "$param": "b", "$default": { "$var": "a" } }
  ],
  "$return": { "$var": "a" }
}
```

This fails through the existing circular-variable dependency mechanism. Cycles
that cross defaults and body locals fail the same way.

### Demand determines evaluation

An unused default is never evaluated:

```json
{
  "$params": [
    { "$param": "unused", "$default": { "$var": "doesNotExist" } }
  ],
  "$return": 42
}
```

This returns `42`. The missing variable would fail only if `unused` were
forced.

This is observable through errors, fuel accounting, and any effectful
constructs represented by evaluation. It is intentional and matches lazy body
locals. A default may also be forced while capturing a closure that references
the binding; closure creation is a demand for the captured value under the
current evaluator model.

The implementation must test closure forcing explicitly because `replaceVars`
materializes captured values and local function bodies. The feature should not
claim stronger laziness than the evaluator already provides to body locals.

### Supplied values override defaults

A positional argument is supplied when its index exists in the evaluated
`$args` array. A supplied value always wins, including `null`, `false`, `0`, an
empty string, an empty array, and an empty object.

Given:

```json
{
  "$params": [{ "$param": "value", "$default": 10 }],
  "$return": { "$var": "value" }
}
```

- `args: []` returns `10`;
- `args: [20]` returns `20`;
- `args: [null]` returns `null`;
- `args: [0]` returns `0`.

The implementation must test argument presence by position, not with `??`,
truthiness, or the resulting value.

### Missing required positional parameters

Current null-padding remains unchanged:

```json
{
  "$params": ["required"],
  "$return": { "$var": "required" }
}
```

Called with no arguments, this returns `null`.

Defaults therefore do not implicitly make every parameter optional at the
type-system level. Runtime omission and checked call arity remain separate
concerns until the checker phase.

## Destructured field defaults

### Missing property

Field defaults attach to the bound field:

```json
{
  "$params": [
    {
      "$fields": [
        "name",
        { "$field": "punct", "$default": "!" }
      ]
    }
  ],
  "$return": {
    "name": { "$var": "name" },
    "punct": { "$var": "punct" }
  }
}
```

Called with `{ "name": "Ada" }`, this returns:

```json
{ "name": "Ada", "punct": "!" }
```

Field presence must use own-property membership, not `value[field] ?? null`.
That preserves explicit `null`:

```json
{ "name": "Ada", "punct": null }
```

binds `punct` to `null` and does not evaluate its default.

### Entire argument omitted

When the positional object argument itself is omitted, every required field
continues to bind to `null`, while every defaulted field registers its pending
default:

```json
{
  "$params": [
    {
      "$fields": [
        "required",
        { "$field": "withDefault", "$default": 5 }
      ]
    }
  ],
  "$return": [
    { "$var": "required" },
    { "$var": "withDefault" }
  ]
}
```

Called with no arguments, this returns `[null, 5]`.

### Supplied non-object argument

The current destructuring rule is lenient: `null`, scalars, and arrays supplied
to an object pattern bind every field to `null`. Preserve that rule. Because
the positional argument was explicitly supplied, field defaults do not run;
all fields bind to `null`.

This distinguishes:

- omitted argument: defaulted fields may use their defaults;
- supplied `{}`: absent fields may use their defaults;
- supplied `{ "field": null }`: explicit field `null` wins;
- supplied `null`, scalar, or array: existing lenient all-`null` behavior wins.

This distinction avoids turning explicit `null` into an omission while still
making defaults useful for ordinary absent object properties.

### Field dependency

Field defaults enter the same recursive scope as positional defaults:

```json
{
  "$params": [
    {
      "$fields": [
        { "$field": "first", "$default": { "$var": "second" } },
        { "$field": "second", "$default": 2 }
      ]
    }
  ],
  "$return": { "$var": "first" }
}
```

Called with `{}`, this returns `2`. A supplied `second` property would be used
instead of its default.

## Rest and extra arguments

Rest behavior is unchanged:

```json
{
  "$params": [
    { "$param": "head", "$default": null },
    "...tail"
  ],
  "$return": {
    "head": { "$var": "head" },
    "tail": { "$var": "tail" }
  }
}
```

With no arguments, `head` evaluates to its explicit `null` default and `tail`
is `[]`. With `[1, 2, 3]`, `head` is `1` and `tail` is `[2, 3]`.

A rest string cannot carry a default, and an object descriptor whose name
starts with `...` is invalid. Existing extra-argument behavior for functions
without rest parameters remains unchanged.

## Closures and captured defaults

Default expressions are part of a function declaration and must participate in
closure capture:

```json
{
  "fallback": 7,
  "$return": {
    "$params": [
      { "$param": "value", "$default": { "$var": "fallback" } }
    ],
    "$return": { "$var": "value" }
  }
}
```

The returned function must retain `fallback` just as it would if the reference
appeared in `$return` or a body local.

At the same time, bindings declared by the returned function must mask
same-named outer bindings throughout its defaults:

```json
{
  "value": 99,
  "$return": {
    "$params": [
      { "$param": "value", "$default": 1 },
      { "$param": "copy", "$default": { "$var": "value" } }
    ],
    "$return": { "$var": "copy" }
  }
}
```

Calling the returned function with no arguments yields `1`, not the outer
`99`.

Default expressions can also reference local function names. Escaping-closure
attachment must inspect default expressions inside `$params`; otherwise a
default could retain a dangling reference after leaving its defining scope.

## Validation

Validation should happen through the evaluator's central parameter reader so
direct `callFunction`, registry calls, inline function calls, `callProgram`, and
prepared-program calls receive the same behavior.

Reject:

- a `$param` descriptor without exactly one string `$param` and a present
  `$default`;
- a `$param` value beginning with `...`;
- a `$field` descriptor without exactly one string `$field` and a present
  `$default`;
- unknown properties on either descriptor;
- nested descriptors or `$fields` entries other than strings and valid
  `$field` descriptors;
- duplicate bound names across positional parameters and destructured fields;
- a rest parameter anywhere except the existing valid rest position.

`$default` may contain any valid json-fn expression, including `null`, a
function body, a function call, or `$raw`.

Duplicate binding names need explicit rejection because lazy defaults are keyed
by the resolved binding name. Allowing two descriptors for the same name would
make shadowing and cycle behavior depend on incidental insertion order.

## TypeScript implementation outline

### `typescript/src/types.ts`

- Extend `Param` with a defaulted named-parameter descriptor.
- Extend `FieldPattern.$fields` with defaulted field descriptors.
- Keep required string parameters, `"...rest"`, and required string fields
  source-compatible.
- Add narrow helper types for default-bearing bindings so evaluator code does
  not rely on repeated `any` casts.

### Shared parameter normalization

Add a small runtime normalization/validation helper, either near the evaluator
or in a focused parameter module. It should:

- classify required named, defaulted named, rest, and object-pattern slots;
- enumerate every bound name;
- expose each binding's optional default expression;
- preserve positional-slot and field-source information;
- validate descriptor shape and binding uniqueness once.

Evaluator code should consume this normalized form rather than repeatedly
branching over raw JSON shapes. Later shorthand and checker work can reuse the
conceptual model, but this phase should not change their semantics.

### `typescript/src/evaluate.ts`

`buildScope` is the main integration point.

- Replace direct `$params` branching with normalized parameter binding.
- Keep supplied values in `evaluatedVars`.
- Keep unevaluated defaults in a pending-default map keyed by binding name.
- Bind missing required values to `null`.
- Distinguish positional omission and own-property absence from explicit
  `null`.
- Extend `getVar` to resolve and memoize pending defaults before body locals.
- Use the existing `resolvingVars` stack for cycles spanning defaults and
  locals.
- Evaluate defaults with the same `functions`, lexical `getVar`, execution
  limits, call state, performance counters, and runtime definitions as other
  expressions in the frame.

The current declaration order places parameter binding before `getVar` and its
cycle stack. It will need restructuring so descriptors register pending
bindings first and `getVar` performs their evaluation later.

### Closure replacement and attachment

Update the parameter-name extraction in `replaceVars` so `$param` and `$field`
descriptors mask their bound names just like current strings.

Default expressions inside `$params` must still be traversed for free-variable
replacement. The binding-name strings themselves are metadata and must not be
treated as expressions.

Update body-level local-function reference collection so it scans `$default`
expressions inside `$params` while still treating nested function bodies as
scope boundaries. This preserves escaping defaults that call enclosing local
functions.

### `typescript/src/utils.ts`

Update `getArity` mechanically so a `$param` descriptor counts as one fixed
positional slot and a `$fields` descriptor still counts as one fixed positional
slot. This is runtime shape compatibility, not optional-arity typechecking.

### Checker and shorthand boundaries

Do not add checker semantics in this phase. In particular:

- do not make a defaulted parameter optional at checked call sites;
- do not infer a parameter type from its default;
- do not validate a default against `$sig`;
- do not change signature subsumption or overload selection.

Do not update the shorthand parser or printer. Canonical JSON containing the
new descriptors is evaluator input only until the follow-up syntax phase.
Round-tripping such JSON through `to-shorthand` is therefore unsupported in
this phase and should be documented as such in implementation notes.

If a mechanical guard is required to keep unrelated checker code from
crashing on the new shape, it should report the feature as unsupported rather
than implementing partial type semantics.

## Test plan

Add TypeScript-only evaluator tests, preferably in a focused
`typescript/test/parameter-defaults.test.ts`.

Cover:

1. Required positional parameters retain current behavior.
2. A missing positional argument evaluates its literal default.
3. A computed default can call builtins.
4. Supplied values override defaults for `null`, `false`, `0`, empty strings,
   arrays, and objects.
5. A default of `null` is distinct from no default.
6. Unused defaults are not evaluated.
7. A default is memoized and evaluated at most once per call.
8. Forward references between defaults work.
9. Defaults can reference body locals and local functions.
10. Default/default and default/local cycles produce the existing circular
    dependency error.
11. Missing object fields use field defaults.
12. Explicit `null` object fields suppress defaults.
13. An omitted object argument uses field defaults and null-pads required
    fields.
14. Supplied `null`, scalar, and array object arguments preserve lenient
    all-`null` destructuring.
15. Field defaults can depend on positional parameters and other fields.
16. Nested and escaping closures capture free variables used only by defaults.
17. Same-named current parameters mask outer bindings inside defaults.
18. Defaults that call enclosing local functions survive closure attachment.
19. Rest collection and ignored extra arguments remain unchanged.
20. Invalid descriptor shapes, duplicate bindings, and invalid rest forms fail
    consistently through all evaluator entry points.
21. Fuel and interruption checks apply while evaluating a forced default.
22. Performance accounting does not evaluate an unforced default.

Do not add shared `spec/cases` yet. Those cases are intended for behavior all
four interpreters must eventually implement.

Run from `typescript/`:

```bash
bun test
bun run check
```

## Follow-up phases

### Typechecking

The checker phase must decide:

- how a default changes minimum call arity;
- whether defaulted parameters may precede required ones;
- how default expressions are checked against declared parameter schemas;
- whether field defaults affect required object properties;
- how contextual lambda typing represents defaulted bindings;
- whether function-type assignability records optional/defaulted positions.

Runtime laziness does not require the type system to expose lazy types; it only
affects when a checked default expression executes.

### Shorthand parser and printer

The syntax phase can lower forms such as:

```jfn
(count = 1, { name, punct = "!" }) => ...
```

into the descriptors in this plan. The printer must render the same forms and
parse cases must establish two-way canonical round-tripping.

### Cross-language conformance

After the canonical behavior is stable and the other evaluators implement the
same descriptor and lazy-scope rules, promote the runtime examples into shared
conformance cases.

## Decision summary

- Defaults are stored inline in `$params`.
- Named positional defaults use `{ "$param", "$default" }`.
- Field defaults use `{ "$field", "$default" }` inside `$fields`.
- Defaults apply only to absent positional arguments or absent object fields.
- Explicit `null` remains a supplied value.
- Defaults are lazy, memoized members of the function's recursive scope.
- Defaults can depend on parameters, fields, and body locals in any declaration
  order; real cycles fail through existing cycle detection.
- Whole-object pattern defaults, nested patterns, typechecking, shorthand, and
  non-TypeScript implementations are deferred.
