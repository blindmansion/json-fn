# `$let` Phase 3: parser, printer, and canonical cutover

This document expands Phase 3 of `plans/active/let.md` into an implementation
plan for the canonical TypeScript shorthand layer.

Phase 3 changes every shorthand-produced local binding to canonical
`{ "$let": ..., "$in": ... }`. Function bodies become structural, expression
`where` stops lowering through a zero-argument call, and pure `do` bindings use
the same `$let` node. The printer performs the inverse transformation and no
longer recognizes either historical binding encoding.

The evaluator and checker support required by this phase was established in
Phases 1 and 2. Phase 3 is therefore a representation cutover, not another
binding-semantics implementation.

## Deliverable

At the end of Phase 3:

- every shorthand `expr where { ... }` lowers directly to `$let`/`$in`;
- a function-body `where` is represented inside the structural `$return`, not
  by sibling keys on the function body;
- every pure binding introduced by `do` desugaring is represented by `$let`,
  including leading pures and pures following an effect or discard;
- no parser path emits a binding-shaped zero-argument IIFE;
- no parser path emits an arbitrary local key on a function body;
- the printer renders a canonical `$let` as `expr where { ... }`;
- a `$let` in `$return` prints as the ordinary function-body `where` surface;
- `do` reconstruction recognizes `$let`-wrapped pure runs and no historical
  IIFE or inline-local shape;
- evaluator-produced `$captures` cause a clear printer error rather than being
  dropped, exposed as source, or mistaken for a local;
- shorthand-side function classification accepts only structural function
  fields;
- focused parser, printer, round-trip, evaluator, checker, and CLI tests use the
  new canonical shapes;
- directly affected parse-case expectations use `$let`.

The architectural result is one bidirectional mapping:

```text
expr where { name: value }
              ⇅
{ "$let": { "name": value }, "$in": expr }
```

Function `where` and pure `do` bindings are applications of that mapping, not
separate canonical forms.

## Non-goals

Do not include the following work in Phase 3:

- changing lazy, memoized, recursive, or cycle-detection semantics;
- changing closure substitution or `$captures` attachment;
- changing checker narrowing or type-scope behavior;
- adding authoring syntax for `$captures`;
- adding binding annotations;
- changing `where` precedence or its allowed source positions;
- changing the `do` effect model, `bind` signature, or continuation semantics;
- bulk-migrating all canonical fixtures under `spec/cases/`;
- updating the public language reference in `docs/`;
- retaining a compatibility printer for historical canonical forms;
- adding a product migration command;
- porting Go, Python, or Rust.

Phase 4 owns the broad canonical fixture migration, deletion of transitional
evaluator/checker adapters, and public documentation update.

## Cutover invariants

Preserve these invariants throughout the shorthand refactor:

1. A non-empty `where` clause produces exactly one `$let` node.
2. The key order of a `where` binding block is preserved in the `$let` map and
   when printed again.
3. Every binding in one `where` block shares one recursive scope.
4. A binding value containing its own trailing `where` receives a nested
   `$let`; its inner names do not become siblings of the outer block.
5. Function parameters remain structural `$params`, signatures remain
   structural `$sig`, and local bindings occur only under `$return`.
6. A function-body `where` scopes over the entire parsed return expression,
   preserving the existing low precedence of `where`.
7. An expression-level `where` creates no `$call`, `$args`, function body,
   parameter scope, call-depth increment, or call-shaped fuel charge.
8. Consecutive pure `do` bindings form one recursive `$let` map in source
   order.
9. Pure `do` bindings before the first effect scope over the entire generated
   bind chain.
10. Pure `do` bindings after an effect or discard scope over the remainder of
    that continuation.
11. Effect bindings and discards still lower to `bind(value, continuation)`.
12. Continuation functions contain only structural function fields.
13. `parse(print(node))` reproduces printable canonical `$let` JSON exactly.
14. Printing never silently discards `$captures`.
15. Printing never treats a stray function-body key as a local binding.
16. `$raw` remains opaque; data inside a raw island is not interpreted as a
    function, `$let`, or capture registry.
17. A genuine user-authored zero-argument IIFE remains a genuine call and
    prints as a call.
18. The module root remains a named registry and is never wrapped in `$let`.

## Canonical lowering rules

### Expression-level `where`

Lower:

```jfn
double(n) where {
  double: (x) => x * 2
}
```

to:

```json
{
  "$let": {
    "double": {
      "$params": ["x"],
      "$return": {
        "$call": "mul",
        "$args": [{ "$var": "x" }, 2]
      }
    }
  },
  "$in": {
    "$call": "double",
    "$args": [{ "$var": "n" }]
  }
}
```

Do not retain the old:

```json
{
  "$call": {
    "double": { "...": "..." },
    "$return": { "...": "..." }
  },
  "$args": []
}
```

`parseBody` should remain the source-precedence boundary that recognizes a
trailing clause. Its lowering becomes direct:

```ts
return {
  $let: Object.fromEntries(bindings),
  $in: expression,
};
```

Use a small constructor such as `buildLet(bindings, result)` rather than
repeating object assembly in `parseBody`, function parsing, and `do`
desugaring. The constructor should:

- require at least one binding;
- preserve binding insertion order;
- return the exact two-key node;
- never fabricate a function or call.

The canonical evaluator rejects an empty `$let`, so `where {}` must become a
parse error. The parser must not emit a node it knows is invalid.

### Function-body `where`

Lower:

```jfn
(x, y) => doubled where {
  sum: x + y,
  doubled: sum * 2
}
```

to:

```json
{
  "$params": ["x", "y"],
  "$return": {
    "$let": {
      "sum": {
        "$call": "add",
        "$args": [{ "$var": "x" }, { "$var": "y" }]
      },
      "doubled": {
        "$call": "mul",
        "$args": [{ "$var": "sum" }, 2]
      }
    },
    "$in": { "$var": "doubled" }
  }
}
```

`parseFuncLit` should parse its return expression and optional `where` exactly
as today, then place either:

- the plain return expression, when there is no `where`; or
- `buildLet(locals, returnExpression)`, when there is one;

under `$return`.

Replace the current `buildScope(params, locals, ret, sig)` with a structural
function-body constructor equivalent to:

```ts
buildFunctionBody(
  params: Param[],
  result: JSONType,
  sig: Schema | null,
): FunctionBody
```

It may emit only `$sig`, `$params`, and `$return`, in the existing stable
property order. It must not accept a locals argument.

This separation is important: a function constructor constructs a function;
the `$let` constructor constructs a binding expression. Neither API should be
capable of recreating the old mixed scope object.

### Nested `where`

Binding values continue to use `parseBody`, so:

```jfn
total where {
  total: sq(n) where {
    sq: (x) => x * x
  }
}
```

becomes:

```json
{
  "$let": {
    "total": {
      "$let": {
        "sq": {
          "$params": ["x"],
          "$return": {
            "$call": "mul",
            "$args": [{ "$var": "x" }, { "$var": "x" }]
          }
        }
      },
      "$in": {
        "$call": "sq",
        "$args": [{ "$var": "n" }]
      }
    }
  },
  "$in": { "$var": "total" }
}
```

Do not flatten nested lets. Flattening changes shadowing and recursive scope
boundaries even when the printed source looks similar.

### Pure `do` bindings

Keep the existing `DoEntry` parse model. Change only the lowering target for
pure runs.

Leading pures:

```jfn
do {
  x: 1,
  y <- eff(),
  pure(x + y)
}
```

lower to:

```json
{
  "$let": {
    "x": 1
  },
  "$in": {
    "$call": "bind",
    "$args": [
      { "$call": "eff", "$args": [] },
      {
        "$params": ["y"],
        "$return": {
          "$call": "pure",
          "$args": [
            {
              "$call": "add",
              "$args": [{ "$var": "x" }, { "$var": "y" }]
            }
          ]
        }
      }
    ]
  }
}
```

Pures following an effect:

```jfn
do {
  name <- readLine(),
  loud: upper(name),
  print(loud),
  pure(loud)
}
```

lower to a structural continuation whose `$return` is a `$let`:

```json
{
  "$call": "bind",
  "$args": [
    { "$call": "readLine", "$args": [] },
    {
      "$params": ["name"],
      "$return": {
        "$let": {
          "loud": {
            "$call": "upper",
            "$args": [{ "$var": "name" }]
          }
        },
        "$in": {
          "$call": "bind",
          "$args": [
            {
              "$call": "print",
              "$args": [{ "$var": "loud" }]
            },
            {
              "$return": {
                "$call": "pure",
                "$args": [{ "$var": "loud" }]
              }
            }
          ]
        }
      }
    }
  ]
}
```

The same rule applies after a discard: the zero-parameter continuation remains
structural and its `$return` holds the `$let`.

Refactor `desugarDo` and `buildDoChain` so they compose:

```ts
const result = buildDoChain(...);
return pures.length === 0 ? result : buildLet(pures, result);
```

and:

```ts
const rest = buildDoChain(...);
const result = pures.length === 0 ? rest : buildLet(pures, rest);
const continuation = buildFunctionBody(params, result, null);
```

There must be no call to a scope constructor that accepts both parameters and
locals.

## Parser changes

### Keep source grammar and precedence stable

The authoring surface does not change. Preserve:

- `where` as a trailing body clause rather than an infix operator;
- function parsing's ownership of the unparenthesized body-level `where`;
- expression-level `where` in top-level bodies, grouped expressions, arm
  results, and binding values;
- the rule that an unparenthesized `where` following a complete `if` scopes
  over the whole conditional;
- the requirement to parenthesize a branch-local `where`;
- recursive parsing of `where` binding values;
- `do` entry syntax and `<-` adjacency behavior.

Only the emitted JSON changes.

### Binding names and empty blocks

`parseWhereBindings` already accepts source identifiers and returns entries in
source order. Keep that representation until the `$let` constructor.

Add a focused parse error for an empty block, for example:

```text
empty 'where' block: at least one binding is required
```

Do not silently erase `where {}` to its result expression; that would make
invalid source appear valid while changing the source's explicit scope marker.

Duplicate-name behavior is not part of this phase. Preserve the parser's
existing behavior unless a separate language decision changes it. Do not mix a
duplicate-binding policy change into the canonical cutover.

### Remove scope-shaped parser helpers

After the parser changes:

- `buildScope` no longer exists;
- no helper takes both `params` and `locals`;
- `parseBody` does not emit `$call` or `$args`;
- `parseFuncLit` cannot add arbitrary keys to its result;
- `desugarDo` cannot create a zero-argument function;
- `buildDoChain` cannot add pure bindings beside `$params` or `$return`.

Search parser source and tests for comments that still describe an IIFE as the
lowering of `where` or leading pure bindings.

## Printer design

### Recognize `$let` before generic data objects

Add a `$let` branch to `renderObject` before function bodies and generic
objects. It should validate the printable shape rather than rendering any
object that merely contains `$let`.

A printable let has:

- exactly `$let` and `$in`;
- a non-null, non-array binding map;
- at least one binding;
- binding names representable by shorthand identifiers.

Malformed canonical nodes should throw a clear printer error. Do not print them
as data objects or raw JSON because reparsing would not reproduce their
expression meaning.

### Render one canonical form

Render:

```json
{
  "$let": {
    "sum": { "$call": "add", "$args": [1, 2] },
    "double": { "$call": "mul", "$args": [{ "$var": "sum" }, 2] }
  },
  "$in": { "$var": "double" }
}
```

as:

```jfn
double where {
  sum: 1 + 2,
  double: sum * 2
}
```

The `$in` expression appears first because `where` is a trailing clause. The
binding map is emitted in object insertion order.

Assign the rendered let `P_BLOCK`, matching other open-ended control forms.
This ensures operators, calls, access, ascription, and non-null assertion
parenthesize it when required.

### Parenthesization

The expression before a trailing `where` must be parenthesized when its own
surface syntax would consume that `where`.

At minimum this includes:

- a function literal, whose parser treats a trailing `where` as part of its
  own body;
- another `$let`, which already prints with a trailing `where`.

For example, nested canonical lets must not print as an ambiguous chain:

```jfn
(x where { inner: 1 }) where {
  outer: 2
}
```

Do not flatten the nodes to avoid parentheses.

Generalize `returnAbsorbsTrailingWhere` to describe any expression that would
absorb a following clause. Keep the helper based on parser behavior, not on a
broad “all block expressions need parentheses” guess: complete `if`, `cond`,
`match`, `do`, and brace-terminated forms can accept a following outer
`where` without reassociation.

Binding values are emitted at block precedence because `parseWhereBindings`
uses `parseBody`; a nested let in a binding value therefore round-trips.

### Function bodies

`renderFunctionBody` should render only:

- the parameter/signature header; and
- the structural `$return`.

It must not scan non-`$` sibling keys and must not construct a `where` block
from them.

No special local-folding branch is required. If `$return` is a `$let`,
`emit($return)` naturally produces:

```jfn
(x) => result where {
  local: value
}
```

and `parseFuncLit` places that let back under `$return`.

Keep the defensive parenthesization needed when an ordinary function return is
itself an open-ended function literal. Test the interaction with `$let`
explicitly rather than assuming the old inline-local helper still covers it.

### Reject `$captures`

`$captures` is serialized runtime closure state. There is no shorthand syntax
that can preserve it, so the printer must fail before emitting source.

Use a clear message such as:

```text
Cannot print evaluator-produced function with $captures; runtime closure state has no shorthand syntax.
```

Prefer a preflight traversal from `print` over a check only in
`renderFunctionBody`. Printer sugar can consume structure without recursively
calling `renderFunctionBody`; in particular, `do` reconstruction inspects
continuation functions directly. A preflight guarantees that no reconstruction
path can hide captures.

The traversal should:

- inspect nested arrays and objects;
- report `$captures` only when it is a field of a function body;
- stop at `$raw`, whose payload is opaque data;
- include a path when practical;
- run before module, `do`, or operator reconstruction.

Do not:

- drop `$captures`;
- print it as a `where` binding;
- serialize it through `raw`;
- partially print a function while losing closure behavior.

### Reject historical function locals

The printer no longer supports function bodies such as:

```json
{
  "$params": ["x"],
  "local": 1,
  "$return": { "$var": "local" }
}
```

Throw a clear non-canonical-function error naming the stray key. This makes the
cutover visible and prevents the printer from silently preserving the old
representation.

Centralize the source structural key set used by printer validation. The target
set is:

- `$params`;
- `$sig`;
- `$return`;
- any already-supported metadata field such as `$comment`, subject to its
  existing printer policy.

`$captures` is evaluator-owned structural state but is deliberately
unprintable. Other keys are stray.

Do not define “local” as “any key not beginning with `$`”. That is the
historical open-schema rule this change removes.

### Canonical JSON not expressible in shorthand

A `$let` binding name that is not a shorthand identifier cannot be faithfully
printed with the current grammar. Reject it with a message that names the key.
Do not invent quoted binding syntax in this phase.

This is the same category as `$captures`: valid runtime JSON and printable
authoring JSON are not necessarily identical sets. The printer must fail
explicitly when the authoring surface has no inverse.

## `do` reconstruction

The printer should continue to reconstruct `do` only from an exact parser
desugaring. Update both recognized pure-binding locations.

### Leading pures

Replace recognition of:

```text
zero-argument IIFE with inline locals and a bind-spine return
```

with:

```text
$let whose bindings are printable identifiers and whose $in is a bind spine
```

Because `renderObject` currently attempts `do` reconstruction only for
`$call`, move or extend that attempt so a top-level `$let` can qualify.

If `$in` is not a reconstructible bind spine, render the node as ordinary
`where`; do not force it into `do`.

### Continuation pures

For each `bind(value, continuation)`:

1. require a structural continuation function;
2. classify zero parameters as a discard and one required identifier parameter
   as an effect binding;
3. inspect the continuation's `$return`;
4. if `$return` is a printable `$let`, append its bindings as consecutive pure
   entries;
5. continue through that let's `$in`;
6. otherwise continue directly through `$return`.

Remove `objectLocals` and every scan of continuation sibling keys.

### Exact-shape checks

Tighten reconstruction while changing it. A continuation accepted as parser
output should not contain:

- `$sig`;
- `$captures`;
- arbitrary sibling keys;
- malformed `$params`;
- more than one parameter;
- an optional, defaulted, rest, or destructured effect parameter.

The parser does not emit those shapes for `do`, so accepting them would make
the inverse lossy.

A `$let` used as a pure run must itself satisfy the normal printable-let rules.
If any condition fails, fall back to ordinary canonical rendering when one
exists. If the node contains `$captures` or a stray function key, fail through
the global validation path rather than hiding it behind fallback output.

### Reconstruction ambiguity

Some hand-authored canonical JSON can be both:

- a `$let` around a bind spine; and
- the exact image of a `do` block with leading pure bindings.

Printing it as `do` is acceptable canonical normalization because reparsing
produces the same JSON. The round-trip requirement is structural JSON identity,
not recovery of the author's original surface spelling.

Likewise, a continuation `$return` beginning with `$let` may print as pure
entries even if the JSON was assembled directly. This is safe only when the
full bind/continuation shape is an exact parser image.

## Structural function-body boundary

Phase 3 must distinguish two boundaries:

1. **Shorthand target boundary:** parser output and printer input are fully
   structural now.
2. **Transitional direct-JSON boundary:** evaluator/checker adapters may still
   accept historical inline locals until Phase 4 migrates old canonical
   fixtures.

This sequencing is necessary to keep the repository testable. Unconditionally
removing evaluator/checker legacy adapters before fixture migration would break
the shared canonical corpus assigned to Phase 4.

Therefore, in Phase 3:

- parser construction never emits stray body keys;
- printer validation rejects stray body keys;
- new evaluator/checker tests and all parser-derived programs use structural
  bodies;
- source-facing validation/classification uses the closed target model;
- legacy evaluator/checker adapters remain explicitly named and reachable only
  for old direct canonical JSON.

In Phase 4, after migration:

- delete those adapters;
- tighten shared `FunctionBody` typing and global classification as far as the
  runtime model permits;
- make evaluator/checker rejection unconditional.

Do not broaden the transitional adapter to accept any new shape. Phase 3 should
reduce its callers, not make it part of the target architecture.

## File-by-file changes

### Required source changes

#### `typescript/src/shorthand/parser.ts`

- replace `buildScope` with separate `$let` and structural-function
  constructors;
- change `parseBody` to emit `$let` directly;
- change `parseFuncLit` to place a let under `$return`;
- reject empty `where` blocks;
- change leading pure `do` lowering from an IIFE to `$let`;
- change continuation pure lowering from sibling keys to `$return.$let`;
- update comments that describe IIFE or inline-local lowering;
- ensure no parser helper accepts both parameters and locals.

#### `typescript/src/shorthand/printer.ts`

- validate and render `$let` before generic objects;
- assign `$let` block precedence;
- preserve binding insertion order;
- generalize trailing-`where` parenthesization for nested lets;
- make function-body rendering structural;
- remove non-`$` local scans;
- add capture-aware preflight validation;
- reject historical function-body locals;
- reconstruct leading and continuation pure `do` entries from `$let`;
- remove IIFE and inline-local inverse logic;
- keep `$raw` opaque during validation.

#### Optional shared function-body helper

If Phase 2 did not already centralize structural key definitions, add a small
shared module used by the evaluator, checker, and printer. It should distinguish:

- source structural fields;
- evaluator-owned `$captures`;
- module-root fields;
- temporary legacy exclusions.

Do not move shorthand-specific printability rules into the evaluator.

#### `typescript/src/types.ts`

Avoid broad type churn in Phase 3 unless needed to make illegal parser
construction unrepresentable. A useful target is a `FunctionBody` type with
named structural properties rather than an index signature, but only tighten
it when existing evaluator-produced `$captures` and transitional fixture code
remain representable without unsafe casts everywhere.

The runtime compatibility adapter is deleted in Phase 4, so final type closure
may be cleaner there.

### Required parse-case changes

Update the directly affected expectations:

- `spec/parse-cases/functions.json`;
- `spec/parse-cases/trailing-where.json`;
- `spec/parse-cases/do-notation.json`;
- any other parse suite whose source contains `where` or a pure `do` entry.

These are parser contract tests, so they must move with the parser cutover to
keep `bun test` green. Phase 4 should still perform the planned full
regeneration and review across all parse-case files as an audit, then migrate
non-parser canonical fixtures.

Expected changes include:

- function locals move under `$return.$let`;
- expression IIFEs become `$let`;
- leading-pure `do` IIFEs become `$let`;
- continuation sibling locals move under `$return.$let`;
- genuine IIFE fixtures remain unchanged.

### Required unit-test changes

#### `typescript/test/print-spec.test.ts`

- rewrite inline-local function nodes to structural `$return.$let`;
- add direct `$let` output tests;
- add nested-let parenthesization;
- retain conditional-return and nested-lambda precedence tests;
- replace old leading-pure and continuation-local `do` round trips;
- assert a genuine zero-argument IIFE still round-trips as a call;
- assert `$captures` throws, including inside a `do` continuation;
- assert stray function-body keys throw;
- assert unprintable binding names throw;
- assert `$raw` payloads containing `$captures` remain printable as raw data.

#### `typescript/test/parse-spec.test.ts`

The shared fixture updates should cover the broad parse matrix. Add focused
unit tests only where an invariant is difficult to express in the JSON fixture
format, especially:

- empty `where` rejection;
- absence of `$call` in every `where` lowering;
- absence of non-structural function keys;
- source-order preservation.

#### `typescript/test/let-eval.test.ts`

No evaluator implementation change should be required. Add or retain one
parser-to-evaluator integration test proving shorthand `where` now receives
native `$let` behavior:

- no call-depth charge;
- no call-shaped fuel;
- lazy unused binding;
- recursive function binding.

Do not duplicate the full Phase 1 canonical evaluator matrix.

#### `typescript/test/let-check.test.ts`

Add or retain parser-to-checker smoke coverage for:

- `$let.<name>` diagnostic paths from shorthand `where`;
- `$in` result paths;
- function-body `where`;
- pure `do` bindings.

The full checker semantic matrix remains canonical-JSON based.

#### CLI tests

Add small `to-json` and `to-shorthand` assertions if the lower-level tests do
not prove user-visible behavior:

- `to-json` emits `$let`;
- `to-shorthand` prints canonical `$let`;
- `to-shorthand` reports the `$captures` error cleanly;
- `eval` and `check` accept unchanged `.jfn` source after the cutover.

## Test matrix

### Expression `where`

- top-level `where` produces exact `$let`/`$in`;
- grouped `where` inside an operator produces a nested let;
- `where` in a `cond` arm produces a let at that arm result;
- `where` in a `match` arm produces a let at that arm result;
- parenthesized branch-local `where` remains branch-local;
- unparenthesized `where` after `if` scopes over the complete conditional;
- a binding value's `where` remains nested;
- an empty block is rejected;
- binding insertion order survives parse/print/parse.

### Function `where`

- untyped and typed functions place `$let` under `$return`;
- `$params` and `$sig` remain siblings of `$return`;
- no local name appears as a function-body key;
- conditional returns preserve the existing low-precedence surface;
- nested-lambda returns are parenthesized when required;
- a function returning a nested let round-trips exactly;
- parameter defaults remain structural and can reference captures according to
  the existing evaluator/checker behavior.

### `do`

- no-pure bind spines remain unchanged;
- leading pures wrap the complete bind spine in `$let`;
- multiple consecutive leading pures share one let;
- pures following an effect wrap the continuation remainder;
- pures following a discard wrap the zero-parameter continuation remainder;
- multiple pure runs separated by effects become distinct nested lets;
- pures can reference earlier effect parameters;
- pures in one run remain mutually recursive;
- the final result can itself contain an expression-level `where`;
- printer reconstruction emits the expected pure entries in order;
- malformed near-miss bind spines fall back without lossy reconstruction.

### Printer rejection

- top-level function with `$captures` throws;
- nested function with `$captures` throws;
- capture hidden in a would-be `do` continuation still throws;
- `$raw: { "$captures": ... }` does not throw;
- historical inline local key throws;
- unknown `$` function key throws unless already supported metadata;
- malformed `$let` container throws;
- empty `$let` throws;
- `$let` with extra keys throws;
- unspellable binding name throws.

### Legacy boundaries

- a genuine `({ "$call": functionBody, "$args": [] })` remains a call;
- the printer does not reinterpret that call as `where`;
- the parser emits no binding IIFE;
- direct old canonical fixtures still evaluate/check only through the named
  transitional adapters;
- new shorthand-derived fixtures never exercise those adapters.

## Implementation sequence

Keep the branch testable in this order:

1. Add a shared `$let` constructor in the parser and focused exact-shape tests.
2. Change expression-level `where` lowering and update the trailing-where
   expectations.
3. Replace `buildScope` with the structural function constructor and move
   function locals under `$return.$let`.
4. Reject empty `where` and add nested-binding/order tests.
5. Change leading and continuation pure `do` lowering; update do parse cases.
6. Add printer `$let` rendering and precedence handling so new parser outputs
   round-trip.
7. Refactor function-body rendering to consume only structural `$return`.
8. Replace `do` inverse recognition with `$let`-based reconstruction and remove
   old IIFE/inline-local helpers.
9. Add printer preflight rejection for `$captures`, stray body keys, malformed
   lets, and unprintable binding names.
10. Update focused integration and CLI tests.
11. Run formatting, typechecking, linting, parser fixtures, printer round trips,
    and the full TypeScript test suite.
12. Search for old lowering descriptions and parser/printer code that still
    scans arbitrary function keys.

Parser and printer changes should land together closely enough that
`parse(print(json))` remains meaningful at each reviewed checkpoint.

## Searches and negative assertions

After implementation, inspect the TypeScript shorthand layer for:

- `buildScope`;
- comments containing `IIFE` near `where` or `do`;
- object construction that spreads local names into a function body;
- `Object.keys(functionBody)` filters for non-`$` locals;
- `objectLocals`;
- leading-pure recognition through `$call` with empty `$args`;
- continuation-local recognition through sibling keys.

The desired remaining zero-argument-call code should be generic call handling,
not binding lowering.

Add structural test helpers where useful:

```ts
function assertNoBindingIife(node: JSONType): void
function assertStructuralFunctionBodies(node: JSONType): void
```

They should recurse through expression JSON while treating `$raw` as opaque.
Use them over representative parser fixtures rather than relying only on
individual expected objects.

## Verification

From `typescript/`:

```bash
bun run check
bun test
```

Run focused tests during implementation:

```bash
bun test test/parse-spec.test.ts
bun test test/print-spec.test.ts
bun test test/let-eval.test.ts
bun test test/let-check.test.ts
bun test test/cli-eval.test.ts
bun test test/cli-check.test.ts
```

Exercise the CLI directly:

```bash
bun run src/cli.ts to-json 'double(n) where { double: (x) => x * 2 }'
bun run src/cli.ts to-json '(x) => y where { y: x + 1 }'
bun run src/cli.ts to-json 'do { x: 1, y <- eff(), pure(x + y) }'
bun run src/cli.ts to-shorthand \
  '{"$let":{"x":1},"$in":{"$call":"add","$args":[{"$var":"x"},2]}}'
```

The Phase 3 acceptance checks are:

- every `where` source lowers to exact `$let`/`$in`;
- function bodies emitted by the parser contain only structural fields;
- every pure `do` run lowers to `$let`;
- no binding IIFE is emitted;
- `where` evaluation no longer changes call depth;
- parser output checks without the legacy body adapter;
- canonical `$let` prints and reparses exactly;
- nested lets and nested lambdas are parenthesized correctly;
- `do` reconstructs from new shapes and rejects near misses;
- the printer never scans arbitrary body keys as locals;
- `$captures` always causes a clear shorthand-print error outside `$raw`;
- genuine IIFEs remain ordinary calls;
- directly affected parse fixtures use the new canonical representation;
- all TypeScript checks and tests pass.

## Simplifications delivered in Phase 3

These simplifications should be visible in the finished shorthand code:

- one parser constructor introduces expression-local bindings;
- one structural constructor builds function bodies;
- `where` never enters call lowering;
- pure `do` bindings and ordinary `where` share one canonical node;
- function printing reads `$return` rather than discovering locals;
- do reconstruction peels `$let` rather than inspecting function siblings;
- runtime captures cannot be silently erased by source printing;
- parser and printer agree on a closed function-body source shape;
- old binding encodings have no printer inverse.

## Phase boundary handoff

Phase 4 can assume:

- all newly parsed shorthand uses `$let`;
- all parser-produced functions are structural;
- printer round trips cover canonical `$let`;
- printer support for inline locals and binding IIFEs is gone;
- do parse/reconstruction uses `$let` exclusively;
- `$captures` is explicitly unprintable;
- focused parse fixtures already describe the new representation;
- evaluator and checker semantics have been exercised through shorthand.

Phase 4 must still:

- migrate old direct canonical fixtures and stored examples;
- perform the full parse-case regeneration/audit;
- delete evaluator/checker legacy body adapters;
- remove remaining body-key skip lists and transitional index signatures;
- make closed function-body rejection unconditional at every canonical input
  boundary;
- update `docs/language.md` and `docs/shorthand-spec.md`;
- add the final conformance regression matrix;
- verify that no historical binding shape remains in TypeScript sources or
  shared fixtures.
