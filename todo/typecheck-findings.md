# Typechecker findings

Notes from an exploratory pass over the type system through the `jfn check`
CLI, after wiring `check` to parse `.jfn` shorthand (so the pipeline is
`parse -> lower -> check` in one step, `--json` to feed canonical JSON, `--expr`
for a single expression). These are observations, **not** yet triaged fixes.
Line references are to `typescript/` at time of writing.

Context: only the builtins in `spec/builtins.json` have signatures today
(arithmetic, comparisons, `not`/`and`/`or`, `isX`, `str`/`upper`/`lower`/`trim`,
`length`, `head`, `concat`, `setAt`, `map`, `filter`, `reMatch`, `pipe (rule stub)`). Things like `reduce` are absent, so anything using them degrades to
`any` — out of scope here.

## Fix classes (triage)

Each finding below falls into one of four buckets, roughly by effort:

- **(A) Tighten a loose data signature** — `merge` erasing records; the
  escape-hatch floors (`pipe`/`apply`/effects). Data-only, no engine change.
  _Escape-hatch floors: **done** (see resolved note below). `merge` remains._
- **(B) Add a bounded type-level op to the engine** — computed-index projection,
  shared-field-off-union projection, structural `merge`, `$ref`-to-top. No
  recursion; each is a small, closed operation every impl must mirror.
- **(C) Extend narrowing coverage** — `match` narrowing, `where`-local
  narrowing, nested-access narrowing, the `x!` assertion (doesn't parse yet).
- **(D) Needs a real type-system feature (defer)** — user-facing generics /
  `Task<A>`, effect rows, `pipe`/`apply`'s variadic fold.

Note: escape-hatch soundness and the effect-kernel section share one root  
(builtins that punt to `any`). Bucket (B) items also share one root — the  
engine can't yet _compute_ a projected/combined type — so they're likely one  
piece of work, not four.

## Soundness gaps

### Escape-hatch builtins return `any` and check nothing

> **Resolved.** Each `{ rule }` builtin now carries a loose data floor
> (`RULE_FLOORS` in `builtin-rules.ts`): fixed arity, a pinned result type, and
> select argument shapes. Wrong-arity/wrong-shape calls are caught
> (`pipe([])` → arity error; `pipe(5, …)` → `$args[0]` shape error), the effect
> ops return the opaque `Task` node (`$defs/Task` in `spec/builtins.json`), and
> `any`-typed args stay exempt from shape checks. A per-impl code rule can still
> layer precision on top. See `docs/builtin-signatures.md` § "Recommended floors".

Builtins registered as `{ "rule": "<name>" }` in `spec/builtins.json` —
`pipe`, `apply`, and the effect ops (`perform`/`pure`/`bind`/`raise`/`handle`)
— hit `synthBuiltinCall`'s non-array branch (`builtin-rules.ts`), which returns
`true` (`any`) after only walking args for _nested_ errors. The `rule` name is
inert: no per-impl code handler was ever written, so there's no result type
_and_ no arity/shape checking. `pipe()`, `apply()`, `pipe(1,2,3,4,5)` all pass.

Note `pipe`'s real signature is `pipe(fns, init)` (function array first); the
escape hatch means even a wrong-arity/wrong-shape call like
`pipe(5, (n) => n + 1)` is accepted (and it doesn't even evaluate at runtime —
`pipe` wants an array of functions). Minimal fix: give each a _loose data
floor_ (arity + "arg 0 is an array of functions" for `pipe`; nominal `Task`
return for the effect ops) so checking never silently vanishes, then layer a
code rule for precision. This is the same root as "The effect kernel is
untyped" below.

### Computed index access isn't integer-checked

`arr[i]` (a language-level `$get` with a computed numeric key) is projected
structurally without requiring the index to be an `integer`, so
`arr[2.5]`-style access isn't rejected. The integer-demanding _builtin_
positions (e.g. `setAt`'s index, the `+`/`/` overloads) already declare
`integer` in `spec/builtins.json` and _are_ checked; the gap is only the
language-level `$get` path. Closing this makes indexing fully covered, which is
the main thing the `integer`/`number` distinction buys us (whole-vs-fractional
values are otherwise interchangeable — `2.0` correctly folds to `integer`, and
that's a sound subtyping choice, not a bug).

> Superseded by "Computed index access degrades to `any`" below — the index
> isn't structurally projected at all today, so the missing integer-check is
> moot until value projection lands.

## Diagnostics / ergonomics

### Overloaded-builtin failures only report the first overload

`length(123)` complains it isn't an `array`, never mentioning the `string`
overload it also failed.

### Object assignability errors don't pinpoint the field

Extra- and missing-field cases (`mk` returning an object with an extra `extra`
field, or missing a required field) dump both full schemas as
`X is not assignable to {"$ref":"#/$defs/User"}` and leave the reader to diff.

### Missing-field access returns `null` silently

Reading a field not declared on a closed object type (`u.name` where `name`
isn't in the type) yields `null` with no error. Could mask typos.

## Language / parse quirks

### A malformed typed-lambda return annotation reports a misleading error

```
$ jfn to-json '(x: integer) -> (integer -> string) => y'
parse error at 1:3: expected ')', found 'colon'
```

The real mistake is the return type: a function type wraps its _parameter list_
in parens (`(integer) -> string`), so this should be
`-> ((integer) -> string)`. But the error points at the `:` in the parameter
list (column 3), nowhere near the actual problem. Cause: `looksLikeFuncLit`
gates the lambda interpretation on `returnTypeEndsInFatArrow`, which does a
throwaway type-parse of the return annotation inside a `try { … } catch { return false }` (`parser.ts`). The malformed return type throws, the `catch` swallows
it, so the whole `( … )` is no longer seen as a lambda header and falls through
to the grouping-paren branch — which then fails at the first token an expression
can't accept (the `:`). Surfacing the discarded type-parse error (or noting the
`->`-without-a-valid-return-type shape) would point at the real fault.

### `where` only parses in function-body return position

`x + 1 where { x: 5 }` fails at top level (through `check`, `to-json`, and
`eval`), but `(doubled + 1) where { doubled: n * 2 }` works as a function
body's return expression (and its bindings _are_ type-checked). The `let ... in`
removal error explicitly recommends `expr where { ... }`, which then doesn't
parse standalone — misleading message.

## Cosmetic (type rendering)

- `head([])` renders the element as `false` (i.e. `never`): `anyOf[false, null]`.
- Nested `anyOf`s aren't flattened (`head([1,2,3])` nests a union inside a union).
- Literal unions aren't widened (`if ... then 10 else 20 : anyOf[const 10, const 20]`).

## Design note (not a bug)

Refinements are opaque: `s + 1` (an `integer`) is not assignable to
`Score = integer & min(0) & max(100)`, and there's no narrowing/refinement path
to produce a refined value. Expected given the model, but flagged for whenever
refinement UX comes up.

### `if` condition is truthiness-based, not boolean (precision, not soundness)

Originally filed as a soundness gap ("`if 1 then 10 else 20` type-checks; the
condition type is unchecked"). But `$if` is defined to branch on _truthiness_
(`docs/language.md`: "`$if` is evaluated; if truthy, `$then` … otherwise
`$else`"), exactly like `$and`/`$or`. So `1` is a legitimate condition and
`if 1 then 10 else 20 : 10` was already sound — requiring a `boolean` condition
would be wrong (it'd break `if x then … else default`-style truthiness checks).

The precision win here is the `$if` analogue of the `$and`/`$or` fix below:
narrow the condition _value_ by its own truthiness inside each branch. A bare
value / access-path condition now contributes its truthy slice to the
then-branch and its falsy slice to the else-branch, via the same
`restrictToTruthy`/`restrictToFalsy` helpers (new `truthinessFact` in
`narrowing.ts`, applied through `factsFromCondition`, so `$cond` arms get it
too). So `if x then x else "d"` with `x: string | null` is now `string | "d"`
(null dropped in `then`), matching `x || "d"`. Predicate/comparison/discriminant
narrowing (`if isNumber(x) …`) is unchanged. Purely a precision improvement.

Still open (cosmetic, tracked under "Cosmetic" above): literal-union branch
results aren't widened (`if … then 10 else 20 : anyOf[const 10, const 20]`).

### `&&` / `||` are value-returning, not boolean (precision, not soundness)

Originally filed as a soundness gap ("not boolean-checked"), but `&&`/`||` lower
to the `$and`/`$or` special forms, which the spec defines as value-returning
short-circuit operators (`$and` → first falsy or last; `$or` → first truthy or
last), deliberately _not_ the eager boolean stdlib `and`/`or`. So requiring
boolean operands (would break the `x || default` idiom) or a boolean result
would both be wrong, and `1 && 2 : 2` was already sound. The result rule now
narrows each non-final operand to the slice that can stop the chain — falsy for
`$and`, truthy for `$or` — so `(x: string | null) || d : string | typeof d`,
`1 && 2 : 2`, and `true && false : false`. Purely a precision improvement.

---

## Gaps surfaced by `examples/ledger.jfn`

`examples/ledger.jfn` is a reference program that **evaluates correctly**
(`jfn eval --entry demo`) but does not yet pass `jfn check` (32 errors). It was
written to use the type syntax the natural way; each error below is the checker
rejecting a sound program. The already-checkable cousin is
`examples/pipeline.jfn`. Repros verified through `jfn check`.

### Computed index access degrades to `any` (arrays _and_ maps)

Static keys project the element/field type; any **computed** key falls to `any`:

```jfn
{ f: (xs: integer[]) -> integer => xs[0] }                                  // OK  : integer
{ f: (xs: integer[], i: integer) -> integer => xs[i] }                      // ERR : true (any)
{ type M = { [string]: integer }, get: (m: M, k: string) -> integer => m[k] } // ERR : true (any)
```

Both the array `items` schema and the map `additionalProperties` schema are in
hand and should flow through a computed `$get`. This **sharpens/corrects the
"Computed index access isn't integer-checked" note above**, which asserts
`arr[i]` "is projected structurally" — today it isn't projected at all, it
degrades to `any` (so the missing `integer`-check on the index is moot until the
value projection lands).

### `merge` erases the record type

```jfn
{ type A = { id: string, n: integer }, upd: (a: A) -> A => merge(a, { n: a.n + 1 }) }
// ERR: {"type":"object"} is not assignable to {"$ref":"#/$defs/A"}
```

`merge`'s signature returns bare `{"type":"object"}`, so the copy-with-one-field
-changed idiom (pervasive in pure state updates) can never satisfy a declared
record return type. A structural merge of two object schemas (union of
properties, RHS wins, at least for a literal RHS) would recover it.

### `match` doesn't narrow a discriminated union (`if` / `cond` do)

```jfn
type E = { tag: "lit", v: number } | { tag: "bin", l: number, r: number }

match e.tag { "lit" -> e.v, else -> e.l }    // ERR: e.v / e.l are any
cond { e.tag == "lit" -> e.v, else -> e.l }  // OK — narrows
if e.tag == "lit" then e.v else e.l          // OK — narrows
```

The discriminated-union narrowing listed under "What landed well" fires for
`if`/`cond` but not `$match`, so the most natural tagged-dispatch — `match subject.tag { … }` — degrades every arm's variant-specific fields to `any`.
Matching a case value should narrow the subject to the variant(s) carrying that
discriminant.

### Flow narrowing doesn't reach `where`-locals

```jfn
{ g: (b: boolean) -> (integer | null) => if b then 1 else null,
  f: () -> integer => if h then h else 0 where { h: g(true) } }
// ERR: h is not narrowed to integer

{ f: (h: integer | null) -> integer => if h then h else 0 }          // OK (param)
{ f: (h: integer | null) -> integer => if isNull(h) then 0 else h }  // OK (param)
```

Narrowing (truthiness, `isNull`, and field access on a narrowed `A | null`) all
work on **parameters** but not on `where`-locals bound to the same union. Since
compute-then-branch (`x: <expr>` in `where`, then guard `x`) is the idiomatic
shape, this blocks most real null handling. The `x!` assertion escape hatch
(type spec §9) doesn't parse yet either (`head(xs)!` → parse error), so there is
currently no way to discharge the union at all in a local.

### Callback arity is rigid for named/curried function values

```jfn
{ f: (xs: integer[]) -> integer[] => map(g, xs),
  g: (x: integer) -> integer => x + 1 }
// ERR: (integer)->integer not assignable to (T, integer)->U

{ f: (xs: integer[]) -> integer[] => map((x) => g(x), xs), g: ... }  // OK
```

A bare or curried function _value_ must match the builtin callback's exact arity
(`map`/`filter`/`every`/`find` pass an index; `reduce` passes acc+item+index), so
`map(g, xs)`, `reduce(apply, init, txs)`, and `every(guard(floor), …)` are all
rejected while the identical inline-lambda wrapper is accepted. At runtime extra
args are ignored, so a shorter-arity callback should be assignable (a function is
contravariant in — here, tolerant of — ignored trailing params), matching the
leniency inline lambdas already get.

---

## Gaps surfaced by `examples/thermostat.jfn`

`examples/thermostat.jfn` is a reference program in the same spirit as
`ledger.jfn`, but exercising the **effect kernel**: a typed `Device` capability
record, an `Action`/`Fault` discriminated union, and `-> Task` on every
effectful function, over a `do`-notation loop (`perform`/`bind`/`pure`/`raise`)
run in-language by a threaded-state `handle`. It **evaluates correctly**
(`jfn eval --entry demo`) but does not yet pass `jfn check` (8 errors, 1
warning). The already-checkable cousin is `examples/thermostat-checked.jfn`
(byte-identical output). Repros verified through `jfn check`.

Two of its errors are the `match` **doesn't narrow** gap already filed under
`ledger.jfn` (here on `describe`/`actuate`, where `match act.tag { … }` leaves
`act.to` / `act.fault` as `any`); the rest are new and specific to typing over
the effect kernel.

### The effect kernel is untyped, so `-> Task` can't be expressed

> **Resolved** (via the escape-hatch floors above). `perform`/`pure`/`bind`/`raise`
> now return `$defs/Task` (the opaque tagged-record node), so an effectful
> function can carry a `-> Task` / `-> any` return. Both repros below now check
> clean: `{ type Task = any, f: () -> Task => perform("e", []) }` and the same
> with the structural `{ "@task": string }` record. `handle` still returns `any`
> (its result type is genuinely caller-dependent). The capability-record shape
> (`Device.read : () -> Task`) still needs the shared-field-off-union projection
> filed separately below to type the record's fields precisely.

The kernel builtins (`perform`, `pure`, `bind`, `raise`, `handle`) have no
signatures, so every task expression is `any` (`true`). The bare `any` keyword
absorbs that fine, but there is no way to give an effectful function a named
`Task` return type — every `-> Task`/`-> Device`/`-> Report` annotation in the
goal file is rejected:

```jfn
{ f: (x: integer) -> any => perform("e", []) }              // OK  (bare any absorbs the task)
{ type Task = any, f: () -> Task => perform("e", []) }      // ERR : true not assignable to $ref Task
{ dev: () -> Device => { read: () => perform("s", []), … } } // ERR : bare-lambda field is `true`, not (…) -> Task
```

Until tasks carry a type (even an opaque, un-parameterized `Task`), the effect
boundary can only be typed as the bare `any` keyword, which erases the
capability-record shape a `Device`/`Api` type is meant to document.

### A `$ref` to an `any` alias isn't treated as top

> **Resolved.** `subsumes` (`subsumption.ts`) now peels a `$ref` chain on the
> `sup` side when `sub` is top: `any ⊆ $ref` holds iff the alias bottoms out at
> `true` (`refsToTop`, with a cycle guard; a dangling ref resolves to top too).
> So `{ type T = any, f: (x: integer) -> T => apply(...) }` — a bare-`any` value
> against a named `any` alias — now checks clean, while `type T = integer`
> correctly still rejects it. This is the general fix; the effect ops above no
> longer rely only on their `$ref`-result workaround.

Sharpening the item above: `any` **works inline** but **not through a named
alias**. `type Task = any` lowers to `true`, yet a `$ref` to it is not
recognized as top, so an `any`-valued expression fails to satisfy it:

```jfn
{ f: (x: integer) -> any => perform("e", []) }               // OK
{ type T = any, f: (x: integer) -> T => perform("e", []) }   // ERR : true not assignable to $ref T
```

Dereferencing a `$ref` whose target is `true` (or short-circuiting
assignability when the _target_ resolves to top) would make `type Task = any`
usable as the documented effect-boundary alias.

This is the cheapest fix in this doc and a prerequisite for the opaque-`Task`
boundary: making a `$ref`-to-top transparent lets `type Task = any` work as the
documented effect-boundary alias with zero new machinery.

### Reading a shared field off a union degrades to `any`

Projecting a field that every arm of a union declares — including the very
discriminant used to narrow — yields `any` instead of the union of the field's
types across arms:

```jfn
{ type F = { tag: "a", n: integer } | { tag: "b" },
  g: (x: F) -> string => x.tag }                             // ERR : true (any), want "a" | "b"
```

Narrowing doesn't rescue it either — inside a `cond`/`if` arm, a nested access
like `w.f.tag` (where `w.f : F`) is still `any`. This is why the checkable
cousin needs a `faultTag: (f: Fault) -> string` helper that discriminates with a
`cond` over `f.tag` (reading `.tag` as a _condition_ is fine — that's how
narrowing works) rather than using `f.tag` as a _value_. A union-typed value
should project a shared field to the join of that field across its arms (and the
common discriminant to its literal union).
