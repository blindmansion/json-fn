# Plan: strict indexed reads and the `$get` redesign

Status: proposed; revised 2026-08-04. Earlier revisions held the canonical
`$get`/`$from` form fixed and compensated with new builtins. The type system
was added after the eval spec settled, and there is no
backwards-compatibility constraint, so this revision changes the access node
itself: the checker and the evaluator read the same author intent from the
same syntax, and the previously proposed `lookup`/defaulting builtins are
cancelled.

Make direct array, object, map, tuple, and string reads strict. Absence as a
case is expressed at the access site with an explicit lazy `$else` arm — not
inferred from checker-only required/optional field information, and not
routed through builtins.

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

A second, independent defect motivates redesigning the node rather than
working around it: today the evaluated key's **runtime shape selects the
operation** — a string is an object read, an integer is an array/string
read, and an array is a path walk. The checker recovers those cases
syntactically (literal path / literal scalar / computed key), but the
evaluator dispatches on the evaluated value, so a computed key that happens
to evaluate to an array silently becomes a path walk the checker never
modeled. Semantics dispatched on data shape is the class of behavior the raw
cleanup just removed elsewhere.

## Design

### Change 1: single-key domain; the array-path form is removed

An evaluated `$get` key must be **one string** (object property) or **one
integer** (array element / string code point). Any other evaluated key is an
immediate error. The array-path form is deleted from the canonical language.

- **Parser:** runs of static segments no longer fold into an array path;
  `a.b[0].c` lowers to nested `$get`s, one per segment. Callee lowering for
  method calls (`caps.db.query(sql)`) follows automatically, since it reuses
  the property-access lowering.
- **Printer:** nested static `$get`s fold back to the dotted/indexed path, so
  shorthand printback is unchanged. Normalizer stability
  (`parse(print(node)) = normalize(node)`) must hold for the new shapes.
- **Evaluator:** the per-node access logic loses the path branch, the
  missing-sentinel threading across segments, and the asymmetry where a
  missing segment short-circuited to `null` but traversal into a present
  `null` erred. Each `$get` is one read with one rule.
- **Checker:** the static-path projection loop is deleted; the
  literal-scalar and computed-key branches cover everything.
- **Fuel:** unfolding a path node into nested `$get`s changes node counts,
  which is observable under the settled strong fuel-determinism decision.
  This ships inside the same single breaking release, with the affected fuel
  spec cases updated alongside.

### Change 2: an optional lazy `$else` arm carries the absence policy

```json
{ "$get": "sku-42", "$from": { "$var": "inv" } }
{ "$get": "sku-42", "$from": { "$var": "inv" }, "$else": { "$var": "empty" } }
```

- A **bare** `$get` miss is an immediate error: absence is a bug.
- With `$else`, a miss evaluates the `$else` expression and yields its value:
  absence is a case. Evaluation is **lazy** — the arm is evaluated only on a
  genuine miss, consistent with the `$else` arms of `$if`, `$cond`, and
  `$match`.
- `$else` fires on **absence only**, never on a present `null` value. This
  preserves the absent / present-and-null distinction that motivated the
  change (Lua's `nil`-means-absent trap is the cautionary tale).
- The checker types `x[k]` as `T` and the `$else` form as
  `T | typeof(else-arm)` (collapsing when subsumed). `?? null` therefore
  types as `T | null` — the nullable lookup, with no builtin needed.

`$else` was chosen over `$or` because `$or` is already a canonical
short-circuit expression form; `$else` already means "the fallback arm"
everywhere it appears.

Canonical `$get` thus carries the evaluated target, the evaluated key, and
the author's absence policy — everything the evaluator needs, with no
checker-only schema information attached to evaluator nodes.

| Read site                                | Static type       | On absence            |
| ---------------------------------------- | ----------------- | --------------------- |
| `arr[i]`, `obj[k]`, `obj.k`, `text[i]`   | `T`               | immediate error       |
| bare read of a field declared `k?: T`    | **static error**  | (unreachable when checked; still an immediate runtime error) |
| `x[k] ?? d` (`$else` arm)                | `T \| typeof(d)`  | evaluates `d` lazily  |
| `x[k] ?? null`                           | `T \| null`       | `null`                |

Decision procedure to teach: _absence is a bug → bare access; absence is a
case → `?? default`._

### Semantics details

- **Arrays:** out-of-range (including negative) is an error naming the index
  and length.
- **Objects/maps:** missing key is an error naming the key and, when small,
  the available keys.
- **Optional object fields:** a bare direct read of a field declared `k?: T`
  is a **checker error** ("this field may be absent; add `?? default` or
  guard with `hasKey`"). `hasKey` narrowing lands in this change so
  guard-style access typechecks. The runtime rule is unchanged from every
  other bare `$get` — a miss errors — so the checker rule makes the runtime
  error path near-unreachable in checked code rather than being the
  enforcement mechanism. Declared optionality becomes meaningful instead of
  silently erased at the access site.
- **Tuples and closed objects:** computed reads that currently include
  `null` on possible misses migrate to a strict projected type or an
  explicit `$else`.
- **Strings:** integer indexing is in scope. An out-of-range code-point
  index errors under the same rule.
- **Errors are host errors** (same class as `checked as` failure /
  arithmetic error), not `raise`-catchable domain signals — absence under a
  `T`-typed bare read is by definition a bug.
- **`!` reverts to its narrow job:** stripping `null` from types that
  include it. After this change a `!` on a plain indexed read is dead code;
  consider a checker warning for `e!` where `e : T` with no `null` arm.
- **Writes/merges/spreads unchanged.** Only reads change.
- **Error payload:** include the key/index, access path, and a bounded
  container summary. Runtime source spans are not required for this change.
- **Constraints text:** `$get`/`$from` remain required and exclusive of other
  keys, except the optional `$else` and the common `$comment` rule.

### Surface / builtins

1. Shorthand: `x[k] ?? d` and `x.k ?? d` lower to the `$else` arm. `??` is
   unused in the grammar today. **Trip-up to document prominently:** unlike
   JS null-coalescing, `??` here fires on _absence_, not on a present
   `null`. (Spelling alternatives are an open question below; `else` as an
   infix keyword was rejected for ambiguity inside `if … then … else`.)
2. **No new builtins.** The previously proposed `lookup(m, k)` and
   `get(m, k, default)` are cancelled: `?? null` and `?? d` cover both, with
   lazy defaults and no naming-collision question.
3. Keep `hasKey`; add `hasKey` narrowing (required for guard-style
   optional-field access, per above).
4. Preserve the current nullable general signatures of `head` and `last`,
   plus their strict non-empty-array overloads. Audit other partial
   accessors for the same type/runtime agreement.

## What this supersedes

- The `lookup` / defaulting-builtin track and its naming open question.
- Roadmap Phase 5's "nullable/defaulting access operations" and the
  associated builtin work: both become the `$else` arm.
- Proposal 10 of `later/simplification-proposals.md` (absent vs null in
  `$get`) resolves here, as its post-review note anticipated.
- The per-path-segment strictness migration item: paths no longer exist as a
  single node, so per-segment behavior falls out of nesting.

## Implementation steps

1. **Spec first:** `language.md` (§ Property Access, § Constraints, the
   `$comment` sibling list),
   `docs/language/shorthand/function-calls-and-references.md` property-access lowering rules
   (callee lowering follows), `writing-jfn.md` guidance, and the trip-up list.
2. **Parser/normalizer/printer:** nested lowering for static paths, the `??`
   surface form, printback folding, and normalize-stability for the new
   shapes.
3. **Eval:** single-key strict access plus lazy `$else`; structured errors
   carrying index/key and a bounded container summary.
4. **Checker:** delete the path-projection loop; type the `$else` form as the
   union above; the optional-field bare-read error; `hasKey` narrowing; the
   dead-`!` warning if cheap.
5. **Conformance migration:** replace every null-on-miss property/path case
   and migrate the array-path forms (currently:
   `spec/cases/property-access.json` ×13, `spec/cases/regex.json` ×2,
   `spec/cases/method-calls.json` ×1, `spec/cases/parse/property-access.json`
   ×2, `spec/cases/parse/calls-references.json` ×1). Cover in-range access;
   array, string, object, map, tuple, closed-object, and optional-field
   misses; `$else` laziness (arm not evaluated on hit) and exact fuel;
   `?? null`; computed keys; a non-string/non-integer evaluated key erroring;
   and one regression asserting the miss error fires at the access inside a
   fold. Update fuel cases affected by path unfolding.
6. **Corpus migration:** run the checker+tests over `examples/*.jfn` and any
   internal corpora. Expect near-zero breakage: functional style routes most
   element access through `map`/`reduce`/`sortBy`, so raw index sites are
   rare, and existing code that _relied_ on null-on-miss was already lying
   to the checker. Each such site migrates mechanically to `?? default` or a
   `hasKey` guard.
7. **Docs:** one line in `writing-jfn.md` §9 replaces the current runtime
   caveat:

   ```jfn
   // Reads are as strict as their types: a bare read typed T errors
   // immediately on a missing key / out-of-range index. When absence is a
   // case, say so at the access site:
   onHand: (inv: Inventory, sku: string) -> integer =>
     (inv[sku] ?? empty).onHand
   ```

   Also delete the now-false "missing keys read as null" trip-up entry and
   drop the defensive-`!` guidance from the doc-changes plan (this change
   supersedes finding 1a there).

## Coordination

- Ship as **one semantic release**: runtime strictness, checker typing, and
  the lowering change must not straddle releases. Do not combine with the
  raw or content-addressing release units (roadmap rule).
- No hard dependency on `later/simplification-proposals.md` Proposals 1–3
  (function-value format / capture / let semantics), but both change pinned
  canonical and conformance surface and both are cheapest in the same
  pre-consumer window. Decide that design unit before or alongside this one
  so persisted-artifact-shape breaks land together rather than serially.

## Acceptance criteria

- Runtime absence behavior is derivable from canonical syntax alone; no
  checker-only information influences evaluation.
- The evaluator never dispatches on the shape of an evaluated key beyond
  string-vs-integer validity; no path walks exist at runtime.
- Checker projection and runtime behavior agree for required, optional, map,
  array, tuple, closed/computed-object, and string reads.
- Absence-as-a-case is explicit at the access site, lazy, and ergonomic;
  `?? null` fully replaces the cancelled `lookup` builtin.
- `examples/*.jfn` pass unchanged or with mechanical `?? default` /
  `hasKey`-guard migrations, each of which makes a previously implicit
  absence case explicit.
- A blind-authoring re-run produces zero defensive `!` on indexed reads and
  zero latent fail-slow sites: any absence bug fails at the exact line.

## Open questions

- Shorthand spelling: `??` is tentatively selected but carries a JS
  null-coalescing prior that conflicts with miss-only semantics; `?:` is the
  main alternative. Whichever is chosen, fix precedence (binds looser than
  access/call, tighter than comparison) and confirm chained defaults
  (`a[i] ?? b[j] ?? d`) associate as nested `$else` arms.
- Should tuple types get compile-time bounds checking on literal indices
  (making `pair[2]` a static error)? Cheap and consistent; recommended if
  tuple arity is already tracked.
- Whether the dead-`!` warning ships in this change or as a follow-up lint.
