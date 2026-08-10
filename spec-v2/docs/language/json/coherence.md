# Type/eval coherence

One schema dialect serves two consumers. The evaluator consumes a schema as a
**runtime test** — validation of a value at a declared position. The checker
consumes the identical schema as a **type**, reasoning by subsumption. The
checker's types and the evaluator's validators are the same objects: every
static concept has a runtime meaning by validation, and every runtime
dispatch-or-assert construct is defined over the dialect, so the checker
reasons about it with the machinery it already has.

This section states the invariant's two normative properties — erasability
and failure-at-declared-boundaries — and declares the dialect's **exactness
fragment** once, for every consumer.

## Runtime positions

The evaluator consults a schema only at **declared runtime positions**, and
at every one of them its semantics is schema validation:

- the `$type` of a
  [checked ascription](expressions.md#checked-type-ascription--as-type);
- the [boolean positions](expressions.md#boolean-positions) — validation
  against the boolean schema;
- `$runtimeContract` state on function values, including
  [capture-record validation at value boundaries](closures.md#validation-at-value-boundaries);
- contract edges — entry arguments and results, direct host-function
  arguments and results, effect arguments and results, and task completion
  values; see
  [Linking and enforcement](../../deployment/environment-contract.md#linking-and-enforcement);
- the result schema of the annotated total
  [`handle` form](tasks-and-effects.md#handle--interpreting-effects-in-language).

Every other schema in a program — `$type` on parameter slots, `$returns` on
bodies, `$types` declarations — is **static syntax** the evaluator never
reads (see
[Parameter and result types](functions.md#parameter-and-result-types--type-and-returns)).

## Erasability

**Checking never changes behavior.** A program evaluates to the same result,
raises the same errors, and consumes the same fuel whether or not it was
checked, and whether it is annotated or bare: inline types are static syntax
and [charge nothing](execution-limits.md#typing-is-free), and the runtime
positions above validate identically in checked and unchecked programs. No
checker-inferred fact may influence evaluation; coherence is achieved by
defining evaluator constructs over the shared dialect, never by making
evaluation depend on checking.

Erasability is what makes skipping the checker safe. A secondary
implementation may carry only the evaluator, and a durable workflow may
suspend on one host and resume on another that has no checker, with
identical semantics.

## Failure at declared boundaries

In a **checked** program — one the checker accepts — a runtime validation
failure at one of the positions above can fire only at a **declared trust
boundary**:

- a `checked as` ascription the author wrote;
- a contract edge, where data crosses to or from the host;
- an `any`-typed value reaching a runtime position, where the runtime
  validation is the fail-closed backstop.

The property is about validation, not partiality: arithmetic errors, access
misses, and resource limits are host errors a checked program can still
produce, but they are not contract errors and no schema is consulted.

Well-typed programs do not go wrong except where they said they might. The
posture that makes this attainable is fail-closed checking: when a use
cannot be proven, [checking fails rather than widening the subject to
`any`](narrowing.md#model), so the residue of unprovable positions is
visible in the program text — as `any` and as ascriptions — rather than
silent.

## The exactness fragment

Subsumption, subtraction, and exhaustiveness over the full dialect are
necessarily partial: the dialect has no negation, so subtracting one broad
schema from another often has no representable remainder, and refinements do
not survive arithmetic. Rather than scattering per-feature restrictions, the
dialect declares one **exactness fragment** — the sublanguage on which these
operations are exact:

- **booleans** — `boolean`, `true`, `false`, and unions of these; the
  then/else split of a boolean condition is a partition
  ([condition narrowing is exact](narrowing.md#1-boolean-subject));
- **`null | T` splits** — `null` is a runtime category, so excluding it is
  exact;
- **finite enums and literal unions** — pinning and excluding literals is
  membership surgery;
- **discriminated unions of closed objects**, discriminated by any field
  whose union arms are literal-covered, nested;
- **tuple-length splits**, with rest.

The fragment is a **ceiling on claimed exactness**, not a floor on consumer
behavior:

- **Off the fragment, no consumer claims exactness.** Narrowing produces no
  fact or leaves an unrepresentable remainder unchanged (the false branch of
  `isInteger` on `number` stays `number`); exhaustiveness is never
  concluded, so a dispatch off the fragment requires an explicit catch-all
  arm; nothing widens to `any`.
- **On the fragment, a consumer may still be more conservative.** The
  scalar [`$match`](expressions.md#scalar-value-match--match-cases-else)
  requires `$else` unconditionally — a consumer position stricter than the
  fragment permits, revisable without touching the fragment.

Refinement schemas — `format`, numeric bounds, named refinements such as
`Score = integer & min(0)` — sit deliberately half-in. As **validators**
they are exact: a runtime position tests the full refinement. As **types**
they contribute nothing to exactness: they erase to their base category for
coverage and subtraction, and
[arithmetic does not preserve them](expressions.md#checked-type-ascription--as-type);
re-establishing one after computation is an explicit `checked as` boundary.

Open data is correctly outside the fragment. The idiom is to validate at the
contract boundary — `checked as` into a closed declared type — and dispatch
exhaustively inside it, on the fragment.
