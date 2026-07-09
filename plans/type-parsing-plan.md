# Type Syntax — Parser/Printer Implementation Plan

Status: **plan.** Implements the surface syntax in
[`docs/type-syntax-spec.md`](../docs/type-syntax-spec.md) in the TypeScript
shorthand pipeline. The canonical JSON form and the checker already exist
(`typescript/src/check/`); this is the *parsing/printing* side that closes the
loop.

---

## 0. Architecture: where the fork happens (correcting the mental model)

The working assumption was "types are only a module-level concern, so the fork
happens there." That is **true for type *declarations*, but not for type
*expressions*.** Two distinct forks:

1. **Type declarations** (`type Name = <type>`) — a **module-top-level** concern.
   They appear only as entries of the file's outermost object and lower into the
   `$types` sibling. Fork point: a new `parseModule` that recognizes `type`
   entries. Nested objects never accept `type` declarations.

2. **Type expressions** (the `<type>` grammar) — **not** module-only. They also
   appear inside **function-literal headers** (`(p: T) -> R =>`), which can be
   nested arbitrarily (a `where`-local helper can be typed). So the
   type-expression parser must be reachable from `parseParams`/`parseFuncLit`,
   not just the module level.

The clean design the mental model was reaching for still holds: **type-expression
parsing is a self-contained sub-grammar that never re-enters the term parser.**
Once we enter "type mode" we stay there until a known boundary token
(`=>`, `,`, `)`, `}`, `]`, `->` in some positions) hands control back. The term
parser and type parser share only low-level cursor helpers, not grammar. So we
get two separate modules with a shared base, exactly as hoped — the fork is by
**syntactic position** (three entry points), and the module-level piece is just
one of them.

Three entry points into the shared type-expression parser:

- after `type Name =` (module declaration),
- after `:` in a param (`parseParams`),
- after `->` in a funcLit header (`parseFuncLit`).

### 0.1 Enforcement tiers

Rule of thumb: **the parser never resolves a name or compares two types.** If a
rule needs either, it belongs to the checker.

- **Lexer** — lexical errors only (bad char, unterminated string).
- **Parser** — grammar + lowering, plus rules decidable from **local structure
  alone**: all-or-nothing signatures, and refinements on a **primitive** base
  (`string & min(0)`). It emits `$sig`/`$types`/`$ref` but never validates them.
- **Checker** — everything semantic: undefined/`$ref` type names, recursion
  contractiveness, refinements on a **named** base (`UserId & min(0)`),
  "module functions must be typed" (§9), subtyping/arity.

---

## 1. Lexer changes (`typescript/src/shorthand/lexer.ts`)

Two additive tokens. Both characters are **currently lexer errors**, so nothing
existing breaks — the term grammar simply never asks for them.

- **`pipe`** for a single `|`. Today `lexSymbol` throws `"unexpected '|'; use
  '||'"` on a lone `|`; change it to return `{ type: "pipe" }` (keep the
  `||` → `oror` path).
- **`question`** for `?`. Today `?` hits the `default` `"unexpected character"`
  throw; add a case returning `{ type: "question" }`.

Add both to the `TokPunct` union. No other lexer work: `->` (`arrow`), `&`
(`amp`), `[`/`]`, `{`/`}`, `:`, `,`, `...` (`dotdotdot`), numbers, strings, and
`ident` already cover the type grammar. Refinement args reuse `num`/`str`.

> Note: `amp` (`&`) currently means "function reference" in the term grammar and
> "refinement" in the type grammar. No conflict — they live in disjoint parser
> contexts. Same for `[` (access vs array-suffix/tuple) and `{` (data object vs
> object type).

---

## 2. Extract a shared cursor base

Both parsers need the token-stream primitives. Extract them from `Parser` into a
small base class in a new file (e.g. `typescript/src/shorthand/cursor.ts`):

```
class TokenCursor {
  protected tokens: Token[];
  protected pos = 0;
  peek/peek2/peekType/advance/err/expect/isKeyword/eatKeyword/expectKeyword/expectIdent
}
```

`Parser extends TokenCursor` (unchanged behavior). The type parser subclasses it
too. This is the "shared helpers" seam; keep it mechanical (pure move, no logic
change) so the existing parser tests stay green.

---

## 3. New type-expression parser (`typescript/src/shorthand/type-parser.ts`)

A `TypeParser extends TokenCursor`, constructed with the shared `tokens` array
and a starting `pos`. It exposes `parseType(): Schema` and, being a subclass, its
`pos` advances the same array. Integration pattern at each fork point:

```
const tp = new TypeParser(this.tokens, this.pos);
const schema = tp.parseType();
this.pos = tp.pos;      // resync the term parser to where types left off
```

(Alternatively expose `parseType` as free functions over an explicit cursor —
either works; the subclass keeps method style consistent with `Parser`.)

### 3.1 Grammar (precedence low → high)

Mirror `docs/type-syntax-spec.md` §11:

- `parseType` → `parseUnion`
- `parseUnion`: `parseRefined ( "|" parseRefined )*` → union normalization (§3.2)
- `parseRefined`: `parsePostfix ( "&" refinement )*` → attach keyword, validate
  against the base per the §5.3 matrix (else `err`)
- `parsePostfix`: `parseAtom ( "[" "]" )*` → wrap each `[]` as
  `{type:"array", items: inner}` (omit `items` when inner is `any`/`true`)
- `parseAtom`:
  - primitive keywords (`null|boolean|number|integer|string`) → `{type: kw}`
  - `any` → `true`, `never` → `false`
  - literals (`str`, `num`, `true`, `false`) → `{const: v}`; bare `null` handled
    by the primitive case as `{type:"null"}`
  - `{` → object type (§3.3)
  - `[` → tuple (§3.4)
  - `(` → function type **or** grouping: lookahead for a matching `)` followed by
    `->` (reuse the `looksLikeFuncLit` scan idea); if `->`, parse `fnType`, else
    parse `"(" parseType ")"`
  - `ident` (non-keyword) → `{$ref: "#/$defs/" + name}`

### 3.2 Union normalization

Collect arms left-to-right (flatten nested unions), then the three-rule cascade:

1. all arms are literal-carrying (`const`/`enum`, incl. `{type:"null"}` for
   `null`) → merge into one `{enum: [...]}` (dedupe, source order; `null` becomes
   the value `null` in the enum)
2. all arms are bare primitives (`{type: name}`) → `{type: [names]}`
3. otherwise → `anyOf`, pre-merging adjacent literal arms into one `enum` arm and
   bare-primitive arms into one `type`-array arm; dedupe; preserve order

A single arm returns as-is (no wrapper). This logic is the parse-side mirror of
`check/schema.ts` `unionOf` but with full canonicalization (the checker's
`unionOf` is deliberately dumb; canonical spelling is the surface's job).

### 3.3 Object types

Iterate `{ ... }` fields:

- `key ("?")? ":" type` — key is `ident` or `str`; `?` ⇒ optional (omit from
  `required`); accumulate `properties` + `required` (source order)
- `[ "string" ] ":" type` ⇒ map (`additionalProperties: <type>`)
- trailing `...` ⇒ open (omit `additionalProperties`); otherwise closed
  (`additionalProperties: false`)
- always emit `required` (even `[]`)
- special-case `{}` → `{type:"object", required:[], additionalProperties:false}`
  and `{...}` → `{type:"object"}`

### 3.4 Tuples & rest

`[ t1, t2, ..., ...T[] ]`:

- `prefixItems` = fixed element schemas
- trailing `...T[]` ⇒ `items: <T>`, `minItems: prefixItems.length` (so
  `[string, ...number[]]` → `minItems: 1`, one prefix element)
- no rest ⇒ `items: false`, `minItems: prefixItems.length`
- never emit `maxItems`

### 3.5 Function types

`( t1, t2, ...Trest[] ) -> ret`:

- `params` = fixed schemas
- optional trailing `...T[]` ⇒ `rest: <T>` (unwrap one `[]`)
- `returns` = `parseType()` (full precedence — grabs a trailing union)
- emit `{$fnType: {params, rest?, returns}}`

---

## 4. Main parser integration (`typescript/src/shorthand/parser.ts`)

### 4.1 `parseModule` for the top-level object

`parse()` currently does `parseExpr()` then `expect eof`. Change: if the first
significant token is `{`, route the outermost object through a new `parseModule`
(a superset of `parseDataObject`); otherwise behave exactly as today (a bare
top-level expression admits no `type` decls).

`parseModule`:

- like `parseDataObject`, but at each entry, if `peek()` is `ident "type"` **and**
  the next token is an `ident` (the type name), parse `type Name "=" <type>` via
  `TypeParser` and stash into a `types: Record<string, Schema>` map; otherwise
  parse an ordinary `dataEntry` (binding/constant/pun) exactly as
  `parseDataObject` does today.
- **Disambiguation:** `type :` (data key) and `type ,`/`type }` (pun) stay
  data entries — only `type <ident>` is a declaration. This is a 2-token
  lookahead at entry start.
- after the object closes, if `types` is non-empty, set `result.$types = types`
  as the **first** key (or wherever canonical ordering wants it; see printer).

Reuse: factor the shared entry-loop body so `parseModule` and `parseDataObject`
don't duplicate the comma/brace handling.

### 4.2 Param annotations (`parseParams`)

After reading each param slot (ident / `...ident` / field pattern), if the next
token is `colon`, consume it and `TypeParser.parseType()` for that slot's schema.
Track schemas alongside the `Param[]`:

- ordinary `name: T` → schema `T` at that position
- `...name: T[]` → **rest**; unwrap one `[]` → `rest` element schema
- `{a, b}: T` → schema `T` (the object type) at that position

Enforce **all-or-nothing** *after* the list is parsed (see §4.4). Return both the
`Param[]` (unchanged shape for `$params`) and a parallel `paramSchemas` /
`restSchema` (or `null` if unannotated).

### 4.3 Return type & `$sig` assembly (`parseFuncLit`)

After `parseParams`, before `expect("fatarrow")`: if `peekType() === "arrow"`,
consume `->` and `TypeParser.parseType()` for the return schema.

Then in `buildScope` (or a new `buildTypedScope`), when a signature is present,
prepend a `$sig` key:

```
$sig = { params: paramSchemas, ...(restSchema ? {rest: restSchema} : {}), returns }
```

`$sig.params` is positional and aligned with `$params`. A rest param contributes
`rest` (not a `params` entry). Object-pattern params contribute their object
schema as the positional `params` entry.

### 4.4 All-or-nothing + return-required enforcement (parser)

Within a single funcLit:

- **fully typed** ⇔ every non-rest param annotated AND a `->` return present
- **bare** ⇔ no param annotated AND no `->`
- anything else ⇒ `err(...)`:
  - some params typed, some not → "all parameters must be typed, or none"
  - typed params but no `-> Ret` → "a typed function must declare a return type"
  - `->` but an unannotated param → same "all parameters must be typed"

This makes rule 5 (all params typed) and mandatory-return local, syntactic, and
well-located. It does **not** enforce "module-level functions must be typed" —
that needs the module context and is better as a checker lint (§9).

---

## 5. `Param` / type-plumbing (`typescript/src/types.ts`)

`$params` slots are unchanged (`string | {$fields}`). The signature rides in the
separate `$sig` key, so no change to `Param`. Add a `Schema` alias import where
convenient, or keep schemas as `JSONType` (they already are). Confirm `$sig` is
excluded from binding-key logic on the runtime side (the checker already treats
`$sig` specially in `context.ts` `bindingKeys`; verify the evaluator's
`buildScope` also ignores it — per the sketch §3.1 it should be masked like
`$comment`, a small, separate change if not already done).

---

## 6. Printer (`typescript/src/shorthand/printer.ts`)

The bijective-by-normal-form guarantee (`parse(print(x)) === x`) must extend to
`$types` and `$sig`. Add:

### 6.1 Type-expression printer

Inverse of §3, emitting canonical surface for each schema kind:

- primitives/`true`/`false` → keyword; `{const}` → literal; `{type:"null"}` →
  `null`
- `{enum}` → `a | b | c` (values as literals); `{type:[...]}` → `A | B`;
  `{anyOf}` → arms joined by `|` (re-expanding merged enum/type-array arms)
- arrays → `Inner[]`; tuples → `[a, b]` / `[a, ...T[]]`; objects → `{k: T, k?: U,
  ...}` / map / `{}` / `{...}`
- refinements → `Base & kw(arg)` in matrix order
- `{$ref}` → the bare name
- `{$fnType}` → `(A, B) -> R`, parenthesizing when used as a union arm / array
  element / nested return where re-parse would re-associate (a small precedence
  ladder for types, analogous to the term one)

This is the fiddliest piece — it owns the canonical spelling choices (which union
form, refinement ordering, when to parenthesize a fn type). Budget accordingly.

### 6.2 Module `$types` block

When printing the top-level object, emit `$types` entries as `type Name = <type>`
lines (canonical ordering + newline/indent like `where`), then the bindings. Drop
the `$types` key from the ordinary data-object rendering path.

### 6.3 `$sig` on function bodies

In `renderFunctionBody`, when a `$sig` is present, render the header as
`(p1: T1, p2: T2) -> Ret =>` by pairing `$sig.params`/`$sig.rest` with `$params`
(including `{$fields}` patterns → `({ a, b }: T)`), and drop `$sig` from the body
key rendering. Bare bodies print exactly as today.

---

## 7. Errors (`typescript/src/shorthand/error.ts`)

Reuse `ParseError` with line/col from the cursor. New messages: refinement/base
mismatch (`"min(...) is not valid on string"`), partial signature, missing return
type, malformed object/tuple/fn type, `type` decl outside the module object
(if detectable), bad refinement arg type.

---

## 8. Tests

- **Spec parse-cases:** add `spec/parse-cases/types.json` (type-expression
  lowering: primitives, unions/cascade, arrays/tuples, objects/optional/map,
  refinements + invalid combos as `error: true`, fn types, `$ref`) and
  `spec/parse-cases/signatures.json` (param/return annotations, rest,
  object-pattern, all-or-nothing errors) and extend `program.json` with a
  `type`-declaration module. These run against every implementation but only TS
  is expected to pass (per `AGENTS.md`).
- **Round-trip:** `parse(print(x)) === x` over the new cases; add a printer
  fixture set. This is where union-canonicalization and fn-type parenthesization
  bugs surface.
- **Retype an example:** port `examples/calendar.jfn` (destructured params!) and
  a slice of `examples/chess.jfn` to typed form as an end-to-end fixture, then
  run it through `checkModule` to confirm the emitted `$types`/`$sig` type-check
  clean.
- Keep the extracted-cursor refactor (§2) green against the existing parser suite
  before adding any type logic.

---

## 9. Checker-side enforcement (small, separate)

Not parser work, but needed for the "module functions must be typed" rule:
`checkModule` (`typescript/src/check/module.ts`) should emit a diagnostic when a
**top-level** binding `isBody(val)` but `sigOf(val) === null`. Nested bodies stay
tolerant (degrade to `any`) as they do now. One-line-ish addition to the existing
loop; gate behind a flag if we want a soft rollout.

---

## 10. Sequencing

1. **Lexer tokens** (`pipe`, `question`) + tests — tiny, isolated.
2. **Cursor extraction** (§2) — pure refactor; existing suite stays green.
3. **TypeParser** (§3) with `spec/parse-cases/types.json` — the bulk of the
   grammar, testable in isolation via a temporary `parseType` entry.
4. **Signature integration** (§4) + `signatures.json`.
5. **`parseModule`** + `type` declarations (§4.1) + `program.json` cases.
6. **Printer** (§6) + round-trip fixtures — do after parsing is solid so
   round-trip tests are meaningful.
7. **Checker enforcement** (§9) + retyped-example end-to-end.

Milestones 3–5 are the core; 1–2 unblock them; 6 restores the bijection; 7 wires
it to the existing checker.

---

## 11. Risks / watch-items

- **Union canonicalization** is the highest-bug-density area (three-rule cascade +
  its printer inverse). Test it hard, including mixed literal/primitive/named
  arms and `null` handling.
- **`(` disambiguation** in type position (grouping vs fn type) needs the same
  care as `looksLikeFuncLit`; a bad lookahead silently mis-parses.
- **Rest `[]` unwrap** in both params and fn types — off-by-one in array nesting
  is easy (`...T[]` → `rest: T`, but `...T[][]` → `rest: T[]`).
- **`$sig`/`$types` evaluator inertness** — confirm the evaluator ignores them
  (masked like `$comment`); otherwise a typed module changes runtime behavior.
  Per the sketch this is a small, known change if not already present.
- **Printer parenthesization** for nested function types is the subtle
  round-trip failure mode; cover `((A)->B)|null`, `((A)->B)[]`, `(A)->(B)->C`.
```
