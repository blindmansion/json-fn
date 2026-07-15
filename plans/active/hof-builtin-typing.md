# Higher-order builtin typing

## Goal

Make higher-order builtin calls sound and predictably precise in the canonical
TypeScript checker:

- infer callback parameter types from the data arguments;
- enforce every concrete constraint around an inferred callback return;
- check annotated and referenced callbacks against the final instantiated
  function type;
- reject callback parameters the builtin never supplies; and
- move `mapValues` off its current `any`/bare-object floor.

This plan is about the private builtin signature dialect and its TypeScript
instantiation engine. It does not add guest generics.

## Current status

### Polymorphic array HOFs

`spec/builtins.json` describes these with `$fnType` and `$tvar`:

- `map`, `flatMap`, and `reduce` infer an output/accumulator variable;
- `filter`, `find`, `findIndex`, `some`, and `every` check a boolean callback;
- `sort` checks a numeric comparator;
- `sortBy` checks a `string | number` key;
- `groupBy` checks a string key and returns `{ [string]: T[] }`.

`reReplaceWith` uses the same contextual-lambda machinery with a concrete
`(Match) -> string` callback.

The implementation is in `typescript/src/check/builtin-rules.ts`:

1. `tryBindOverload` silently synthesizes concrete arguments and defers inline
   function bodies.
2. `applyOverload` first binds type variables from concrete arguments.
3. It then stamps the instantiated callback parameter types onto deferred
   lambdas, synthesizes their bodies, and either infers or checks their returns.
4. The builtin return template is instantiated from the resulting bindings.

Ordinary inline cases work today. For example:

```sh
cd typescript

bun run src/cli.ts check --expr \
  'map((n, i) => n + i, [10, 20, 30])'
# integer[], fully checked

bun run src/cli.ts check --expr \
  'filter((n, i) => n > i, [0, 2, 1, 5])'
# integer[], fully checked

bun run src/cli.ts check --expr \
  'groupBy((n, i) => if n > 1 then "big" else "small", [1, 2, 3])'
# { [string]: integer[] }, fully checked
```

Concrete callback returns are enforced correctly:

```sh
bun run src/cli.ts check --expr \
  'filter((n, i) => n + i, [1, 2, 3])'
# error at $args[0].$return: integer is not assignable to boolean

bun run src/cli.ts check --expr \
  'sortBy((n, i) => { rank: n }, [3, 1, 2])'
# error: object is not assignable to string | number
```

### Known coarse floors

`mapValues` is not polymorphic. Its callback is `(any, string) -> any` and its
return is bare `object`, so a call can report full coverage while propagating no
value information.

`apply` and `pipe` remain `{ "rule": ... }` escape hatches. The TypeScript rule
floors check only arity and coarse argument shape, return `any`, and report a
coverage degradation. Precisely typing heterogeneous argument lists and
function chains requires code, not a substitution template.

The effect HOFs (`bind` and `handle`) are part of the typed host environment /
`Task<A>` work and are out of scope here.

## Correctness gaps

### H1 — A nested inferred return template loses its outer constraint

When a callback return template mentions any `$tvar`, `applyOverload` calls
`unifyTemplate` to infer it but ignores the boolean result. A failed structural
match therefore emits no diagnostic. `flatMap` is the current concrete case:
its callback must return `U[]`, but a scalar return is accepted and leaves `U`
unbound, producing `any[]`.

Minimal repro:

```sh
bun run src/cli.ts check --expr \
  'flatMap((x, i) => x + 1, [1, 2])'
```

Current result:

```text
type: array<any>
No type errors.
Coverage: fully checked.
```

Expected: an error at `$args[0].$return` saying `integer` is not assignable to
`array<any>`.

This is a general engine bug, not a `flatMap` special case. Any future callback
return such as `{ value: U }`, `[string, U]`, or `U[]` would have the same
failure mode.

### H2 — Concrete callbacks are checked before bindings are final

Non-inline function values, including `&name` references, are handled as
ordinary concrete arguments. `applyOverload` unifies and validates each
argument immediately. Because HOF signatures put the callback before the data,
the callback is checked against its own contribution to `T`; a later array can
widen `T`, but the callback is never rechecked against that final type.

Minimal repro:

```sh
bun run src/cli.ts check \
  '{ wrong: (s: string, i: integer) -> string => s,
     main: () -> string[] => map(&wrong, [1, 2]) }'
```

Current result: no errors. At runtime `main` returns `[1, 2]`, violating its
declared `string[]` result because `wrong` receives integers.

Expected: reject `&wrong`; `(string, integer) -> string` cannot be used where
`(integer, integer) -> string` is required. Function parameter compatibility
must remain contravariant.

### H3 — Contextual typing overwrites inline parameter annotations

`inferLambdaReturn` preserves an inline lambda's declared return for an
additional body check, but replaces its declared parameter schemas with the
builtin's contextual schemas. Contradictory parameter annotations are silently
ignored.

Minimal repro:

```sh
bun run src/cli.ts check --expr \
  'map((n: string, i: integer) -> integer => 1, [10, 20])'
```

Current result: `const 1[]`, no errors.

Expected: reject the callback because its declared first parameter is `string`,
while `map` will call it with an `integer`.

A fully annotated inline function is a concrete function value, not an
unannotated lambda with hints. Its signature must be checked as written.

### H4 — Inline callback arity is not validated

Contextual scope construction does not diagnose extra lambda parameters.
Builtins supply only the parameters in their callback signature, so an extra
parameter is bound as `any` and receives the evaluator's missing-argument value.

Minimal repro:

```sh
bun run src/cli.ts check --expr --require-full-coverage \
  'map((n, i, extra) => extra, [1, 2])'

bun run src/cli.ts eval \
  'map((n, i, extra) => extra, [1, 2])' --compact
```

Current result: `any[]`, reported as fully checked; runtime result
`[null,null]`.

Expected: reject `extra` because `map` supplies only `(item, index)`.

Omitting trailing parameters remains valid and idiomatic:
`map((n) => n + 1, xs)` intentionally ignores the index. The rule should be
“at most the supplied callback arity,” not exact arity for inline lambdas.

## Precision gaps

### H5 — Make `mapValues` polymorphic

A1 object-template matching makes a shared signature possible:

```json
{
  "typeParams": ["T", "U"],
  "params": [
    {
      "$fnType": {
        "params": [{ "$tvar": "T" }, { "type": "string" }],
        "returns": { "$tvar": "U" }
      }
    },
    {
      "type": "object",
      "additionalProperties": { "$tvar": "T" }
    }
  ],
  "returns": {
    "type": "object",
    "additionalProperties": { "$tvar": "U" }
  }
}
```

Minimal repro:

```sh
bun run src/cli.ts check --expr --require-full-coverage \
  'mapValues((v, k) => v + 1, { a: 1, b: 2 })'
```

Current result: bare `object`, reported as fully checked.

Expected: `{ [string]: integer }`, with `v: integer` and `k: string` inside the
callback.

The substitution template cannot preserve the exact keys of a closed input
record. A map result is the honest shared floor; exact structural key
preservation would be a separate code computation and is not needed here.

### H6 — Reduce result normalization

`reduce((acc, n, i) => acc + n + i, 0, [1, 2, 3])` currently infers
`const 0 | integer`. This is sound but redundant because `integer` already
contains `const 0`.

Treat this as optional schema-normalization polish, not a blocker for H1–H5.
If addressed, improve `unionOf` generally by removing literal arms subsumed by
another arm rather than special-casing `reduce`.

## Deliberate non-goals

- User-authored generic functions or aliases.
- Predicate/type-guard callbacks. `filter` returns `T[]` and `find` returns
  `T | null`; they do not narrow `T` from callback logic.
- Literal-key preservation for `groupBy` or `mapValues`.
- Precise `apply`/`pipe` typing in the shared signature dialect.
- `Task<A>`, typed `bind`, or typed `handle`.
- Changing runtime callback argument order or the public stdlib API.

## Plan

### P0 — Make template-return matching enforceable

1. Make callback-return unification transactional: infer into a temporary
   binding set and commit only when the whole template matches.
2. Check the return value of `unifyTemplate`.
3. On failure, report the callback return against the template instantiated
   with known bindings and `any` for unresolved variables.
4. Add synthetic tests for nested array, tuple, and object return templates,
   plus the real `flatMap` repro.

### P0 — Finalize bindings before validating concrete arguments

Refactor both `tryBindOverload` and `applyOverload` into distinct phases:

1. synthesize all concrete argument schemas;
2. unify all of them into one candidate binding environment;
3. instantiate every parameter from the final bindings;
4. validate every concrete argument against that final parameter; and
5. only then contextually type unannotated inline lambdas.

Do not rely on argument order. Add named-function tests covering compatible
callbacks, contravariant broad callbacks, incompatible narrow callbacks, and
return-type inference.

### P0 — Separate annotated functions from contextual lambdas

Only defer an inline body when it has no `$sig`.

A body with a declared signature should follow the concrete-function path:
synthesize and check its body against its own signature, use that function type
during unification, and validate it against the final instantiated callback
type. Preserve contextual typing only for bare lambdas.

Add tests showing that contradictory parameter annotations fail and compatible
annotations pass. Keep the existing check that a declared callback return
matches its body.

### P1 — Validate contextual callback arity

Before building a bare lambda's contextual scope:

- allow it to declare fewer parameters than the builtin supplies;
- reject more fixed parameters than the builtin supplies;
- handle rest parameters explicitly rather than silently assigning `any`.

Pin the diagnostic to the callback argument and avoid secondary body errors
when arity is invalid.

### P1 — Convert `mapValues`

Replace its monomorphic signature with the shared `T`/`U` object-map template.
Add closed-record, typed-map, mixed-value, open-object, bad-callback-return, and
runtime CLI-equivalent tests.

### P2 — Optional normalization and documentation

1. Consider subsumption-aware union simplification for the redundant `reduce`
   result.
2. Update `docs/builtin-signatures.md` with the distinction between bare
   contextual lambdas and annotated/referenced function values.
3. Document `mapValues`' map-shaped return floor.

## Verification

For each implementation step:

```sh
cd typescript
bun test test/check/builtins.test.ts
bun run check
bun test
```

Then rerun every minimal repro above through both `check` and, where meaningful,
`eval`. The key acceptance criteria are:

- invalid `flatMap` callback shapes fail;
- named and annotated callback incompatibilities fail;
- extra callback parameters fail without cascades;
- ordinary bare callbacks continue to infer precisely;
- `mapValues` propagates input and output value types; and
- `apply`/`pipe` continue to report their intentional coverage degradation.
