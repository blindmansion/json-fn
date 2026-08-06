# Decision record: omitting non-final positional arguments

Status: **decision record, not active implementation work.** Literal `null`
remains supplied data, optional suffix parameters remain the positional
omission mechanism, object-pattern parameters remain the named-options
mechanism, and call-site holes remain deferred. Revisit only if authoring keeps
hitting the wall despite the shipped mitigations.

## The gap

Calls are positional and cannot skip a slot. The only value an author can
reach for to "skip" is `null`, and the language deliberately treats explicit
`null` as **supplied data**: it binds `null` and suppresses both omission
behaviors (optional → `null`, defaulted → lazy default). With typed
signatures, the omittable-slot annotation is the *supplied-value* schema, so
passing `null` to `b?: string` is also a checker error.

Consequences, verified against the TypeScript implementation:

- Given `f: (a: integer, b?: string, c?: integer) -> …`, there is **no way to
  supply `c` while omitting `b`** unless `b`'s annotation includes `null` —
  and even then the callee sees `null`, not an omission.
- Given `g: (a: integer, b: string = "B", c?: integer) -> …`, the default for
  `b` is **unreachable** from any call that supplies `c`. Untyped runtime
  confirms: `g(1, null, 3)` binds `b = null` (default suppressed); typed
  check rejects the call outright.

JS escapes this with `undefined` (which *does* activate defaults); Python
escapes it with keyword arguments. json-fn has neither, on purpose.

## Shipped mitigations (2026-07)

- **Checker diagnostic.** A literal `null` argument in an omittable fixed slot
  whose schema does not admit `null` now gets a targeted error explaining the
  omission model and pointing at the fixes (omit the argument / object-pattern
  parameter / nullable annotation). See the `call` case in
  `typescript/src/check/checker.ts`; test in
  `spec/cases/check/expressions/calls.json` ("explicit null for an omittable
  fixed slot…").
- **Authoring guideline** in `spec/docs/guides/writing-jfn.md` (§6 and the trip-up
  checklist): at most one trailing omittable positional parameter; a function
  with several independent optional knobs should take one object-pattern
  argument, whose fields omit independently.

The object-pattern idiom is the language's real named-arguments answer and may
be sufficient. This plan exists for the case where it is not.

## Constraints on any design

1. **`null` is never a sentinel.** A caller must be able to pass a literal
   `null` to a `T | null` parameter without triggering omission behavior.
   This rules out JS-style "null activates the default."
2. **Optionality is arity, not nullability.** `$sig.optional` records an
   omission contract; the annotation types the supplied value. A fix should
   extend *which* slots can be omitted, not blur what omission means.
3. **Canonical JSON stays simple and inert.** Whatever encodes "this slot is
   omitted" must be unambiguous in `$args`, survive serialization, and never
   be confusable with a runtime value.
4. **Shorthand bijectivity.** The surface form must lower deterministically
   and print back canonically.
5. **Holes must not become first-class.** "Omitted" is call-site syntax, not
   a value: it cannot be stored in a variable, returned from a function, or
   spliced in via spread/`apply` (a dynamic argument array contains values
   only). Otherwise omission leaks into the value universe as a second null.

## Candidate designs

### A. Status quo + idiom (current choice)

Do nothing further. Options objects handle multi-knob functions; a single
trailing optional handles the rest. Cost: evolving an existing positional
signature by appending optional parameters degrades gracefully, but *middle*
insertion or several independent knobs force a signature migration to an
object pattern.

### B. Call-site holes (the plausible future change)

Surface: something like `f(a, _, c)` meaning "slot 2 is omitted." The callee's
own omission semantics apply: optional slot → binds `null`, defaulted slot →
lazy default, required slot → error (statically and at runtime).

Design points if pursued:

- **Token.** `_` is currently a legal identifier (and `_index` is the
  documented ignored-param convention). A bare `_` *in argument position
  only* could be contextual, but shadowing hazards argue for a keyword
  instead — e.g. `f(a, omit, c)` or `f(a, default, c)` — or a non-identifier
  token. Decide with printer round-trip in mind.
- **Canonical JSON.** `$args` needs an inert marker element, e.g.
  `{ "$omit": true }`, rejected everywhere except as a direct element of a
  literal `$args` array (mirroring how `$fields` is only legal as a `$params`
  slot). Evaluator, checker, and printer all treat it structurally; `$raw`
  data containing the key is unaffected.
- **Arity model.** Today omission is suffix-only: a call supplies a
  contiguous prefix. Holes generalize omission to any omittable slot. The
  arity check becomes: every non-hole fixed argument checks against its
  slot's supplied-value schema; a hole in a required slot is an error;
  holes may not appear in the rest region; trailing holes normalize away on
  printback (so `f(a, _)` prints as `f(a)`).
- **`$fnType` unchanged.** The callable contract (`required`/`optional`/
  `rest`) already expresses per-slot omittability; holes only widen which
  call shapes exercise it. Subsumption rules need no change.
- **Boundary calls.** Entry invocation at the environment boundary passes a
  JSON array of values, which cannot contain holes (constraint 5). If entry
  contracts ever need mid-list omission, that is a separate contract-shape
  question — do not couple it to this change.
- **Conformance.** New spec cases: hole in optional slot, hole in defaulted
  slot (default observed lazily), hole in required slot (error), hole in rest
  region (error), hole via spread (error), printer round-trips including
  trailing-hole normalization.

### C. Keyword arguments — rejected

`f(a, c: 3)` collides with data-object syntax, breaks the "calling convention
is always positional" simplification that object patterns rely on, requires
names in `$args` canonical form, and duplicates what object patterns already
provide at both call and declaration sites.

### D. `null` activates defaults — rejected

Violates constraint 1: makes `null` a sentinel, silently changes the meaning
of existing calls that pass `null` to `T | null` defaulted params, and
reintroduces exactly the JS `undefined`/`null` ambiguity the language was
designed to avoid.

## Recommendation

Stay on **A**. Collect evidence: when agent-authored modules hit the targeted
diagnostic, note whether the fix was trivial (drop the argument / options
object) or a genuine restructuring burden. If the burden shows up repeatedly,
open a new plan for **B**; do not implement from this sketch alone. That plan
must settle builtin calls, canonical marker validation, trailing-hole
normalization, arity and `$fnType`, `apply`/spread behavior, and environment
entry boundary arrays. Call-site holes remain the only candidate here that
extends omission without touching the value universe or callable contract.
