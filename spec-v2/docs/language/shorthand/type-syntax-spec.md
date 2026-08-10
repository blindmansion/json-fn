# Type syntax

Type expressions describe JSON values and lower deterministically to a closed
JSON-Schema-like dialect. They support static checking and, except for
static-only task completion types, runtime validation.

## Type positions

Types appear in exactly four positions:

- module declarations: `type Name = Type`;
- function parameters and returns: `(value: Type) -> Result => ...`;
- total handler results: `handle task returns Type with { ... }`;
- checked value ascriptions: `value checked as Type`.

Declarations are module-level entries. Type expressions may occur in any of the
four positions, including nested function signatures, handlers, and
ascriptions.

A total handler annotation lowers to a `$raw`-quoted third argument:
`handle(task, clauses, {"$raw": schema})`. It contracts the handler's immediate
result.

## Schema forms

The schema dialect contains:

- `true` and `false`;
- `$ref`, `const`, `enum`, and `anyOf`;
- `type` with primitive, array, and object schemas;
- numeric keywords `minimum`, `maximum`, `exclusiveMinimum`,
  `exclusiveMaximum`, and `multipleOf`;
- string keywords `minLength`, `maxLength`, `pattern`, and `format`;
- array keywords `items`, `prefixItems`, `minItems`, `maxItems`, and
  `uniqueItems: true`;
- object keywords `properties`, `required`, and `additionalProperties`;
- `$fnType` for function types;
- `$taskType` for the static completion type of a task.

Type syntax does not emit `not`, `if`/`then`/`else`, `oneOf`, general `allOf`,
`patternProperties`, `propertyNames`, `dependent*`, `contains`,
`unevaluated*`, or object refinements.

## Primitive and literal types

```text
null      → {"type":"null"}
boolean   → {"type":"boolean"}
number    → {"type":"number"}
integer   → {"type":"integer"}
string    → {"type":"string"}
any       → true
never     → false

"active"  → {"const":"active"}
42        → {"const":42}
true      → {"const":true}
false     → {"const":false}
null      → {"type":"null"}
```

`integer` is distinct from `number`. `null` always uses the primitive schema,
not `{"const":null}`.

An `any` argument supplies no overload evidence: it neither selects nor rejects
an overload and does not bind type variables. If the known arguments leave
several overloads possible, the result is the normalized union of their result
types and type coverage is degraded.

## Unions

`A | B | C` is a flattened, left-to-right union. `|` has the lowest type
precedence. Duplicate arms are removed while source order is preserved.

Literal-only unions lower to `enum`; `null` may join the enum:

```text
"a" | "b" | "c"       → {"enum":["a","b","c"]}
"on" | "off" | 0 | 1  → {"enum":["on","off",0,1]}
"a" | null            → {"enum":["a",null]}
```

Bare-primitive unions lower to a `type` array:

```text
number | null → {"type":["number","null"]}
```

Mixed unions lower to `anyOf`. Consecutive literal arms become one `enum` arm,
and consecutive bare primitives become one `type` arm:

```text
"auto" | "none" | number
→ {"anyOf":[{"enum":["auto","none"]},{"type":"number"}]}
```

## Arrays and tuples

The postfix `[]` operator is repeatable and binds more tightly than `&` and
`|`.

```text
string[]          → {"type":"array","items":{"type":"string"}}
any[]             → {"type":"array"}
(string | null)[] → {"type":"array","items":{"type":["string","null"]}}
number[][]        → an array of arrays of numbers
```

A fixed tuple emits `prefixItems`, `items: false`, and its exact length as
`minItems`. It does not emit `maxItems`.

```text
[number, number]
→ {"type":"array",
   "prefixItems":[{"type":"number"},{"type":"number"}],
   "items":false,
   "minItems":2}
```

A final spread supplies the schema for all remaining items:

```text
[string, ...number[]]
→ {"type":"array",
   "prefixItems":[{"type":"string"}],
   "items":{"type":"number"},
   "minItems":1}
```

## Objects

Object types are closed unless they end with `...`.

```text
{name: string, age?: integer}
→ {"type":"object",
   "properties":{"name":{"type":"string"},"age":{"type":"integer"}},
   "required":["name"],
   "additionalProperties":false}
```

`?` makes a property optional. When an object has fixed fields, `required` is
always emitted in source order, including when it is empty.

An open object omits `additionalProperties`:

```text
{name: string, ...}
→ {"type":"object",
   "properties":{"name":{"type":"string"}},
   "required":["name"]}
```

A string-keyed map uses `additionalProperties`. Fixed fields may accompany one
map entry.

```text
{[string]: number}
→ {"type":"object","additionalProperties":{"type":"number"}}

{id: string, [string]: number}
→ {"type":"object",
   "properties":{"id":{"type":"string"}},
   "required":["id"],
   "additionalProperties":{"type":"number"}}
```

The empty forms are:

```text
{}    → {"type":"object","required":[],"additionalProperties":false}
{...} → {"type":"object"}
```

## Refinements

`&` attaches validation keywords to a base type; it is not a general
intersection. It binds more tightly than `|` and less tightly than `[]`.

- `min(n)` and `max(n)` apply to numbers and integers and emit `minimum` and
  `maximum`.
- `xmin(n)` and `xmax(n)` apply to numbers and integers and emit
  `exclusiveMinimum` and `exclusiveMaximum`.
- `multipleOf(n)` applies to numbers and integers.
- `minLen(n)`, `maxLen(n)`, `pattern(re)`, and `format(name)` apply to strings
  and emit `minLength`, `maxLength`, `pattern`, and `format`.
- `minItems(n)`, `maxItems(n)`, and `unique` apply to arrays and emit
  `minItems`, `maxItems`, and `uniqueItems: true`.

```text
integer & min(0) & max(63)
→ {"type":"integer","minimum":0,"maximum":63}

string & pattern("^u_")
→ {"type":"string","pattern":"^u_"}

Cell[] & minItems(64) & maxItems(64)
```

An incompatible refinement is invalid rather than lowering to `allOf`.
Compatibility is checked immediately for a structural base and after
resolution for a named base. Function types, `Task`, enums, and objects cannot
be refined.

## Function types

Function types lower to `$fnType`, whose parameter and result leaves are
schemas.

```text
(Cell) -> boolean
→ {"$fnType":{
     "required":[{"$ref":"#/$defs/Cell"}],
     "optional":[],
     "returns":{"type":"boolean"}}}

(string, integer?) -> boolean
→ {"$fnType":{
     "required":[{"type":"string"}],
     "optional":[{"type":"integer"}],
     "returns":{"type":"boolean"}}}

(string, ...number[]) -> string
→ {"$fnType":{
     "required":[{"type":"string"}],
     "optional":[],
     "rest":{"type":"number"},
     "returns":{"type":"string"}}}
```

Required slots precede optional slots, followed only by an optional rest slot.
`(A, B?, C?, ...D[]) -> R` is valid; `(A?, B) -> R` is not.

`?` applies to the complete preceding type. `A?` is an omittable slot whose
supplied value has type `A`. It is not the same as `A | null`: `(A?) -> R`
accepts zero or one argument, while
`(A | null) -> R` requires one argument.

A function accepts at least its number of required arguments. Without rest, it
accepts at most the combined number of required and optional arguments. Rest
removes that upper bound.

Function compatibility requires equal required counts, equal optional counts,
and matching rest presence. Within that shape, parameters are contravariant and
the return type is covariant.

The return type extends as far right as possible, so `(A) -> B | C` returns
`B | C`. Parentheses are required when a function type is a union arm or array
element:

```jfn
((Event) -> Result) | null
((number) -> number)[]
```

Function types do not distinguish plain optional parameters from defaulted
parameters. Both occupy `$fnType.optional`. Function types compose in every
type position except refinements and literal enums.

## Function signatures

A typed function literal annotates parameters in place and may include a
return type:

```jfn
otherColor: (color: Color) -> Color =>
  if color == "w" then "b" else "w"
```

Annotations lower inline: each parameter type becomes a `$type` on its
`$params` slot, and the return type becomes `$returns` beside `$return`:

```json
{
  "$params": [{ "$param": "color", "$type": { "$ref": "#/$defs/Color" } }],
  "$returns": { "$ref": "#/$defs/Color" },
  "$return": "..."
}
```

There is no separate signature object: a type lives on the slot it
describes, so an annotation cannot misalign with the parameter layout. The
callable shape consumed by contracts, `$fnType` compatibility, and the
builtin registry is produced by the
[interface derivation](../json/functions.md#the-interface-description) from
the inline form.

An untyped required parameter stays a bare name string; a typed one uses
descriptor form. A mixed layout illustrates the lowering:

```jfn
greet: (
  name: string,
  title?: string,
  punctuation: string = "!"
) -> string => ...
```

```json
{
  "$params": [
    { "$param": "name", "$type": { "type": "string" } },
    { "$param": "title", "$optional": true, "$type": { "type": "string" } },
    { "$param": "punctuation", "$default": "!", "$type": { "type": "string" } }
  ],
  "$returns": { "type": "string" },
  "$return": "..."
}
```

In `name?: T` and `name: T = expression`, `T` validates a supplied argument.
The local type of a plain optional parameter is `T | null`; the local type of a
defaulted parameter is `T`.

`?` and `=` are mutually exclusive. Either makes a slot omittable, so required
parameters must come first and only rest may follow. A default expression is
checked against `T` even if unused. Positional defaults are lazy and use the
function invocation scope. Omission of a plain optional parameter binds
`null`; explicit `null` is supplied data, must be admitted by `T`, and never
activates a default.

Rest syntax carries an array type, stored on the slot as written:

```jfn
concatAll: (first: string, ...rest: string[]) -> string => ...
```

```json
{
  "$params": [
    { "$param": "first", "$type": { "type": "string" } },
    {
      "$param": "...rest",
      "$type": { "type": "array", "items": { "type": "string" } }
    }
  ],
  "$returns": { "type": "string" },
  "$return": "..."
}
```

A rest slot's `$type` must be an array schema without `prefixItems`; the
interface derivation takes its `items` as the `$fnType` and contract `rest`
element schema.

Annotations may be partial: a body annotating only some slots, or only the
return, is valid, and its present annotations are used as declared. A
**named** function — a module binding or a reachable local binding whose
value is a function literal — that is not fully annotated is a
missing-annotation error; the requirement is not configurable. Bare inline
lambdas are typed contextually where a higher-order call supplies their
function type. Every reachable named function body is checked against its
declared types.

Local-binding reachability starts at `$in` and follows lexical references
transitively. Reachable value bindings are checked where referenced. An
unreachable binding produces one unused-binding error, and its contents are not
checked.

### Object-pattern annotations

An object-pattern annotation describes the one object argument the pattern
consumes. It attaches as the `$type` of the pattern's
[synthesized slot](../json/functions.md#object-pattern-parameters):

```jfn
daysInMonth: ({ year, month }: Date) -> integer => ...
```

```json
{
  "$params": [{ "$param": "__p0", "$type": { "$ref": "#/$defs/Date" } }],
  "$returns": { "type": "integer" },
  "$return": {
    "$let": {
      "year": { "$get": "year", "$from": { "$var": "__p0" } },
      "month": { "$get": "month", "$from": { "$var": "__p0" } }
    },
    "$in": "..."
  }
}
```

Inline object types are also allowed:

```jfn
({ from, to }: {from: integer, to: integer}) -> integer => ...
```

Because the pattern lowers to body-top strict-read projections, every
field-versus-property rule is a consequence of
[checking the reads](../json/expressions.md#checking-reads) against the
slot's `$type` — none is a bespoke pattern rule:

- a required field over an optional property (`k?: T`) is the ordinary
  optional-field bare-read error: the checker cannot rule out the miss;
- an optional field types as `T | null` — `$else: null` union typing;
- a defaulted field types as `T | typeof(e)`, collapsing to `T` when the
  default's type is subsumed;
- a defaulted field over a *required* property leaves its `$else` arm dead;
  the arm is unreachable, not an error.

The pattern slot remains required and contributes one schema — the object
schema — to the derived interface `required` list, even when all its fields
are omittable. Whole-pattern optional and defaulted forms, renamed fields,
and nested patterns are invalid.

### Returned functions

A return type may itself be a function type. A returned bare lambda receives
that type contextually:

```jfn
makeAdder: (x: number) -> (number) -> number => (y) => x + y
```

## Named module types

`type Name = Type` adds an entry to the module's `$types` object. A type
identifier lowers to a definition reference:

```jfn
type UserId = string & pattern("^u_")
type User = {id: UserId, name: string}
```

```json
{
  "$types": {
    "UserId": { "type": "string", "pattern": "^u_" },
    "User": {
      "type": "object",
      "properties": {
        "id": { "$ref": "#/$defs/UserId" },
        "name": { "type": "string" }
      },
      "required": ["id", "name"],
      "additionalProperties": false
    }
  }
}
```

Any non-keyword identifier in a type position is a named reference. Forward
and mutually recursive references are allowed. In a module body, `type` starts
a declaration only when followed by an identifier; `type: expression` and
`{type}` remain data syntax.

Named schemas come from three ownership layers:

1. core builtin definitions;
2. operator-owned contract definitions;
3. guest-owned module `$types`.

The [environment contract](../../deployment/environment-contract.md) owns
schemas used at host boundaries: direct-function signatures, effect parameters
and results, and entry arguments and completion. A module owns its internal
schemas. Both may refer to contract definitions; a module declaration cannot
replace or refine a contract-owned boundary definition.

Definition names do not shadow. A name present in more than one layer is a
`DUPLICATE_DEFINITION` link error. The layers are combined only after their
names are proven disjoint, so every `$ref` has one meaning. This rule does not
change lexical shadowing of ordinary module bindings.

Recursive declarations must be contractive: every cycle passes through an
array or object constructor.

```jfn
type Json = null | boolean | number | string | Json[] | {[string]: Json}
type Tree = {value: number, children: Tree[]}
```

Direct recursive aliases are invalid:

```jfn
type A = A
type B = B | null
```

A discriminated union needs no special syntax:

```jfn
type Event =
    {tag: "move", from: integer, to: integer}
  | {tag: "reset"}
  | {tag: "quit", code: integer}
```

## Task types

`Task<A>` describes a task whose eventual completion value has type `A`:

```text
Task<Result> → {"$taskType":{"$ref":"#/$defs/Result"}}
Task         → {"$taskType":true}
```

The completion type is static only: it is not stored in task records and is not
a runtime contract. `Task` is the only type constructor; other identifiers
cannot take type arguments. The name `Task` is reserved and cannot appear in
contract definitions or module `$types`.

## Assertions

Postfix `!` asserts that a value is non-null:

```jfn
move!.from
```

It lowers to `{"$nonnull": value}`. Evaluation returns a non-null operand
unchanged and raises an evaluation error for `null`. Its result type is the
operand type with `null` removed.

`expression checked as Type` validates a value and gives a successful result
exactly that type:

```jfn
balance + delta checked as Cents
parse(input) checked as {id: integer, name: string}
callback checked as (integer) -> string
```

```json
{
  "$as": {
    "$call": "add",
    "$args": [{ "$var": "balance" }, { "$var": "delta" }]
  },
  "$type": { "$ref": "#/$defs/Cents" }
}
```

The operand need not already be a static subtype. Validation performs no
conversion and raises `RuntimeContractError` on failure. A function ascription
installs a wrapper that validates later arguments and results.

`checked as` has lower precedence than logical and arithmetic operators and is
non-associative. Repeated checks require parentheses:
`(x checked as A) checked as B`. It is a contextual two-token operator;
`checked(value)` remains a call, and a variable with that name is ascribed as
`(checked) checked as Type`.

## Rejected syntax

The following forms are invalid:

- a required function slot after an optional slot;
- a slot after a rest parameter;
- incompatible or object refinements;
- general intersections;
- generic applications other than `Task<A>`;
- whole-pattern optional or defaulted parameters;
- renamed or nested object patterns;

Canonical schemas containing unsupported keywords cannot be expressed with
this syntax and are opaque to static subschema reasoning.

## Informal grammar

This extends the shorthand [grammar](grammar.md):

```ebnf
module       := (moduleEntry (moduleSep moduleEntry)*)?
moduleSep    := physical line break after a complete moduleEntry
moduleEntry  := "type" ident "=" type
              | (ident | string) ":" expr

funcLit      := "(" params ")" ("->" type)? "=>" body
ascription   := orExpr ("checked" "as" type)?
handleExpr   := "handle" expr ("returns" type)? "with"
                "{" (objectEntry ("," objectEntry)*)? "}"

param        := ident
              | ident ":" type
              | ident "?" (":" type)?
              | ident (":" type)? "=" expr
              | "..." ident (":" type)?
              | objectPattern (":" type)?
objectPattern := "{" fieldBinding ("," fieldBinding)* ","? "}"
fieldBinding := ident ("?" | "=" expr)?

type         := union
union        := refined ("|" refined)*
refined      := postfix ("&" refinement)*
postfix      := atom ("[" "]")*
atom         := "null" | "boolean" | "number" | "integer" | "string"
              | "any" | "never"
              | "Task" ("<" type ">")?
              | string | number | "true" | "false"
              | ident
              | objectType
              | "[" (type ("," type)* ("," "..." type "[" "]")?)? "]"
              | fnType
              | "(" type ")"

fnType       := "(" fnTypeParams? ")" "->" type
fnTypeParams := fnSlot ("," fnSlot)* ("," restType)? | restType
fnSlot       := type "?"
              | type
restType     := "..." type "[" "]"

objectType   := "{" "}"
              | "{" "..." "}"
              | "{" objectTypeEntry ("," objectTypeEntry)*
                    ("," "...")? "}"
objectTypeEntry := objField | "[" "string" "]" ":" type
objField     := (ident | string) "?"? ":" type

refinement   := ident ("(" (number | string) ")")?
```

In a rest parameter annotation, the written type must have an array suffix.
`?` is contextual: it marks an object property, a function parameter or
pattern field, or a function-type slot according to its grammatical position.
