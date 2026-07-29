# Plan: strict indexed reads

Status: proposed; reconciled around runtime-representable strict `$get`
semantics.

Make direct array, object, map, tuple, and string reads strict. Nullable
absence is represented by explicit operations, not inferred from checker-only
required/optional field information.

## Motivation

The checker types `inv[sku]` as the element type `T`; the runtime returns
`null` on a missing key or out-of-range index. This is the worst pairing for
LLM agents:

- "Type coverage: complete" reads as a promise. Agents trust it, skip
  defensive handling, and then hit a runtime error at whatever distance the
  null traveled before something read through it. Deferred failures make
  agents patch where the error _surfaced_, not where the absence
  _originated_.
- Agents who read the runtime rule ("missing keys read as null") compensate
  with reflexive `x[i]!`, converting the language to strict-reads-plus-noise
  where every `!` is an unexamined assertion. (Observed in the blind
  authoring exercise: every defensive `!` written was unnecessary per the
  checker, and every bare index the checker blessed was a latent
  fail-slow site.)
- Null-punning reads are the language's lone fail-slow feature. Everything
  else already fails fast: strict templates, erroring arithmetic (no NaN),
  exact arity, hard `checked as` failures, total `handle`. Strict reads
  restore a uniform personality, which is what makes a language predictable
  from a short doc.

Alternative considered and rejected: type indexed reads as `T | null`
(TS `noUncheckedIndexedAccess`). Sound, but (a) agents degrade it to `!`
spam in practice; (b) `hasKey` is not a narrowing form, so even correctly
guarded reads would demand `!` unless narrowing is extended; (c) it pushes
null through the ecosystem of element types where absence was never a case.

## Design

### Principle

Canonical `$get` carries only the evaluated target and key. It does not carry
the checked schema or whether an object field was declared required or
optional. The runtime therefore cannot make direct access strict for required
fields but nullable for optional fields.

This plan selects one runtime-representable rule: **every direct `$get` miss is
an immediate error**. Absence as data uses an explicit nullable/defaulting
operation.

| Read site                                  | Static type | On absence      |
| ------------------------------------------ | ----------- | --------------- |
| `arr[i]`, `obj[k]`, `obj.k`, `text[i]`     | `T`         | immediate error |
| direct read of a field declared `k?: T`    | revised     | immediate error |
| `lookup(m, k)` (new)                       | `T \| null` | returns `null`  |
| defaulting operation (name to be selected) | `T`         | returns default |

Decision procedure to teach: _absence is a bug → access directly; absence is a
case → use `lookup` or the defaulting operation._

### Semantics details

- **Arrays:** out-of-range (including negative, if currently tolerated) is
  an error naming the index and length.
- **Objects/maps:** missing key is an error naming the key and, when small,
  the available keys.
- **Optional object fields:** direct access has the same runtime rule as every
  other `$get`; missing optional fields error. Checker projection must change
  so it no longer promises nullable direct access that runtime syntax cannot
  distinguish.
- **Tuples and closed objects:** computed reads that currently include `null`
  on possible misses must migrate with the evaluator rule, either to a strict
  projected type or to the explicit nullable operation.
- **Strings:** integer indexing is in scope. An out-of-range code-point index
  errors under the same direct-read rule.
- **Paths:** each segment of a canonical path read is strict. Existing
  null-on-missing-segment behavior migrates in the same change.
- **Errors are host errors** (same class as `checked as` failure /
  arithmetic error), not `raise`-catchable domain signals — absence under a
  `T`-typed read is by definition a bug.
- **`!` reverts to its narrow job:** stripping `null` from types that
  include it. After this change a `!` on a plain indexed read is dead code;
  consider a checker warning for `e!` where `e : T` with no `null` arm.
- **Writes/merges/spreads unchanged.** Only reads change.
- **Error payload:** include the key/index, access path, and a bounded container
  summary. Runtime source spans are not currently available merely because
  checker diagnostics have positions; adding spans requires separate evaluator
  metadata and is not required for this semantic change.

### Surface / builtins

1. Keep existing `hasKey`. Add `lookup(m, k) -> V | null`; no such builtin
   exists today.
2. Add a defaulting operation only after selecting a non-conflicting name.
   The proposed `get(m, k, default)` does not exist today and must not overload
   another operation accidentally.
3. Preserve the current nullable general signatures of `head` and `last`, plus
   their strict non-empty-array overloads. Audit other partial accessors for
   the same type/runtime agreement.
4. Optional: add `hasKey` narrowing later as ergonomics; under strict reads
   it is no longer _required_ for soundness, so it can be deferred.

## Implementation steps

1. **Spec first:** update `language.md`, builtin signatures, and shorthand
   guidance with the table above.
2. **Canonical/runtime model:** keep `$get` strict for all direct access. Add
   the selected explicit nullable/defaulting operations without attaching
   checker schemas to evaluator nodes.
3. **Eval:** replace null-on-miss paths for arrays, objects/maps, tuples,
   strings, and path segments with structured errors carrying index/key and a
   bounded container summary.
4. **Checker:** revise optional-field and computed tuple/closed-object
   projection to agree with strict direct reads. Type `lookup` as nullable and
   the defaulting operation as non-nullable. Add the dead-`!` warning if cheap.
5. **Builtins:** implement `lookup` and the selected defaulting operation;
   verify `head`/`last` overloads and re-type other partial accessors as needed.
6. **Corpus migration:** run the checker+tests over `examples/*.jfn` and any
   internal corpora. Expect near-zero breakage: functional style routes most
   element access through `map`/`reduce`/`sortBy`, so raw index sites are
   rare, and existing code that _relied_ on null-on-miss was already lying
   to the checker. Each such site migrates mechanically to `hasKey` guard,
   `lookup`, or the defaulting operation.
7. **Docs:** one line in `writing-jfn.md` §9 replaces the current runtime
   caveat:

   ```jfn
   // Reads are as strict as their types: a read typed T errors immediately
   // on a missing key / out-of-range index. Optional fields use the same
   // direct-read rule; use lookup/defaulting when absence is a case.
   onHand: (inv: Inventory, sku: string) -> integer =>
     defaultingLookup(inv, sku, empty).onHand
   ```

   Also delete the now-false "missing keys read as null" trip-up entry and
   drop the defensive-`!` guidance from the doc-changes plan (this change
   supersedes finding 1a there).

8. **Conformance tests:** replace every existing null-on-miss property/path
   case in the same change. Cover in-range access; array, string, object, map,
   tuple, closed-object, optional-field, and path misses; `lookup` null;
   defaulting behavior; computed keys; and one regression asserting the error
   fires at the access inside a fold.

## Acceptance criteria

- Runtime absence behavior is derivable from canonical syntax and information
  actually available to the evaluator.
- Checker projection and runtime behavior agree for required, optional, map,
  array, tuple, closed/computed-object, path, and string reads.
- Nullable/defaulting absence is explicit and ergonomic.
- `examples/*.jfn` pass unchanged or with mechanical `lookup`/`get`
  migrations, each of which makes a previously implicit absence-case
  explicit.
- A blind-authoring re-run produces zero defensive `!` on indexed reads and
  zero latent fail-slow sites: any absence bug fails at the exact line.

## Open questions

- Naming/arity vs existing builtins (`get` may already exist with different
  semantics — do not overload meaning; pick fresh names if so).
- Should tuple types get compile-time bounds checking on literal indices
  (making `pair[2]` a static error)? Cheap and consistent; recommended if
  tuple arity is already tracked.
- Interaction with `is`/narrowing on `T | null` results of `lookup` — verify
  `!= null` narrowing already covers the ergonomic path so `lookup` is
  pleasant without new machinery.
