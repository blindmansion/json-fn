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
2. **`eq` hash fast-path.** Structural equality between two refs with
   compatible semantic `ValueHash` values can use an O(1) comparison with zero
   hydration. Physical `BlobHash` values are never equality evidence.
   Deep-equality on large shared state — currently a metered O(n) walk — may
   collapse once fuel behavior is specified.
3. **Sound memoization.** For transitively pure calls, a cache keyed by
   `(callee hash, args hash) → result` is semantically invisible. This
   extends to durable memoization in the store (Unison-style incremental
   recomputation; Temporal-style side-effect caching falls out of the same
   table for `pure` results).

The invariant that governs everything here: **the guest must never be able to
observe whether a value is a ref or inline.** All three features are pure
optimizations over v1 semantics, and any place where that equivalence would
break is a place this plan does not go.

This is a separate evaluator architecture project, not a direct extension of
the at-rest codec.

## Unresolved architecture requirements

All of these are blockers:

- Blob reads are asynchronous while evaluation and task sessions are
  synchronous. Select async evaluation, complete prefetch, a synchronous local
  cache, or a new suspension mechanism before specifying forcing.
- Runtime refs must use an unforgeable host-only representation, not an object
  shape guest data can imitate.
- Equality shortcuts use compatible semantic `ValueHash` values, never
  physical `BlobHash` addresses.
- Portable fuel cannot depend silently on chunk thresholds, cache warmth, or
  store state. Specify virtual inline-equivalent charges or explicitly version
  a non-portable execution profile.
- Audit actual `maxValueSize` enforcement at production, hydration, forcing,
  host, and serialization boundaries before claiming refs do not interact with
  it.
- Memoization purity is transitive: a guest function that can reach a host
  function is not automatically pure. Cache hits/misses also need specified
  fuel and failure behavior.
- Complete a builtin/validator forcing-depth audit and a host-boundary forcing
  contract.

## Design sketch

### Runtime representation

A runtime-only unforgeable branded/tagged host value, never a JSON shape the
guest can construct or see. The following is only conceptual:

```ts
type Ref = InternalRef<ValueHash>;
```

- Created only when hydrating a stored record with lazy mode enabled.
- **Forcing** replaces the wrapper with the decoded value (memoized in
  `forced`). Forcing is recursive only one level: a forced blob may itself
  contain child refs.

This representation is separate from all categories established by
`../raw-semantics-cleanup.md`: canonical `$raw` is serialized syntax, a
runtime-value mark says plain JSON has already been produced as a value, and
static-cost metadata is an AST optimization. A lazy `Ref` is none of those; it
is a storage-backed runtime representation that yields a runtime value when
forced.

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

Naively, that makes fuel depend on *chunking boundaries* (whether two values
are refs) — which is host-visible state. Two acceptable resolutions, to be
decided:

- **(a)** Keep lazy mode outside conformance entirely: it is a host
  optimization, and hosts running lazy mode accept that fuel accounting may
  differ from the specified inline model (documented, like wall-clock
  timeouts). Simple, honest, weakens fuel portability for lazy hosts.
- **(b)** Specify the fast-path as *the* metered behavior for `eq` whenever
  both sides carry known hashes, and charge the inline cost otherwise.
  Deterministic given the same chunking config, but drags chunking into the
  conformance spec.

No option may silently change portable fuel. Option (a) requires an explicitly
versioned non-portable execution profile; option (b) requires
inline-equivalent virtual charges or a portable semantic rule independent of
physical chunking.

### `maxValueSize`

Today `maxValueSize` is not a recursive serialized-byte bound. The canonical
TypeScript evaluator checks produced string code-point lengths and array
lengths at result/selected builtin construction points, and separately checks
closure-substitution expansion by attached node count. It does not establish
that every arbitrary hydrated object tree was previously checked.

Lazy-ref interaction is therefore unresolved. Audit enforcement for produced
values, hydrated records, forced subtrees, host boundaries, and serialization
before deciding whether forcing must add checks or preserve an earlier
validated size certificate.

### Memoization table

Optional, separate flag, built on the same hashes:

```ts
memo: { get(fnHash, argsHash): JSONType | undefined; put(...): void }
```

- Sound only for transitively pure calls. Guest functions that directly or
  transitively reach host functions are not memoizable merely because their
  outer call is guest code. Task-building may be memoizable only after the
  same transitive analysis.
- Cache hits, misses, cached failures, and successful results must have defined
  deterministic fuel and failure behavior.
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

1. Eager at-rest CAS is shipped and measured.
2. Hydration latency or memory duplication is a demonstrated bottleneck on a
   representative workload.
3. Raw syntax, runtime-value identity, static-cost metadata, deterministic
   `$raw` fuel, and centralized hydration are stable.
4. Semantic `ValueHash` support is available and distinct from physical
   `BlobHash`.
5. The asynchronous forcing architecture, unforgeable representation, builtin
   and host forcing contracts, and portable fuel policy are decided.
6. Module identity is available before durable memoization.

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
