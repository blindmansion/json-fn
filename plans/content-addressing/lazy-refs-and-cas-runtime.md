# Lazy refs and a content-addressed runtime (follow-up B)

Status: sketch, deliberately deferred. Requires
[`content-addressed-values.md`](content-addressed-values.md) (v1) shipped and
measured first. Nothing here should be built until v1's instrumentation shows
hydration cost or memory duplication is an actual bottleneck.

## Summary

v1 keeps refs strictly at rest: records are fully hydrated before evaluation.
This follow-up moves refs **inside the running evaluator** as lazy handles,
which unlocks three capabilities v1 cannot reach:

1. **Partial hydration.** Resume a workflow without loading state the
   continuation never touches. A continuation that reads `state.cursor` and
   ignores a 50 MB `state.history` fetches one small blob, not the DAG.
2. **`eq` hash fast-path.** Structural equality between two refs with equal
   hashes is `true` in O(1) with zero hydration; unequal hashes are `false`
   in O(1) (canonical hashing makes hash equality iff content equality,
   modulo collisions). Deep-equality on large shared state — currently a
   metered O(n) walk — collapses.
3. **Sound memoization.** The language is pure, so a cache keyed by
   `(callee hash, args hash) → result` is semantically invisible. This
   extends to durable memoization in the store (Unison-style incremental
   recomputation; Temporal-style side-effect caching falls out of the same
   table for `pure` results).

The invariant that governs everything here: **the guest must never be able to
observe whether a value is a ref or inline.** All three features are pure
optimizations over v1 semantics, and any place where that equivalence would
break is a place this plan does not go.

## Design sketch

### Runtime representation

A runtime-only wrapper (never a JSON shape the guest can construct or see):

```ts
type Ref = { hash: string; forced?: JSONType };
```

- Created only when hydrating a stored record with lazy mode enabled.
- **Forcing** replaces the wrapper with the decoded value (memoized in
  `forced`). Forcing is recursive only one level: a forced blob may itself
  contain child refs.

### Forcing chokepoints

The evaluator already funnels value access through a small set of paths:

- `$get`/`$from` access forces the target one level;
- builtins force arguments to the depth they traverse (a `length` forces one
  level; a `sum` forces the array and its elements; `str`/serialization forces
  fully);
- `eq`/`neq`/`includes`/`indexOf` try the hash fast-path first, forcing only
  on inline-vs-ref comparisons (see below);
- crossing any boundary back to the host (entry return, effect args,
  contract validation, serialization) forces fully — hosts never see `Ref`.

The audit burden is real: every builtin that touches structure must either
force correctly or be proven to only pass values through opaquely. This is
the main cost of the plan and the reason it is deferred.

### Fuel determinism (the hard constraint)

Fuel is deterministic and conformance-specified. Lazy forcing must not make
metering depend on store behavior or on whether a value happened to be
chunked. Rule:

> Forcing a ref charges exactly what evaluating/traversing the equivalent
> inline value would have charged at that chokepoint, no more, no less. The
> hash fast-path for `eq` is the one deliberate divergence and must be
> specified: `eq(ref, ref)` with equal/unequal hashes charges O(1), not O(n).

That makes fuel depend on *chunking boundaries* (whether two values are refs)
— which is host-visible state. Two acceptable resolutions, to be decided:

- **(a)** Keep lazy mode outside conformance entirely: it is a host
  optimization, and hosts running lazy mode accept that fuel accounting may
  differ from the specified inline model (documented, like wall-clock
  timeouts). Simple, honest, weakens fuel portability for lazy hosts.
- **(b)** Specify the fast-path as *the* metered behavior for `eq` whenever
  both sides carry known hashes, and charge the inline cost otherwise.
  Deterministic given the same chunking config, but drags chunking into the
  conformance spec.

Leaning (a). Fuel portability matters most for metered multi-tenant guests,
which can simply not enable lazy mode.

### `maxValueSize`

Unchanged: it bounds values a program *produces*. Refs are never produced by
guest code; forcing a stored value re-checks nothing (it was checked when
produced). No interaction.

### Memoization table

Optional, separate flag, built on the same hashes:

```ts
memo: { get(fnHash, argsHash): JSONType | undefined; put(...): void }
```

- Sound only for pure calls — which is *all* guest calls; effects are inert
  data, so even task-building functions memoize safely (the task is a value).
  Host direct functions are the exception: never memoized (they may be
  impure by contract).
- In-process LRU first; the durable store variant (cross-run memoization) is
  a later extension with its own GC/invalidations keyed by the module
  identity hash from
  [`module-identity-pinning.md`](module-identity-pinning.md) — a memo entry
  is valid only under the module world that produced it.
- Hashing arguments on every call is not free; gate it behind a per-function
  opt-in (host config listing memoizable module functions) rather than
  hashing the world by default.

## What this is not

- Not a language feature: no `$`-form, no shorthand, no checker involvement,
  no spec/cases changes beyond (possibly) the `eq` fast-path note.
- Not a distributed cache protocol. Cross-host blob negotiation stays out.
- Not Prolly-tree/insert-stable chunking — still orthogonal, still deferred.

## Preconditions before starting

1. v1 shipped, with instrumentation showing (a) hydration latency or (b)
   memory duplication at resume as a measured bottleneck on a real workload.
2. The builtin audit list (which builtins force to what depth) written
   against the actual builtin table — this doc's rules are stated abstractly;
   the audit is the real work item and its size should be known before
   committing.
3. Decision recorded on fuel option (a) vs (b) above.

## Open questions

1. Does the checker ever need to know about refs? (It shouldn't — refs are
   runtime-only and typed as their content — but `$as`/contract validation
   paths force fully today; confirm no validator walks partially.)
2. Interaction with `tap`/logging: a logger receiving a lazy value must not
   force the world to print it. Probably: loggers receive the forced-one-level
   view with refs rendered as `{"@blob": hash}` — the one sanctioned place a
   host (not guest) sees a ref.
3. Whether the `eq` fast-path alone (without lazy hydration) is worth an
   intermediate milestone: hash-tag values at hydration, force eagerly as in
   v1, but keep hashes attached for equality. Much smaller audit surface;
   delivers benefit 2 without benefit 1.
