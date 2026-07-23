# Typechecker findings

Notes from an exploratory pass over the type system through the `jfn check`
CLI, after wiring `check` to parse `.jfn` shorthand (so the pipeline is
`parse -> lower -> check` in one step, `--json` to feed canonical JSON, `--expr`
for a single expression). Line references are to `typescript/` at time of
writing.

Context: nearly the whole stdlib now has signatures in `spec/builtins.json`
(arithmetic/comparison/logic, `isX`, the string and regex families, and the full
array/object suite — `map`/`filter`/`reduce`/`find`/`sort`/`groupBy`/`flatMap`,
`keys`/`values`/`entries`/`fromEntries`/`merge`/`pick`/`omit`, etc.). The only
builtins still without a real signature are the escape-hatch `{ "rule": … }` ops
— `apply`, `pipe`, and the effect kernel (`perform`/`pure`/`bind`/`raise`/`handle`)
— which carry loose data floors (`RULE_FLOORS`) rather than full types.

## Fix classes (triage)

Remaining findings fall into two buckets, roughly by effort:

- **(C) Extend narrowing coverage** — `match` narrowing, `where`-local
  narrowing, nested-access narrowing, the `x!` assertion (doesn't parse yet).
- **(D) Needs a real type-system feature (defer)** — user-facing generics /
  `Task<A>`, effect rows, `pipe`/`apply`'s variadic fold.

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

### An undefined type reference silently resolves to top

A `$ref` to a type that was never declared (a typo'd or missing alias) resolves
to top rather than erroring, so an annotation like `-> Report` when no
`type Report` exists accepts *any* value — `true` included. It's the same
`refsToTop`/dangling-ref rule that (intentionally) makes `type X = any` usable as
top, seen from the other side: a misspelled return/parameter type silently
becomes an escape hatch. A defined-but-wrong annotation (`-> State`) still
rejects correctly; only the *undefined* name leaks. A "reference to undeclared
type" diagnostic would close the footgun. (This bit during the cousin tightening:
`runScript -> Report` looked like it type-checked until `Report` was actually
declared, at which point it failed like the goal.)

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

---

## Gaps surfaced by `examples/typed/ledger.jfn`

`examples/typed/ledger.jfn` is a reference program that **evaluates correctly**
(`jfn eval --entry demo`) but does not yet pass `jfn check` (29 diagnostics: 12
errors, 17 warnings). It was written to use the type syntax the natural way;
each diagnostic below is the checker rejecting a sound program. The
already-checkable cousin is `examples/typed/pipeline.jfn`. Repros verified through
`jfn check`.

### Object-producing builtins erase the map value type (`fromEntries`, …)

```jfn
{ type M = { [string]: integer },
  f: (id: string, n: integer) -> M => fromEntries([[id, n]]) }
// ERR: {"type":"object"} is not assignable to {"$ref":"#/$defs/M"}
```

`fromEntries` (and the object-building cousins) return bare `{"type":"object"}`,
so a map-typed return (`{ [string]: T }`) is never satisfied — the value type is
gone. This blocks `ledger.jfn`'s
`merge(books.ledger, fromEntries([[id, acct]]))` line: structural `merge` now
preserves the map through the merge, but the `fromEntries` operand is already a
bare object, so the map's `Account` value type is lost before `merge` sees it. A
polymorphic signature (`fromEntries : ([string, V][]) -> { [string]: V }`) would
recover it — the same type-variable machinery the array builtins already use,
just projecting the pair's second element into `additionalProperties`. A
signature-precision job, not a structural-op one.

### `match` doesn't narrow a discriminated union (`if` / `cond` do)

```jfn
type E = { tag: "lit", v: number } | { tag: "bin", l: number, r: number }

match e.tag { "lit" -> e.v, else -> e.l }    // WARN: e.v / e.l : number | null
cond { e.tag == "lit" -> e.v, else -> e.l }  // OK — narrows
if e.tag == "lit" then e.v else e.l          // OK — narrows
```

`$match` doesn't narrow its subject (`e`) the way `if`/`cond`'s
`factsFromCondition` does for an equality-on-a-path condition, so the most
natural tagged-dispatch — `match subject.tag { … }` — leaves `e.v`/`e.l` as
`number | null` (a `warning` against the declared `number`) instead of the
fully-narrowed `number`. Matching a case value should narrow the subject to the
variant(s) carrying that discriminant.

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

## Gaps surfaced by `examples/typed/thermostat.jfn`

Resolved by the portable contract migration. The operator now owns the domain
types, effect contracts, and `loop` entry contract in
`examples/thermostat.contract.json`; the guest uses qualified effect calls so
manifest result types flow through `bind`. The former
`thermostat-checked.jfn` workaround was removed.

The example checks with zero errors against its contract. Its in-language
`runScript` demo still reports information-level coverage degradations for bare
handler-clause lambdas; those do not affect the typed host entry path.
