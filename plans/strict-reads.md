# Plan: strict indexed reads

Make array/object indexed reads honor their static types: a read typed `T`
errors immediately on absence; absence is representable only where the type
says `T | null`. Replaces the current null-on-miss runtime semantics, which
predate the checker.

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

**Runtime strictness = static type.** One rule generates all behavior:

| Read site                            | Static type | On absence           |
| ------------------------------------ | ----------- | -------------------- |
| `arr[i]`, `obj[k]`, `obj.k` (req.)   | `T`         | immediate error      |
| `obj.k` where field is `k?: T`       | `T \| null` | reads `null` (agree) |
| `lookup(m, k)` (new/confirmed)       | `T \| null` | returns `null`       |
| `get(m, k, default)` (new/confirmed) | `T`         | returns `default`    |

Decision procedure to teach: _absence is a bug → index bare; absence is a
case → use `lookup`/`get` or an optional field._

### Semantics details

- **Arrays:** out-of-range (including negative, if currently tolerated) is
  an error naming the index and length.
- **Objects/maps:** missing key is an error naming the key and, when small,
  the available keys.
- **Errors are host errors** (same class as `checked as` failure /
  arithmetic error), not `raise`-catchable domain signals — absence under a
  `T`-typed read is by definition a bug.
- **`!` reverts to its narrow job:** stripping `null` from types that
  include it. After this change a `!` on a plain indexed read is dead code;
  consider a checker warning for `e!` where `e : T` with no `null` arm.
- **Writes/merges/spreads unchanged.** Only reads change.
- **Error payload:** include the source position and the _access path_
  (already have positions in checker errors; runtime index errors should
  match that quality).

### Surface / builtins

1. Add or confirm `lookup(m, k) -> V | null` and `get(m, k, default) -> V`
   (audit `builtins.md` for existing equivalents first; reuse names already
   present rather than introducing synonyms).
2. Audit partial builtins for type honesty under the new principle:
   `first`/`last`/`head`-style accessors should be typed `T | null` (and
   keep returning null), or gain strict variants — whichever matches current
   signatures, the type and the runtime must agree.
3. Optional: add `hasKey` narrowing later as ergonomics; under strict reads
   it is no longer _required_ for soundness, so it can be deferred.

## Implementation steps

1. **Spec first:** update `language.md` §(indexing) and
   `builtin-signatures.md` with the table above. Small spec; the rule is one
   sentence.
2. **Eval:** locate null-on-miss paths in the core eval (array index, object
   index, member access on maps) and replace with structured errors carrying
   index/key, container summary, and source span. Leave the optional-field
   read path returning null.
3. **Checker:** no typing changes required (types are already strict — that
   is the bug being fixed). Add the dead-`!` warning if cheap.
4. **Builtins:** implement/rename `lookup`/`get`; re-type partial accessors
   as needed.
5. **Corpus migration:** run the checker+tests over `examples/*.jfn` and any
   internal corpora. Expect near-zero breakage: functional style routes most
   element access through `map`/`reduce`/`sortBy`, so raw index sites are
   rare, and existing code that _relied_ on null-on-miss was already lying
   to the checker. Each such site migrates mechanically to `hasKey` guard,
   `lookup`, or `get`.
6. **Docs:** one line in `writing-jfn.md` §9 replaces the current runtime
   caveat:

   ```jfn
   // Reads are as strict as their types: a read typed T errors immediately
   // on a missing key / out-of-range index; only optional fields and
   // lookup/get read null. Absence is a bug -> index bare; absence is a
   // case -> lookup(m, k) or get(m, k, default).
   onHand: (inv: Inventory, sku: string) -> integer => get(inv, sku, empty).onHand
   ```

   Also delete the now-false "missing keys read as null" trip-up entry and
   drop the defensive-`!` guidance from the doc-changes plan (this change
   supersedes finding 1a there).

7. **Conformance tests:** in-range read, out-of-range error (message shape),
   missing-key error, optional-field null, `lookup` null, `get` default,
   tuple index, computed-key read, and one regression asserting the error
   fires at the index site inside a fold (the action-at-a-distance case).

## Acceptance criteria

- Runtime behavior of every read is derivable from its static type alone.
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
