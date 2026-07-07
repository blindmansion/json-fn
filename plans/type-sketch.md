# json-fn Type System — Spec Sketch

Status: **draft / design sketch**. Consolidates the design as discussed; grounded in
the current AST (`$fn` / `$var` / `$return` / lazy locals, closures by substitution
via `replaceVars`) but written against a shorthand parser/printer that is not yet in
the repo, so surface syntax details are provisional.

Decisions are marked **[D]**. Open questions are gathered at the end.

---

## 1. Design goals and core idea

1. **Types describe JSON values.** The language's only values are JSON values, so the
   type universe is: null, boolean, number, integer, string, arrays, objects — plus
   unions, literals, and refinements over them.
2. **Types are written in a TypeScript-flavored shorthand, but _parse to JSON
   Schema_.** The schema is the canonical representation: it is the AST of the type,
   the wire format, and directly usable by any off-the-shelf validator. The shorthand
   is sugar with a bijective (canonicalized) round trip.
3. **Types appear only in function signatures.** There are no standalone value
   annotations. Typechecking is derived from signatures: check bodies against their
   declared signatures, check call sites against callee signatures.
4. **Every type is simultaneously a static type and a runtime validator.** When the
   checker can see concrete types, calls are verified statically; when a value is
   `any` (e.g. freshly parsed input), the same schema validates at runtime at the
   function boundary. This dual reading is the system's distinctive feature —
   TypeScript erases types; JSON Schema has no static side; this has both from one
   representation.
5. **The shorthand is a gate.** The syntax can only produce a tractable fragment of
   JSON Schema (§8), so the static subschema checker never faces the pathological
   cases (`not`, `if/then/else`, general `allOf`), even though the JSON AST could
   physically hold them.

---

## 2. Type expressions: shorthand → schema

### 2.1 Primitives

```
null          →  {"type": "null"}
boolean       →  {"type": "boolean"}
number        →  {"type": "number"}
integer       →  {"type": "integer"}
string        →  {"type": "string"}
any           →  true
never         →  false
```

**[D]** `integer` is a distinct primitive (JSON Schema has it; it's cheap and useful).
**[D]** `any` / `never` emit as boolean schemas `true` / `false`, not `{}` / `{"not": {}}`.

### 2.2 Literals

```
"active"      →  {"const": "active"}
42            →  {"const": 42}
true          →  {"const": true}
null          →  {"type": "null"}       // never {"const": null} — one canonical form
```

### 2.3 Unions — three-rule normalization cascade **[D]**

Applied in order; guarantees one canonical schema per type:

1. **All arms literals → `enum`** (mixed value types allowed; `null` joins the enum):

   ```
   "a" | "b" | "c"        →  {"enum": ["a", "b", "c"]}
   "on" | "off" | 0 | 1   →  {"enum": ["on", "off", 0, 1]}
   "a" | null             →  {"enum": ["a", null]}
   ```

2. **All arms bare primitives → `type` array:**

   ```
   number | null          →  {"type": ["number", "null"]}
   ```

3. **Otherwise → `anyOf`**, with adjacent literal arms pre-merged into a single
   enum arm, bare-primitive arms merged into a single type-array arm, nested unions
   flattened, duplicates removed, source order preserved:

   ```
   "auto" | "none" | number
   →  {"anyOf": [{"enum": ["auto", "none"]}, {"type": "number"}]}

   string[] | null
   →  {"anyOf": [{"type": "array", "items": {"type": "string"}}, {"type": "null"}]}
   ```

### 2.4 Arrays and tuples

```
string[]              →  {"type": "array", "items": {"type": "string"}}
any[]                 →  {"type": "array"}                    // items omitted [D]
(string | null)[]     →  {"type": "array", "items": {"type": ["string", "null"]}}

[number, number]      →  {"type": "array",
                          "prefixItems": [{"type": "number"}, {"type": "number"}],
                          "items": false,
                          "minItems": 2}                      // no maxItems [D]

[string, ...number[]] →  {"type": "array",
                          "prefixItems": [{"type": "string"}],
                          "items": {"type": "number"},
                          "minItems": 1}
```

**[D]** Fixed tuples emit `minItems: n` + `items: false`; `maxItems` is omitted as
redundant (redundancy breaks canonical round-tripping).

### 2.5 Objects

**Closed by default [D]** — `additionalProperties: false` unless opened explicitly.
This deliberately differs from raw JSON Schema's open default and must be documented,
since readers of emitted schemas will bring JSON Schema intuitions.

```
{name: string, age?: integer}
→ {"type": "object",
   "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
   "required": ["name"],
   "additionalProperties": false}
```

`?` marks an optional key. **[D]** `required` is always emitted, even when empty,
listing keys in source order.

**Open object** (`...`) omits `additionalProperties`:

```
{name: string, ...}
→ {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}
```

**Maps**, and fixed keys + map for the rest — mapping exactly onto JSON Schema's
semantics (`additionalProperties` applies only to keys not in `properties`):

```
{[string]: number}
→ {"type": "object", "additionalProperties": {"type": "number"}}

{id: string, [string]: number}
→ {"type": "object",
   "properties": {"id": {"type": "string"}},
   "required": ["id"],
   "additionalProperties": {"type": "number"}}
```

**Empty forms:**

```
{}     →  {"type": "object", "required": [], "additionalProperties": false}   // exactly {}
{...}  →  {"type": "object"}                                                  // any object
```

### 2.6 Refinements (`&`)

`&` is **not general intersection** **[D]**. It is a refinement operator attaching
validation keywords to a base type, with a fixed compatibility matrix. Incompatible
combinations (`string & min(0)`) are parse errors, never `allOf`. This is one of the
things that keeps subschema checking easy.

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
Cell[] & minItems(64) & maxItems(64)   // e.g. a chess board
```

**[D]** No object refinements (`minProperties` etc.) in v1.

**Checking semantics [D]:** statically, a refined type is its base type, except that
literal arguments are checked against refinements at compile time (passing `-5` where
`integer & min(0)` is expected is a static error; variables flow through). Full
refinement enforcement happens at runtime, at function boundaries (§6). This is the
"contracts with static syntax" model — most-used JSON Schema constraints without an
SMT solver.

### 2.7 Named types, `$defs`, recursion

**[D]** Every named type lands in `$defs` and is referenced by `$ref` — even
non-recursive ones — so names survive into emitted schemas for error messages and
round-tripping. Anonymous types are always inlined.

```
type UserId = string & pattern("^u_")
type User   = {id: UserId, name: string}
```

```json
{
  "$defs": {
    "UserId": { "type": "string", "pattern": "^u_" },
    "User": {
      "type": "object",
      "properties": { "id": { "$ref": "#/$defs/UserId" }, "name": { "type": "string" } },
      "required": ["id", "name"],
      "additionalProperties": false
    }
  },
  "$ref": "#/$defs/User"
}
```

Recursive types are legal when contractive (recursion passes through an array or
object constructor):

```
type Json = null | boolean | number | string | Json[] | {[string]: Json}
type Tree = {value: number, children: Tree[]}

type A = A            // ERROR: non-contractive
type B = B | null     // ERROR: union arm refers directly to self
```

Discriminated unions need no special syntax — they are unions of closed objects
sharing a `const` field; the checker may detect the shared discriminant for
narrowing and error quality, but the schema encoding is nothing special.

### 2.8 Function types (see §4 for rationale)

JSON Schema has no function types. The type AST gains **one distinguished node**,
`$fnType`, that is not JSON Schema but whose leaves are schemas:

```
(Cell) -> boolean
→ {"$fnType": {"params": [{"$ref": "#/$defs/Cell"}],
               "returns": {"type": "boolean"}}}

(integer, integer) -> integer
→ {"$fnType": {"params": [{"type": "integer"}, {"type": "integer"}],
               "returns": {"type": "integer"}}}
```

Rest params exist in the language (`"...rest"` in `$params`), so the node supports
them:

```
(string, ...number[]) -> string
→ {"$fnType": {"params": [{"type": "string"}],
               "rest": {"type": "number"},
               "returns": {"type": "string"}}}
```

Function types compose with the rest of the system (`((number) -> number)[]`,
`fn | null`, etc.). They cannot appear inside refinements or enums.

---

## 3. Where types live in the program AST

The runtime AST is untouched: programs remain plain JSON evaluated by the existing
interpreter. Types attach at two points.

### 3.1 `$sig` on function bodies **[D]**

Each typed function body carries its signature under a reserved key:

```json
{
  "$sig": {"params": [{"$ref": "#/$defs/Board"}, {"type": "integer"}],
           "returns": {"type": "array", "items": {"type": "integer"}}},
  "$params": ["board", "idx"],
  "$return": { ... }
}
```

Shorthand:

```
pieceMoves: (board: Board, idx: integer) -> integer[] => ...
```

Runtime interaction — three facts about the current evaluator matter:

1. **Unknown body keys are lazy locals**, evaluated only on first `$var` access. A
   `$sig` holding plain schema JSON is therefore runtime-inert _today_, with zero
   evaluator changes: nothing references it, so it never evaluates.
2. Nevertheless, **[D]** `$sig` should be special-cased like `$comment`: excluded
   from the local-name set, skipped by `replaceVars`, preserved through closure
   substitution. Substitution into schema JSON is benign (schemas contain no `$var`),
   but skipping is correct on principle and guards against pathological schemas.
3. `arity`-style introspection could later expose `$sig` to programs; not v1.

### 3.2 Module-level `$types` **[D — working assumption]**

A program (an object of named function bodies, i.e. the registry source) gets one
reserved sibling key holding the module's `$defs` pool:

```json
{
  "$types": {
    "Color":  {"enum": ["w", "b"]},
    "Board":  {"type": "array", "items": {"$ref": "#/$defs/Cell"},
               "minItems": 64, "maxItems": 64},
    ...
  },
  "pieceMoves": { "$sig": ..., "$params": [...], "$return": ... },
  ...
}
```

All `$ref`s in `$sig`s point into this module-level pool. Serializing a single
function standalone requires bundling the transitively referenced `$defs` — a
mechanical transform worth speccing (open question 5 in §9).

---

## 4. Functions: why replacement makes this clean

The evaluator implements closures by **substitution** (`replaceVars`): when a body
escapes as a value, outer variables are replaced by their values directly in the
body's JSON, with shadowed names masked. There is no environment object. Therefore:

**A function value is always a self-contained, inspectable JSON body.**

Consequences the type system leans on:

1. **Signatures travel with values.** Substitution rewrites `$var` nodes only; a
   body's `$sig` passes through verbatim. A closure returned from a curried
   function carries the inner body's signature — so the type of a partial
   application is not inferred, it is _literally present in the returned JSON_.

   ```
   fn makeAdder(x: number) -> (number) -> number
   ```

   The returned body is `{"$sig": ..., "$params": ["y"], "$return": ...}` with `x`
   baked in and `$sig` intact.

2. **Function types are runtime-checkable.** Validating a function-typed argument
   means: check the value is a body shape (`$return` present), then compare its
   embedded `$sig` against the expected `$fnType` (variance-aware, per §5.2). Plain
   JSON Schema could never validate function values meaningfully; embedded
   signatures make it possible.

3. **Lambdas get contextual typing.** Inline anonymous bodies at call sites need no
   written annotations: the checker pushes the expected `$fnType` into the lambda
   (bidirectional checking, TypeScript-style), verifies the body under those param
   types, and **[D]** stamps the resolved `$sig` onto the body so the signature is
   carried if the value escapes.

---

## 5. Static checking

### 5.1 The checker is a subschema checker

Typechecking a call `f(x)` where `x : S` against a param `T` is deciding `S ⊆ T`
over schemas. Over full JSON Schema this is intractable in practice; over the
canonical fragment the shorthand can emit, it decomposes structurally:

- **Primitives / type arrays:** set inclusion over type names (`integer ⊆ number`).
- **enum/const:** every member of S's enum must validate against T.
- **Refinements:** interval inclusion for numeric/length/items bounds
  (`minimum: 5 ⊆ minimum: 0`); `multipleOf` by divisibility; `pattern` and `format`
  by **syntactic equality only** **[D]** — regex-language inclusion is a tar pit;
  on mismatch, defer to runtime.
- **Arrays/tuples:** `items` covariant; prefixItems pointwise; length bounds by
  interval inclusion; tuple ⊆ array when every prefix item (and rest) fits `items`.
- **Objects:** T's required ⊆ S's required; per-property subschema; S's
  `additionalProperties` must fit T's (closed ⊆ open; closed ⊆ closed needs S's
  property set to be admissible under T).
- **Unions:** every arm of S must fit some arm of T.
- **`$ref`:** coinductive — carry a seen-pairs set `(S_ref, T_ref)` and assume
  success on revisit, so recursive types terminate.
- **Boolean schemas:** everything ⊆ `true`; `false` ⊆ everything.

**Escape hatch [D]:** the JSON type AST can physically hold schemas outside the
canonical fragment (hand-written `not`, `if/then/else`, ...). These are treated as
**opaque**: runtime-validated, statically compatible only with `any` and themselves
(by structural equality), rendered in tooling as `schema({...})`.

### 5.2 Function subtyping

`(P1..Pn) -> R  ⊆  (Q1..Qn) -> S` iff `Qi ⊆ Pi` for all i (params contravariant)
and `R ⊆ S` (return covariant). Rest params compare as the element schema,
contravariantly. Arity: a function accepting fewer params may be used where more are
supplied only if the language's "missing args default to null / extra args ignored"
semantics is embraced by the checker — **[D — lean strict]**: require exact arity in
v1 (modulo rest params); loosen later if idiomatic code demands it.

### 5.3 Builtins: per-builtin call-site rules, no user-facing generics **[D]**

Monomorphic stdlib signatures would launder everything to `any` (`setAt(board, i, p)`
returning `any[]` silently disables checking downstream — observed directly in the
chess example, where half the dataflow runs through `map`/`flatMap`/`setAt`/`concat`).
Full user-facing generics are a large lift. The resolution:

- Builtins get **checker-internal polymorphic rules**, not expressible in user
  syntax: `setAt : (T[], integer, T) -> T[]`, `map : ((T, integer) -> U, T[]) -> U[]`,
  `concat : variadic T[] -> T[]` (T = union of element types), etc.
- This works because callbacks at HOF call sites are, in practice, **inline literal
  bodies** (every callback in the chess example is), so the checker sees concrete
  types at each site — local inference, no unification engine.
- Lambdas are second-class through _user_ signatures only in the sense that a user
  function taking a callback must declare a concrete `$fnType` (no user generics);
  builtins are the polymorphic layer.

### 5.4 Dynamic dispatch

`{"$fn": [head, ...]}` where head is an expression:

- Literal string name → registry lookup, use that `$sig`.
- Variable of function type → use the `$fnType`.
- Variable typed as a **union of literal names** (`"add" | "mul"`) → the call types
  against the _meet_ of the referenced signatures (params: union per position;
  return: union). Feasible; needs speccing.
- `any` head → unchecked call, result `any` (plus optional runtime validation).

### 5.5 Narrowing, lazy locals, and the compute-then-branch idiom

The dominant idiom in real code (per the chess example) binds everything in a lazy
`where`/locals block, then selects with `$cond` — guards appear _after_ the bindings
they protect:

```
move: parseMove(input),          // Move | null
legal: isLegalMove(b, move.from, move.to, turn),   // touches move before null check
...
$cond: [[isNull(move), badParse], ..., [else, useLegal]]
```

This is correct **only because locals are lazy**: `legal` is never forced on the
null branch. A naive flow checker flags it; an honest one must type lazy bindings
at their **forcing sites**, narrowed by the guards dominating that site
(per-cond-arm narrowing). Options, in increasing ambition:

1. **v1 [D — recommended]:** no flow narrowing. Property access on `T | null` and
   similar mismatches produce _warnings_ downgraded to runtime checks, not errors;
   an explicit assertion operator (`move!.from` → runtime-checked cast) silences
   them. Honest about what the checker knows; unblocks everything else.
2. **v2:** per-branch narrowing for the common guards (`isNull`, `==` on
   discriminant consts, `inBounds`-style user predicates are out of scope) applied
   to local _uses_ within `$cond`/`$if` arms, exploiting laziness: a local's type
   may differ per arm.
3. Refinements interact identically: refinement contracts must attach to **forcing,
   not binding** — the chess `slideDir` deliberately computes out-of-bounds
   `toIdx(...)` results that are never used. Eager contracts would fire on dead
   values. Practically: refine at true boundaries (`parseSquare`, `State`), keep
   hot internal helpers (`toIdx`) loosely typed.

Related observation: the stdlib mixes `null` sentinels (expressible: `T | null`)
with `-1` sentinels (`indexOf`, `findIndex` — not expressible as a distinct type).
The type system exerts healthy pressure toward null-returning stdlib variants.

### 5.6 Exhaustiveness

`$match` over a value typed as a literal union can be checked exhaustive; `$else`
required by the language, so exhaustiveness is a lint ("else unreachable" /
"case 'X' unhandled") rather than a soundness feature. Cheap and high-value given
how much real code switches on discriminants.

---

## 6. Runtime checking

Because every type is a schema, the boundary story is uniform:

- **Static-trusted calls** (caller types known, subschema check passed): no runtime
  validation needed.
- **`any`-typed inputs** (parsed JSON, host-supplied args, opaque schemas, deferred
  pattern/format checks, assertion operators): validate against the param schemas at
  function entry; optionally validate returns.
- **Function-typed params:** shape-check the body + variance-compare embedded
  `$sig` (§4.2).
- **[D]** Validation failures are ordinary evaluation errors with schema paths
  (`params[0].board[12]: expected "w"|"b"|null`).
- Hosts choose the enforcement level per call: `off | boundaries | everything`
  (mirrors the existing execution-limits pattern of host-configured strictness).

---

## 7. Worked example: chess data layer

```
type Color  = "w" | "b"
type Piece  = "K"|"Q"|"R"|"B"|"N"|"P"|"k"|"q"|"r"|"b"|"n"|"p"
type Cell   = Piece | null
type Board  = Cell[] & minItems(64) & maxItems(64)
type Status = "playing" | "checkmate" | "stalemate"
type State  = {board: Board, turn: Color, status: Status}
type Move   = {from: integer, to: integer}
type Result = {output: string, stderr: string, newState: State | null,
               reset: boolean, exitCode: integer}

fn pieceColor(piece: Cell) -> Color | null
fn slideDir(board: Board, row: integer, col: integer,
            dr: integer, dc: integer, color: Color) -> integer[]
fn parseMove(s: string) -> Move | null
fn playMove(state: State, from: integer, to: integer) -> State
fn handleCommand(state: State, argv: string[]) -> Result
fn pieceMoves(board: Board, idx: integer) -> integer[]
```

Everything above is expressible with zero ceremony; `Cell` is where `enum` + `null`
canonicalization earns its keep (`{"enum": ["K",...,"p", null]}`... note: `Piece | null`
normalizes under rule 1 with `Piece` inlined — or stays `anyOf($ref, null)` if named;
see open question 7). The known strains are exactly §5.3 (builtin polymorphism) and
§5.5 (lazy compute-then-branch) — syntax is not the bottleneck; checking semantics are.

---

## 8. Deliberately inexpressible

The shorthand cannot emit: `not`, `if`/`then`/`else`, `oneOf` (exclusivity),
general `allOf`, `patternProperties`, `propertyNames`, `dependentRequired`,
`dependentSchemas`, `contains`, `unevaluatedProperties`/`unevaluatedItems`.
User-facing generics are also excluded (builtins are internally polymorphic, §5.3).
Hand-written schemas using excluded keywords are opaque per §5.1.

---

## 9. Open questions

1. **Optional tuple elements** — `[string, number?]` → `minItems: 1`? Or disallow?
2. **Refinements on tuples** (`[number, number] & unique`) — allow, or parse error
   given the tuple already owns `minItems`/`items`?
3. **Param defaults** — `punct?: string = "!"` — language feature, not schema;
   where does the default live in the body/`$sig`?
4. **Optional params vs missing-args-are-null** — the language nulls missing args.
   Does `?` on a param mean "may omit" (arity), "type is `T | null`", or both?
   Interacts with §5.2 arity strictness.
5. **`$defs` bundling** — the transform for serializing one function (with `$sig`
   `$ref`s) standalone from the module `$types` pool.
6. **Union-of-names dispatch** (§5.4) — spec the signature meet precisely.
7. **Named-type inlining in normalization** — does `Piece | null` (where `Piece` is
   a named enum) normalize to one enum-with-null (breaking the `$ref`, better
   canonically) or stay `anyOf[$ref, null]` (preserving the name, better errors)?
8. **`integer | number` collapse** — normalize to `number` at parse time, or leave
   to the checker?
9. **Assertion operator syntax** (`x!`, `x!!`, `assert(x, T)`) and whether it emits
   a runtime check node in the AST or is checker-only metadata.
10. **Stdlib nullable variants** — add `find`/`indexOf`-style functions returning
    `T | null` instead of `-1` sentinels, so signatures can be honest.
11. **`$sig` evaluator handling** — ship as inert-lazy-local (works today) or
    special-case immediately like `$comment` (recommended; small change to the
    local-name mask and `replaceVars`).
