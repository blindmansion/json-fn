# json-fn Type Syntax Specification

A TypeScript-flavored surface syntax for **types** in `.jfn` shorthand. Types
annotate function signatures and are declared at module level; the **canonical
form is JSON Schema** (the fragment in `typescript/src/check/`). Type syntax
lowers deterministically to that schema, and the schema pretty-prints back.

- **Types describe JSON values.** The value universe is JSON, so the type
  universe is null / boolean / number / integer / string / arrays / objects,
  plus unions, literals, and refinements over them.
- **Types live only in checked positions.** They appear in declarations,
  function signatures, total-handler result contracts, and checked value
  ascriptions. There are no unchecked standalone value annotations.
- **Every type is also a runtime validator.** The same schema that types a call
  statically validates an `any` value at a function boundary.
- **The shorthand is a gate.** It can only emit a tractable fragment of JSON
  Schema (§10); the static subschema checker never faces `not`, `if/then/else`,
  general `allOf`, etc.

Remaining deferred features (local types, bodyless signatures, and annotated
locals) are tracked in
[`plans/type-syntax-deferred.md`](../plans/type-syntax-deferred.md).

---

## 1. Where types appear

Exactly four positions:

1. **Module-level type declarations** — `type Name = <type>` entries in the
   file's top-level object, lowering to the reserved `$types` sibling (§8).
2. **Function signatures** — inline param annotations `name: <type>` and a return
   type `-> <type>` on a function literal header (§7).
3. **Total effect handlers** — `handle task -> <type> with { … }` declares the
   immediate result contract of the handler.
4. **Checked value ascriptions** — `expression as <type>` validates the
   expression at runtime and gives the successful result that type.

Type *declarations* are module-top-level only. Type *expressions* (the `<type>`
grammar, §2–§6) appear in all four positions, so they can occur inside nested
function headers, handler expressions, and value ascriptions too.

---

## 2. Primitives, `any`, `never`

```
null          →  {"type": "null"}
boolean       →  {"type": "boolean"}
number        →  {"type": "number"}
integer       →  {"type": "integer"}
string        →  {"type": "string"}
any           →  true
never         →  false
```

`integer` is a distinct primitive. `any`/`never` emit as boolean schemas
`true`/`false`.

---

## 3. Literals

```
"active"      →  {"const": "active"}
42            →  {"const": 42}
true          →  {"const": true}
null          →  {"type": "null"}       // canonical; never {"const": null}
```

---

## 4. Unions — `A | B | C`

Left-to-right, flattened; a **three-rule normalization cascade** picks one
canonical schema:

1. **All arms literals → `enum`** (`null` joins the enum):

   ```
   "a" | "b" | "c"        →  {"enum": ["a", "b", "c"]}
   "on" | "off" | 0 | 1   →  {"enum": ["on", "off", 0, 1]}
   "a" | null             →  {"enum": ["a", null]}
   ```

2. **All arms bare primitives → `type` array:**

   ```
   number | null          →  {"type": ["number", "null"]}
   ```

3. **Otherwise → `anyOf`**, with adjacent literal arms pre-merged into one enum
   arm, bare-primitive arms merged into one type-array arm, nested unions
   flattened, duplicates removed, source order preserved:

   ```
   "auto" | "none" | number
   →  {"anyOf": [{"enum": ["auto", "none"]}, {"type": "number"}]}
   ```

`|` is the lowest-precedence type operator. To put a function type in a union,
parenthesize it (§6).

---

## 5. Composites

### 5.1 Arrays and tuples

```
string[]              →  {"type": "array", "items": {"type": "string"}}
any[]                 →  {"type": "array"}                        // items omitted
(string | null)[]     →  {"type": "array", "items": {"type": ["string", "null"]}}

[number, number]      →  {"type": "array",
                          "prefixItems": [{"type": "number"}, {"type": "number"}],
                          "items": false, "minItems": 2}

[string, ...number[]] →  {"type": "array",
                          "prefixItems": [{"type": "string"}],
                          "items": {"type": "number"}, "minItems": 1}
```

The `[]` suffix is postfix and repeatable (`number[][]`). Fixed tuples emit
`minItems: n` + `items: false` (no `maxItems`).

### 5.2 Objects

**Closed by default** — `additionalProperties: false` unless opened with `...`.
(This differs from raw JSON Schema's open default.)

```
{name: string, age?: integer}
→ {"type": "object",
   "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
   "required": ["name"], "additionalProperties": false}
```

`?` marks an optional key (omitted from `required`). `required` is always emitted
(even when empty), in source order.

**Open** object (`...`) omits `additionalProperties`:

```
{name: string, ...}
→ {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}
```

**Map**, and fixed keys + map for the rest:

```
{[string]: number}
→ {"type": "object", "additionalProperties": {"type": "number"}}

{id: string, [string]: number}
→ {"type": "object", "properties": {"id": {"type": "string"}},
   "required": ["id"], "additionalProperties": {"type": "number"}}
```

Empty forms:

```
{}     →  {"type": "object", "required": [], "additionalProperties": false}
{...}  →  {"type": "object"}
```

### 5.3 Refinements — `&`

`&` is **not intersection** — it is a refinement operator attaching validation
keywords to a base type, with a fixed compatibility matrix. Incompatible
combinations are never `allOf`; they are rejected. When the base is a **primitive
keyword** (`string & min(0)`) this is a **parse error**; when the base is a
**named type** (`UserId & min(0)`) the parser cannot see the underlying type, so
the mismatch is a **checker error** instead.

| Refinement                    | Valid on        | Keyword                                 |
| ----------------------------- | --------------- | --------------------------------------- |
| `min(n)` / `max(n)`           | number, integer | `minimum` / `maximum`                   |
| `xmin(n)` / `xmax(n)`         | number, integer | `exclusiveMinimum` / `exclusiveMaximum` |
| `multipleOf(n)`               | number, integer | `multipleOf`                            |
| `minLen(n)` / `maxLen(n)`     | string          | `minLength` / `maxLength`               |
| `pattern(re)`                 | string          | `pattern`                               |
| `format(name)`                | string          | `format`                                |
| `minItems(n)` / `maxItems(n)` | array           | `minItems` / `maxItems`                 |
| `unique`                      | array           | `uniqueItems: true`                     |

```
integer & min(0) & max(63)   →  {"type": "integer", "minimum": 0, "maximum": 63}
string & pattern("^u_")      →  {"type": "string", "pattern": "^u_"}
Cell[] & minItems(64) & maxItems(64)
```

`&` binds tighter than `|` and looser than the `[]` suffix. No object
refinements in v1.

---

## 6. Function types — `(A, B) -> R`

JSON Schema has no function types; they lower to the distinguished `$fnType`
node whose leaves are schemas.

```
(Cell) -> boolean
→ {"$fnType": {"required": [{"$ref": "#/$defs/Cell"}], "optional": [], "returns": {"type": "boolean"}}}

() -> State
→ {"$fnType": {"required": [], "optional": [], "returns": {"$ref": "#/$defs/State"}}}

(string, ...number[]) -> string
→ {"$fnType": {"required": [{"type": "string"}], "optional": [], "rest": {"type": "number"},
               "returns": {"type": "string"}}}

(string, integer?) -> boolean
→ {"$fnType": {"required": [{"type": "string"}], "optional": [{"type": "integer"}],
               "returns": {"type": "boolean"}}}
```

- A `?` after a parameter type marks that callable slot as optional. It applies
  to the complete preceding type: `(string, (number | null)?) -> boolean` has
  one required slot and one optional slot whose supplied-value schema is
  `number | null`.
- Optionality is not nullability. `(A?) -> R` accepts zero or one arguments;
  `(A | null) -> R` requires one argument whose value may be `null`.
- Required slots precede optional slots, followed only by an optional rest
  type. For example, `(A, B?, C?, ...D[]) -> R` is valid and
  `(A?, B) -> R` is not.
- A callable accepts at least its `required.length` arguments and, without
  rest, at most `required.length + optional.length`. Rest removes only the
  upper bound.
- Function types do not record whether an optional slot is plain optional or
  defaulted. That distinction belongs to a function body's `$params`;
  `$fnType.optional` records only the callable omission contract.
- Function compatibility first requires equal required counts, equal optional
  counts, and matching rest presence. Within that shape, parameter schemas are
  contravariant and the return schema is covariant.
- The return type extends as far right as possible (lowest precedence within a
  function type), so `(A) -> B | C` returns `B | C`.
- To use a function type as a union arm or array element, parenthesize:
  `((Event) -> Result) | null`, `((number) -> number)[]`.
- Function types compose everywhere except inside refinements and enums.

---

## 7. Function signatures

A signature is inline param annotations plus a return type on a function
literal, lowering to a `$sig` sibling on the body:

```jfn
otherColor: (color: Color) -> Color => if color == "w" then "b" else "w"
```

```json
{
  "$sig": { "required": [{ "$ref": "#/$defs/Color" }], "optional": [], "returns": { "$ref": "#/$defs/Color" } },
  "$params": ["color"],
  "$return": { "$if": { "$call": "eq", "$args": [{ "$var": "color" }, "w"] }, "$then": "b", "$else": "w" }
}
```

Rules:

- **All-or-nothing.** A function literal is either **fully typed** (every param
  annotated *and* a `-> Ret` return type) or **bare** (no annotations, no `$sig`).
  A partial signature (some params typed, or params typed without a return type)
  is a **parse error**.
- **Module-level functions must be fully typed.** A top-level function binding
  without a signature is an error (enforced by the checker; §9 of the plan).
  Nested helpers (`where`-local functions) and inline lambdas passed to builtins
  **may be bare** — bare lambdas at higher-order call sites are contextually typed.
- **Fixed signature schemas align with normalized `$params` slots.**
  `$sig.required` aligns with the leading required positional slots, including
  object patterns. `$sig.optional` then aligns with the trailing omittable
  slots—both `{ "$param": name, "$optional": true }` and
  `{ "$param": name, "$default": expression }`—in source order. Object fields
  do not consume additional signature positions.
- **Rest aligns separately.** `$sig.rest`, when present, is the element schema
  for the final `"...rest"` slot and is not part of either fixed array.
- **Omittable annotations are supplied-value schemas.** In `name?: T` and
  `name: T = expr`, `T` is the schema checked when the caller supplies that
  argument. The local type of a plain optional binding is `T | null`; the local
  type of a defaulted binding is `T`.

### 7.1 Optional and defaulted parameters

The binding marker determines the canonical `$params` descriptor and whether
the aligned annotation enters `$sig.required` or `$sig.optional`:

```jfn
greet: (name: string, title?: string, punctuation: string = "!") -> string => ...
```

```json
{
  "$sig": {
    "required": [{ "type": "string" }],
    "optional": [{ "type": "string" }, { "type": "string" }],
    "returns": { "type": "string" }
  },
  "$params": [
    "name",
    { "$param": "title", "$optional": true },
    { "$param": "punctuation", "$default": "!" }
  ]
}
```

The marker precedes a type annotation for `?` (`name?: T`) and the default
follows a complete type annotation (`name: T = expr`), matching
TypeScript-style parameter spelling. Bare functions use the same binding forms
without annotations: `(name, title?, punctuation = "!") => …`.

`?` and `=` are mutually exclusive on one parameter. Both make the slot
omittable, so every required parameter must precede them and a rest parameter
may only follow them. The default expression is checked against `T` even when
unused, but it is not represented in `$sig`: callable types preserve omission,
not the implementation's fallback expression.

The runtime meaning differs from JavaScript/TypeScript:

- omission of `name?: T` produces `null`, not `undefined`;
- explicit `null` is a supplied value and is accepted only when `T` permits it;
- explicit `null` never activates a default;
- defaults are lazy and use the complete recursive body scope rather than a
  left-to-right parameter-initialization scope.

### 7.2 Rest parameters

Written with the array suffix (matching how the args arrive), lowering the
element type to `$sig.rest`:

```jfn
concatAll: (first: string, ...rest: string[]) -> string => ...
```

```json
{ "$sig": { "required": [{ "type": "string" }], "optional": [], "rest": { "type": "string" },
            "returns": { "type": "string" } },
  "$params": ["first", "...rest"] }
```

### 7.3 Object-pattern parameters

The annotation attaches to the whole pattern (which consumes one object
argument); the object type becomes that param's schema:

```jfn
daysInMonth: ({ year, month }: Date) -> integer => ...
```

```json
{ "$sig": { "required": [{ "$ref": "#/$defs/Date" }], "optional": [], "returns": { "type": "integer" } },
  "$params": [{ "$fields": ["year", "month"] }] }
```

An inline object type works too: `({ from, to }: { from: integer, to: integer })`.

Optional and defaulted pattern fields use `field?` and `field = expr`. Their
binding behavior and their containing input contract remain distinct:

```jfn
normalize: (
  { required, label?, count = 0 }:
  { required: string, label?: string, count?: integer }
) -> integer => ...
```

The pattern lowers `label` and `count` to optional/defaulted `$fields`
descriptors. Independently, the object annotation omits both properties from
its JSON Schema `required` array. A required pattern field must correspond to a
required input property; an optional or defaulted pattern field must correspond
to an optional input property. In particular, annotating `count` as required
would make its default unreachable and is a checker error.

The object-pattern slot itself remains required and contributes one schema to
`$sig.required`, even when every field is omittable. There is no optional or
defaulted whole-pattern form.

### 7.4 Returned / curried functions

The return type may itself be a function type; the inner lambda is contextually
typed (no inner annotations) and the resolved `$sig` is stamped onto it:

```jfn
makeAdder: (x: number) -> (number) -> number => (y) => x + y
```

---

## 8. Named types & the module `$types` pool

`type Name = <type>` entries in the top-level object populate the reserved
`$types` sibling. Named references resolve to `$ref`:

```jfn
{
  type UserId = string & pattern("^u_"),
  type User   = { id: UserId, name: string },

  makeUser: (id: UserId, name: string) -> User => { id, name }
}
```

```json
{
  "$types": {
    "UserId": { "type": "string", "pattern": "^u_" },
    "User": { "type": "object",
              "properties": { "id": { "$ref": "#/$defs/UserId" }, "name": { "type": "string" } },
              "required": ["id", "name"], "additionalProperties": false }
  },
  "makeUser": { "$sig": { "required": [{ "$ref": "#/$defs/UserId" }, { "type": "string" }], "optional": [],
                          "returns": { "$ref": "#/$defs/User" } },
                "$params": ["id", "name"], "$return": { "id": { "$var": "id" }, "name": { "$var": "name" } } }
}
```

- Any non-keyword identifier in a type position is a named reference (`$ref`);
  the parser does not resolve it (that is the checker's job), so forward and
  mutually recursive references parse fine.
- **Disambiguation from data keys.** In the module object, `type` is a
  contextual keyword only when followed by an identifier (`type Color = …`).
  `type: expr` (a data entry) and `{ type }` (punning) are unaffected.

### 8.1 Recursion

Legal when **contractive** (recursion passes through an array or object
constructor):

```jfn
type Json = null | boolean | number | string | Json[] | { [string]: Json },
type Tree = { value: number, children: Tree[] }
```

Non-contractive declarations are errors:

```
type A = A            // ERROR: non-contractive
type B = B | null     // ERROR: union arm refers directly to self
```

### 8.2 Discriminated unions

No special syntax — a union of closed objects sharing a `const` field:

```jfn
type Event =
    { tag: "move", from: integer, to: integer }
  | { tag: "reset" }
  | { tag: "quit", code: integer }
```

---

## 9. Checked assertion operators

### 9.1 Non-null assertion

`x!` narrows away `null` when a value is known to be non-null at its use site:

```jfn
legal: isLegalMove(state.board, move!.from, move!.to, state.turn)   // move! : Move
```

The operator lowers to `{ "$nonnull": x }`. Evaluation returns a non-null
operand unchanged and raises an evaluation error when the operand is `null`, so
the assertion remains sound at runtime.

### 9.2 Checked value ascription

`expression as Type` validates a value against an explicit type and gives the
successful expression exactly that type:

```jfn
balance + delta as Cents
parse(input) as { id: integer, name: string }
callback as (integer) -> string
```

It lowers to a canonical expression containing the value and the type's schema:

```json
{
  "$as": { "$call": "add", "$args": [{ "$var": "balance" }, { "$var": "delta" }] },
  "$type": { "$ref": "#/$defs/Cents" }
}
```

The operand need not already be a static subtype of the target: the runtime
contract is the evidence for the result type. Evaluation performs no
conversion, and a failed contract raises `RuntimeContractError`. Function types
install a wrapper that checks eventual arguments and return values.

`as` has lower precedence than all logical and arithmetic operators and is
non-associative. Write `(x as A) as B` for repeated checks.

---

## 10. Deliberately inexpressible

The type syntax cannot emit `not`, `if`/`then`/`else`, `oneOf`, general `allOf`,
`patternProperties`, `propertyNames`, `dependent*`, `contains`,
`unevaluated*`, or object refinements. General user-facing generics are
excluded (builtins are internally polymorphic); the sole type constructor is
the erased built-in `Task<A>` completion index. Hand-written schemas using
excluded keywords are treated as opaque by the checker.

---

## 11. Grammar (informal EBNF)

Extends [`docs/shorthand-spec.md`](./shorthand-spec.md) §10. New/changed rules:

```
module      := "{" ( moduleEntry ("," moduleEntry)* )? "}"     // top-level object
moduleEntry := "type" ident "=" type                           // type declaration
             | dataEntry                                        // binding / constant / pun

funcLit     := "(" params ")" ( "->" type )? "=>" body         // return type optional*
param       := ident                                            // untyped required
             | ident ":" type                                   // typed required
             | ident "?" (":" type)?                            // optional
             | ident (":" type)? "=" expr                       // defaulted
             | "..." ident (":" type)?                         // rest (array-suffixed type)
             | objectPattern (":" type)?                       // pattern annotation
objectPattern := "{" fieldBinding ("," fieldBinding)* ","? "}"
fieldBinding  := ident ( "?" | "=" expr )?
  // *within one funcLit, annotations are all-or-nothing (§7)

type        := union
union       := refined ( "|" refined )*
refined     := postfix ( "&" refinement )*
postfix     := atom ( "[" "]" )*                               // array suffix
atom        := "null" | "boolean" | "number" | "integer" | "string"
             | "any" | "never"
             | "Task" ("<" type ">")?                         // bare Task = Task<any>
             | string | number | "true" | "false"             // literals
             | ident                                           // named type ($ref)
             | objectType
             | "[" ( type ("," type)* ("," "..." type "[" "]")? )? "]"   // tuple
             | fnType
             | "(" type ")"
fnType      := "(" fnTypeParams? ")" "->" type
fnTypeParams := fnSlot ("," fnSlot)* ("," restType)?
              | restType
fnSlot      := type "?"?
restType    := "..." type "[" "]"
objectType  := "{" ( objField ("," objField)* )? ("," "...")? "}"
             | "{" "..." "}"
             | "{" "[" "string" "]" ":" type ("," "...")? "}"          // map (+ open)
objField    := (ident | string) "?"? ":" type
refinement  := ident ( "(" (number | string) ")" )?           // e.g. min(0), unique, pattern("^u_")
```

`?` is a contextual omission marker: after an object-type key it makes the
property optional; after a function binding or object-pattern field it selects
the optional canonical descriptor; after a function-type slot it places that
schema in `$fnType.optional`. These positions are grammatically distinct.
Optional tuple elements remain unresolved below.

---

## 12. Open decisions (tracked)

- 🔴 **Optional tuple elements** — `[string, number?]`: allow (→ `minItems`) or
  disallow? The resolved `(string, number?) -> R` function-slot syntax does not
  imply an answer for tuples.
- 🔴 **`integer | number` collapse** — normalize to `number` at parse time or
  leave to the checker?
- 🔴 **Named-type inlining** — does `Piece | null` (named enum `Piece`) normalize
  to one enum-with-null (loses the name) or stay `anyOf[$ref, null]`?
- 🟡 **Assertion operator** spelling + runtime node (deferred doc §7).
- 🟡 **`->` triple duty** — return type / function-type / arm; distinct token?
  (deferred doc §6).

Everything else here is resolved and implementable.
