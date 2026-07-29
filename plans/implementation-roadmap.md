# Implementation roadmap

Status: active; reconciliation pre-step completed

## Summary

This is the cross-plan implementation order for the foundational,
representation, and durable-host work currently described under `plans/`.

The roadmap deliberately does not duplicate the detailed design of each
individual plan. Those documents remain the owners of their respective
semantics and acceptance criteria.

The dependency spine is:

1. reconcile the plans;
2. establish representation and integrity invariants;
3. separate raw syntax, runtime values, and static-cost metadata;
4. establish canonical encoding and semantic hashing;
5. pin durable deployments by executable-world identity;
6. add eager at-rest content addressing only when measurements justify it; and
7. consider evaluator-level lazy refs only after eager storage has shipped and
   demonstrated a real bottleneck.

Strict indexed reads are a separate semantic branch. Small syntax and
documentation fixes are an unordered side track.

## Pre-step: reconcile the plans

**Completed.** [`plan-reconciliation.md`](plan-reconciliation.md) and the
individual owning plans now describe one compatible architecture.

That pass updates the individual plan documents to:

- assign one owner to each concern;
- correct stale assumptions;
- distinguish hard prerequisites from convenient ordering;
- make strict reads runtime-representable;
- align hashing, storage, and module-identity terminology; and
- record the architecture decisions that must precede implementation.

No foundational implementation phase should begin while its owning plan still
conflicts with the reconciliation document.

## Goals

- Make language behavior independent of accidental JavaScript object and stack
  behavior.
- Give canonical `$raw`, runtime-produced values, and static-cost metadata
  distinct semantics and APIs.
- Ensure parsing route, serialization, and cache state do not alter values,
  errors, or deterministic fuel.
- Establish canonical JSON hashing that is safe for both guest values and
  versioned deployment identity.
- Prevent silent semantic drift when durable workflows resume.
- Introduce content-addressed storage only behind a measured need and a sound
  store protocol.
- Keep lazy runtime representations from leaking into language semantics or
  deterministic limits.
- Allow independent authoring improvements to proceed without coupling them to
  the foundational roadmap.

## Non-goals

- Do not reconcile the Go, Python, or Rust implementations during these
  TypeScript-first phases.
- Do not treat every parked authoring idea as committed work.
- Do not build lazy refs merely because the eager blob codec exists.
- Do not add workflow version routing or migration hooks as part of identity
  pinning.
- Do not make storage chunking observable to guests through values, errors, or
  fuel.
- Do not combine strict reads with the raw or content-addressing changes into
  one release unit.

## Operating principles

### One semantic owner

Each phase implements the design in its owning plan. Cross-cutting work should
link to that plan rather than growing a second competing specification.

### Determinism before normalization

A program form may normalize away only after the original and normalized forms
have equal results, errors, and deterministic resource accounting.

### Program syntax is not arbitrary data

Program normalization and canonical JSON-value encoding are separate APIs.
Guest data may contain objects that resemble `$raw`, `$var`, or any other
expression form.

### Physical storage is not semantic identity

Chunk thresholds, codec versions, and blob layout must not define guest-value
equality. Semantic hashes and physical blob addresses have distinct domains.

### Measurement gates optional architecture

Instrumentation may begin early. Storage and evaluator complexity should be
added only when measurements show the corresponding cost exists.

## Phase 0: settle shared invariants

Owners:

- [`runtime-representation-gaps.md`](runtime-representation-gaps.md)
- [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md)
- [`content-addressing/content-addressed-values.md`](content-addressing/content-addressed-values.md)
- [`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md)

The following shared invariants are settled:

- portable guest values are finite, acyclic JSON trees; validation rejects
  unsupported host values and ill-formed surrogate strings before persistence
  or hashing, and language operations must not produce malformed strings;
- every guest-object key is an own enumerable writable data property;
- program normalization is context-sensitive and separate from canonical
  encoding of arbitrary guest values;
- semantic value hashes, physical blob hashes, and executable-world identities
  occupy distinct versioned domains; any exact authored-artifact hash selected
  below must occupy a fourth domain;
- operator `deploymentId` remains a broader namespace and compatibility
  boundary rather than being replaced by automatic identity; and
- deployment drift is rejected without claiming or mutating the workflow by
  default.

The following Phase 0 decisions are settled:

- **Fuel meaning and exact literal accounting (decided: stable virtual
  cost).** Fuel measures a stable virtual cost — a pure function of the
  program, its inputs, and recorded effect results — independent of caches,
  serialization, and ingestion route. Caches, skipped traversals, and lost
  metadata may change host preparation time only, never fuel, results, or
  errors. The normative static-literal cost function and `$raw` equation are
  specified in [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md):
  evaluating a constant literal charges one unit per JSON value node of the
  produced value, and `$raw` charges `staticLiteralCost(payload)` in total, so
  quotation cannot reduce deterministic fuel.

The remaining Phase 0 decisions are:

1. **Permanent structural-depth contract.** Decide whether a portable
   structural-depth limit is the language contract or only an implementation
   step toward accepting arbitrary depth subject to fuel and value-size
   limits. The selected contract covers parser, checker, evaluator, closure,
   printer, normalization, hashing, validation, and hydration traversals.
2. **Authored-artifact versus normalized program identity.** Decide whether
   durable records retain both an exact hash of the reviewed authored artifact
   and a normalized semantic module hash, or only one of them. Do not use
   program normalization for arbitrary guest values.
3. **Executable-world projection.** Decide the exact automatic identity
   inputs: full builtin table versus a proven referenced subset, which portable
   limits and policies count as semantic, and how operator `deploymentId`
   attests compatibility of executable adapters that cannot be hashed
   automatically.

In parallel, add non-sensitive instrumentation for:

- serialized logical record sizes by state;
- repeated subtrees and closure-substitution expansion;
- record changes between suspensions;
- hydration time and peak memory; and
- expected blob read/write amplification under candidate thresholds.

The encoder/hash library may be prototyped during this phase, but module
identity must not be finalized until the remaining artifact/semantic identity
and executable-world projection decisions are settled and normalization is
stable. The fuel decision above is settled and no longer blocks this.

### Gate

Proceed when representative program values, host values, task records, and
durable records each have:

- one valid representation category;
- one defined validation and hydration path;
- deterministic depth/fuel behavior; and
- an unambiguous hash domain, if they are hashed.

## Phase 1: representation integrity

Owner:
[`runtime-representation-gaps.md`](runtime-representation-gaps.md)

Land the safe arbitrary-key construction work first.

Use one shared own-property mechanism for every path that constructs an object
from guest-controlled keys. Cover the parser, evaluator, closure transforms,
checker property maps, standard-library transforms and grouping, task/workflow
serialization, environment construction, and future codecs.

Implement enough of the selected structural-depth policy that later raw,
normalization, hashing, and hydration work cannot introduce undocumented host
stack failures. This may be a portable conservative limit first or iterative
walks in the affected paths.

Complete or explicitly defer the remaining Unicode performance/metering work.
The canonical-encoding string policy from Phase 0 must be settled before the
hashing phase.

### Gate

- Special keys such as `__proto__` survive every relevant round trip.
- New generic traversals cannot fail first with a host `RangeError`.
- The accepted string domain has one deterministic byte-encoding policy.

## Phase 2: raw and runtime-value cleanup

Owner: [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md)

Implement the revised phases from that plan:

1. characterize host arguments/results, closures, task construction,
   serialization, hydration, and exact current fuel;
2. replace overloaded raw predicates with precise runtime-value APIs;
3. extract constant-expression cost metadata into a non-semantic facility;
4. centralize task/workflow runtime-value restoration;
5. make `$raw` charge its specified static literal cost regardless of ingestion
   route or cache state;
6. atomically introduce shorthand raw inference, remove the `raw` keyword, and
   update printer normalization; and
7. migrate checker wording, task code, examples, docs, tests, and performance
   instrumentation.

Any new structural traversal must follow the depth policy established in
Phase 1.

### Gate

For representative ordinary literals, quoted expression-shaped data, closures,
tasks, and hydrated workflow records:

- shorthand evaluation;
- shorthand-to-canonical serialization followed by evaluation; and
- independently supplied canonical JSON

must produce equal values, errors, and exact fuel usage.

Losing weak metadata across serialization may affect preparation time, but not
guest-observable behavior.

## Phase 3: canonical encoding and hashing

Primary owner:
[`content-addressing/content-addressed-values.md`](content-addressing/content-addressed-values.md)

Program-normalization input:
[`raw-semantics-cleanup.md`](raw-semantics-cleanup.md)

Build the shared, versioned hashing foundation:

- canonical JSON bytes for accepted guest values;
- domain-separated semantic value hashes;
- versioned physical blob hashes;
- component and aggregate deployment hash helpers; and
- cross-runtime-independent test vectors for key ordering, number spelling,
  Unicode, special keys, and expression-shaped data.

Integrate the program normalizer only for program identity. Never apply it to
arbitrary guest values.

No blob store is required in this phase.

### Gate

- Structurally equal accepted values have equal semantic hashes.
- Codec/chunk configuration cannot change semantic value identity.
- Program normalization preserves results, errors, and deterministic limits.
- Program normalization cannot rewrite expression-shaped guest data.

## Phase 4A: durable module identity

Owner:
[`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md)

This is the preferred first consumer of the hashing layer because it prevents
silent durable semantic drift without requiring a blob store.

Implement:

- versioned component identities at deployment preparation;
- an aggregate executable-world identity;
- persisted original component identity on every workflow variant;
- compatibility handling for old records;
- bounded audit history for explicitly allowed drift; and
- non-mutating mismatch rejection by default.

Retain `deploymentId` as the operator-controlled namespace and broader
compatibility signal. Automatic identity covers the portable world defined by
the plan; it does not prove behavioral equivalence of executable adapters.

### Gate

- A resumed workflow cannot silently switch executable worlds.
- Drift diagnostics identify the changed component.
- Attempting resume under the wrong deployment does not terminally mutate a
  workflow that a correct deployment could resume.
- Claim, revision, recovery, and cross-driver tests preserve identity metadata.

## Phase 4B: eager at-rest content addressing

Owner:
[`content-addressing/content-addressed-values.md`](content-addressing/content-addressed-values.md)

This phase is conditional. Start it only if Phase 0 measurements show enough
record duplication or storage pressure to justify the operational complexity.

Before integrating blobs, finalize:

- the versioned physical workflow envelope;
- ownership between logical workflow records, the codec, and physical stores;
- atomic create/transition/claim behavior;
- semantic-value versus physical-blob hashes;
- escape handling for literal codec tag keys;
- corruption and missing-blob behavior;
- blob enumeration/deletion and mark-and-sweep roots;
- terminal record retention; and
- store upgrade/version compatibility.

Ship refs strictly at rest. Fully reconstruct, validate, and restore runtime
marks before evaluation.

The codec implementation can be developed in parallel with Phase 4A after
Phase 3, but durable record/store integration should be serialized because both
features alter the same closed record variants and claim paths.

### Gate

- Codec-enabled and inline stores are guest-observationally identical.
- Crash points produce at worst reclaimable orphan blobs, never committed
  dangling records.
- Hash verification and missing-blob behavior are deterministic.
- GC preserves every record promised readable by the durable-host contract.
- Production-like measurements show the expected storage benefit without
  unacceptable read amplification or recovery latency.

## Phase 5: strict reads semantic branch

Owner: [`strict-reads.md`](strict-reads.md)

This phase is independent of Phases 2–4 and may be scheduled when its revised
design is ready. It is listed here before lazy refs because property access is
a primary lazy-forcing chokepoint; settling read semantics first avoids
designing forcing around behavior that will immediately change.

Implement the selected canonical/runtime model as one semantic change:

- checker projection;
- evaluator property access;
- nullable/defaulting access operations;
- builtin signatures and implementation;
- shorthand/canonical lowering if a new operation is selected;
- docs and authoring guidance; and
- conformance and example migration.

Do not split runtime strictness from checker typing across releases.

### Gate

- Every runtime absence behavior is derivable from canonical syntax and
  information actually available to the evaluator.
- Static types and runtime behavior agree for required, optional, map, array,
  tuple, computed-object, and explicitly scoped string reads.
- Nullable/defaulting absence is explicit and ergonomic.

## Phase 6: lazy refs and runtime CAS

Owner:
[`content-addressing/lazy-refs-and-cas-runtime.md`](content-addressing/lazy-refs-and-cas-runtime.md)

Do not schedule this phase merely because Phase 4B shipped.

Its entry gates are:

- eager CAS is deployed and measured;
- hydration latency or memory duplication is a demonstrated bottleneck;
- runtime-value/static-cost separation is stable;
- semantic value hashes and module identity are available;
- asynchronous forcing architecture is selected;
- an unforgeable internal ref representation is specified;
- deterministic fuel behavior is specified independently of storage chunking;
- builtin and validator forcing depths are audited; and
- memoization has a transitive purity and fuel model.

Consider an eager-hydration hash attachment for equality as a smaller separate
experiment only if it preserves the same semantic and fuel invariants.

### Gate

- Guests and ordinary hosts cannot observe ref versus inline representation.
- Store latency and chunk boundaries cannot silently alter portable fuel.
- Every structural builtin, validator, logger, effect boundary, and return
  boundary has an explicit forcing rule.
- Any memoized execution is valid under the same executable-world identity and
  has defined result, failure, and fuel behavior.

## Unordered side track

The following plans do not depend semantically on the foundational spine and
may land whenever review and merge-conflict risk are favorable:

- [`effects-binding-scope.md`](effects-binding-scope.md): documentation-only
  correction;
- [`leading-pipe-unions.md`](leading-pipe-unions.md): isolated type-shorthand
  grammar; and
- [`module-where-blocks.md`](module-where-blocks.md): module-body parser and
  printer improvement.

Shared edits to parser files or authoring docs are coordination concerns, not
dependency edges.

Keep these deferred:

- [`positional-omission.md`](positional-omission.md): retain the current
  options-object guidance unless new evidence justifies call-site holes; and
- [`future-authoring-improvements.md`](future-authoring-improvements.md):
  evaluate each parked idea through its own future plan rather than adding it
  to this roadmap wholesale.

## Hard dependency graph

The required edges are:

- Plan reconciliation precedes implementation of every affected plan.
- Safe object construction precedes raw inference and generic codec
  reconstruction.
- A depth policy precedes any new traversal that would otherwise expose host
  stack limits.
- `$raw` fuel equivalence precedes program normalization that removes `$raw`.
- Canonical encoding precedes semantic value hashes and automatic deployment
  identity.
- Program normalization precedes normalized module identity.
- Eager CAS precedes lazy runtime refs.
- Semantic value hashes precede ref equality shortcuts.
- Module identity precedes durable memoization.
- A settled read model should precede lazy property-access forcing.

The following are not hard dependencies:

- Module identity does not require a blob store.
- Canonical value encoding does not require full program normalization.
- Strict reads does not require raw cleanup or content addressing.
- The unordered syntax/docs plans do not require any foundational phase.

## Verification strategy

Each owning plan retains its detailed acceptance criteria. Across phases, also
maintain these system-level checks:

- Run TypeScript typecheck, lint, formatting, and tests after each landable
  phase.
- Add shared conformance only for language semantics; keep storage-only codec
  behavior in durable-host tests.
- Test exact fuel at boundaries, not only successful results.
- Test both direct in-memory values and serialize/hydrate round trips.
- Exercise fresh-runtime and cross-driver durable resume.
- Include adversarial JSON keys, deep structures, expression-shaped data,
  non-finite/cyclic host values, and the selected surrogate policy.
- Preserve crash recovery, stale-delivery, revision-conflict, and atomic claim
  behavior while durable record formats evolve.
- Compare codec-on and codec-off execution outcomes for the same logical
  records.

## Completion

The roadmap is complete when:

- host representation no longer causes silent JSON-key loss or undocumented
  stack behavior in the covered paths;
- raw syntax, runtime values, and static-cost metadata are separate;
- serialization route and cache loss do not alter deterministic semantics;
- canonical hashing and program normalization have distinct, tested domains;
- durable resume detects executable-world drift safely;
- eager CAS, if justified and enabled, remains entirely at rest;
- lazy refs are either rejected by measurement or implemented behind all
  stated gates; and
- independent authoring work remains independently reviewable.
