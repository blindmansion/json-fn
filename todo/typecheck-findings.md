# Typechecker findings

Notes from an exploratory pass over the type system through the `jfn check`
CLI, after wiring `check` to parse `.jfn` shorthand (so the pipeline is
`parse -> lower -> check` in one step, `--json` to feed canonical JSON, `--expr`
for a single expression). These are observations, **not** yet triaged fixes.
Line references are to `typescript/` at time of writing.

Context: only the builtins in `spec/builtins.json` have signatures today
(arithmetic, comparisons, `not`/`and`/`or`, `isX`, `str`/`upper`/`lower`/`trim`,
`length`, `head`, `concat`, `setAt`, `map`, `filter`, `reMatch`, `pipe`). Things
like `reduce` are absent, so anything using them degrades to `any` — out of
scope here.

## What landed well

Worth stating up front, since most of this behaved:

- Arithmetic overload resolution (`1 + 2 : integer`, `1.5 + 2 : number`,
  `1 / 2 : number`).
- Generics: `map`/`filter`/`head`/`concat`/`setAt` infer & unify `T`/`U`,
  including nested (`map(map(...))`, `head(map(...))`) and widening on unify.
- Flow narrowing: `if isNumber(x) then str(x) else upper(x)` checks clean.
- Discriminated unions: `if e.tag == "move" then e.to else 0` narrows the
  variant so `e.to` resolves.
- Signatures: curried function types, rest params, recursive types,
  object-pattern params, arity checking.
- Real errors caught: return-type mismatch, wrong arg type, extra/missing
  object field, arity.

## Soundness gaps

### `pipe` returns `any`

`pipe(5, (n) => n + 1, (n) => n * 2)` infers `true`; the `pipe` rule doesn't
propagate a result type.

### Computed index access isn't integer-checked

`arr[i]` (a language-level `$get` with a computed numeric key) is projected
structurally without requiring the index to be an `integer`, so
`arr[2.5]`-style access isn't rejected. The integer-demanding *builtin*
positions (e.g. `setAt`'s index, the `+`/`/` overloads) already declare
`integer` in `spec/builtins.json` and *are* checked; the gap is only the
language-level `$get` path. Closing this makes indexing fully covered, which is
the main thing the `integer`/`number` distinction buys us (whole-vs-fractional
values are otherwise interchangeable — `2.0` correctly folds to `integer`, and
that's a sound subtyping choice, not a bug).

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

The real mistake is the return type: a function type wraps its *parameter list*
in parens (`(integer) -> string`), so this should be
`-> ((integer) -> string)`. But the error points at the `:` in the parameter
list (column 3), nowhere near the actual problem. Cause: `looksLikeFuncLit`
gates the lambda interpretation on `returnTypeEndsInFatArrow`, which does a
throwaway type-parse of the return annotation inside a `try { … } catch { return
false }` (`parser.ts`). The malformed return type throws, the `catch` swallows
it, so the whole `( … )` is no longer seen as a lambda header and falls through
to the grouping-paren branch — which then fails at the first token an expression
can't accept (the `:`). Surfacing the discarded type-parse error (or noting the
`->`-without-a-valid-return-type shape) would point at the real fault.

### `where` only parses in function-body return position

`x + 1 where { x: 5 }` fails at top level (through `check`, `to-json`, and
`eval`), but `(doubled + 1) where { doubled: n * 2 }` works as a function
body's return expression (and its bindings *are* type-checked). The `let ... in`
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
condition type is unchecked"). But `$if` is defined to branch on *truthiness*
(`docs/language.md`: "`$if` is evaluated; if truthy, `$then` … otherwise
`$else`"), exactly like `$and`/`$or`. So `1` is a legitimate condition and
`if 1 then 10 else 20 : 10` was already sound — requiring a `boolean` condition
would be wrong (it'd break `if x then … else default`-style truthiness checks).

The precision win here is the `$if` analogue of the `$and`/`$or` fix below:
narrow the condition *value* by its own truthiness inside each branch. A bare
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
last), deliberately *not* the eager boolean stdlib `and`/`or`. So requiring
boolean operands (would break the `x || default` idiom) or a boolean result
would both be wrong, and `1 && 2 : 2` was already sound. The result rule now
narrows each non-final operand to the slice that can stop the chain — falsy for
`$and`, truthy for `$or` — so `(x: string | null) || d : string | typeof d`,
`1 && 2 : 2`, and `true && false : false`. Purely a precision improvement.
