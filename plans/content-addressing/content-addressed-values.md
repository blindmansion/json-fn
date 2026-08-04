# Content-addressed value storage (v1: at-rest codec)

Status: partially implemented. The "Canonical encoding and hashing" section
(roadmap Phase 3) has landed in `typescript/src/hashing/` with cross-runtime
vectors in `spec/hash-cases/` and documentation in `docs/hashing.md`; the
codec, blob store, chunking, and GC remain gated on the measurement gate
below. This is the base plan; two follow-ups build on it —
[`module-identity-pinning.md`](module-identity-pinning.md) (cheap, high value,
can land with or immediately after v1) and
[`lazy-refs-and-cas-runtime.md`](lazy-refs-and-cas-runtime.md) (the deep
version, deliberately deferred).

## Summary

Durable workflow records currently persist every captured value inline. Two
costs follow from how the language works today:

1. **Substitution duplication.** Closure capture is by substitution, so a value
   referenced from N `$var` sites in an escaping continuation is inlined N
   times in the serialized record.
2. **Per-step duplication.** A workflow that threads a large state value
   through K suspension points persists K near-identical copies of it, one per
   stored continuation.

The fix is to Merkle-encode stored records: large subtrees are replaced at
serialization time by content-hash references into a blob side-store, and
resolved back to plain JSON on load. Equal content stores once; a state edit
between two suspension points stores only the changed subtrees plus the spine
above them (O(diff), the git model).

**This version is strictly a codec + store feature.** Refs exist only at rest.
Every value is fully hydrated before evaluation, so the guest, the checker, the
fuel model, `maxValueSize`, and the conformance suite are untouched. No
language-semantics change of any kind.

## Why json-fn can do this transparently

Content addressing is sound exactly when a value's identity is its content:
immutable values, no reference identity, no cycles. Language-produced values
are intended to be immutable JSON trees and structural `eq` is the only
equality, but host and persistence boundaries must validate rather than assume
that domain.

The persistence/hash boundary rejects cycles, non-finite numbers, `undefined`,
functions, symbols, non-JSON host objects, and strings containing unpaired
surrogates under the policy owned by
[`runtime-representation-gaps.md`](../runtime-representation-gaps.md). The
guest cannot observe whether two accepted equal subtrees are one blob or two
copies, so the representation choice is invisible. (Prior art: Unison for
content-addressed code/values; git and IPLD for the storage model.)

This also means the alternative — users threading an opaque pointer and
resolving it via `effects.store.get(...)` — is strictly worse ergonomically: it
forces effect plumbing through every function and turns state opaque to the
checker. Keeping values as values is the point of the language; the codec layer
is where this belongs.

## Design

### Measurement gate

Do not build or integrate the blob layer until representative durable
workloads measure:

- serialized logical record sizes by workflow state;
- repeated subtrees and closure-substitution expansion;
- changes between suspension records;
- hydration latency and peak memory; and
- expected blob read/write amplification under candidate thresholds.

Proceed only if those measurements show enough storage pressure or duplication
to justify the store and recovery complexity.

### Canonical encoding and hashing

- Define **one canonical byte encoding** of an accepted JSON value, RFC 8785
  (JCS) style: object keys sorted, ES number-to-string formatting, UTF-8.
  Reject unpaired surrogates before encoding; do not rely on a host UTF-8
  encoder's replacement behavior.
- Key-order canonicalization is mandatory, not optional: structural `eq`
  ignores object key order, so structurally equal values MUST hash equal.
- **`ValueHash`** is the semantic identity of the complete canonical guest
  value. It is domain-separated and versioned (for example `jfn:value:v1`) and
  is independent of chunk thresholds and physical layout.
- **`BlobHash`** addresses one physical blob encoding. It hashes a
  domain-separated, versioned payload that includes the codec and chunk-layout
  version. Its address records that domain/version as well as the algorithm,
  for example `jfn:blob:v1:b3:...`.
- A `ValueHash`, `BlobHash`, and deployment/component hash are distinct types
  and cannot be substituted merely because their digest algorithms match.
- Number edge cases inherit JCS behavior (`1.0` encodes as `1`, `-0` as `0`).
  This matches scalar `===` equality closely enough; note it in the spec text.

This encoder operates on arbitrary JSON **values**. It must never apply the
program-AST normalization described in `../raw-semantics-cleanup.md`: guest
data may legitimately contain `$raw`-shaped or otherwise expression-shaped
objects. Module identity owns its exact program projection; the current plan
hashes the normalized authored module before contract-derived injection.
Value hashing preserves the exact structural value it receives.

### Ref representation

Follow the `@task` precedent: a non-`$` tag key, so a ref classifies as plain
data and is never re-interpreted as an expression form:

```json
{ "@blob": "jfn:blob:v1:b3:9f2c..." }
```

**Escaping.** User data may legitimately contain a literal `"@blob"` key. The
codec (not the language) handles this: on encode, any *literal* object whose
key set includes `@blob` is wrapped as `{ "@lit": <object> }`; on decode,
`@lit` unwraps. The wrap/unwrap pair lives entirely inside the codec, is
applied bottom-up/top-down consistently, and is invisible to both guest and
host code. (`@lit` itself needs the same one-level self-escape.)

### Chunking policy

Bottom-up Merkle construction with a size threshold:

- Serialize leaves-first. When a subtree's canonical encoding exceeds a
  threshold `T` (default on the order of 1–4 KB, configurable per deployment),
  emit it as a blob and replace it in the parent with `{ "@blob": hash }`.
- Children already replaced by refs count at their ref size when measuring the
  parent, so a deep edit rewrites only the spine above it (O(depth) new blobs).
- Values smaller than `T` stay inline. This bounds read amplification and
  keeps small records exactly as they are today (zero blobs, zero behavior
  change for existing users).
- Deliberately **not** in v1: insert-stable array chunking (Prolly-tree style).
  A middle-insert into a huge array rewrites that array's chunk spine. Accept
  this until someone hits it; revisit only with evidence.

### Codec, envelope, and store ownership

The logical `WorkflowStore` continues to own validated logical workflow
records. Content addressing is implemented through an explicit physical
workflow envelope and a codec/store pair, not optional blob methods bolted onto
the logical interface.

- The **logical record** owns workflow semantics.
- The **codec** converts between one complete logical record and a versioned
  physical envelope plus blobs. It owns escaping, chunking, hash verification,
  and reconstruction.
- The **physical store** atomically persists envelopes and exposes idempotent
  blob put, batched get, enumerate, and delete operations.
- An **inline codec/store** remains available and has the same logical
  behavior, allowing stores to opt out without making the logical API
  conditional.

The physical envelope keeps revision, status, claim/lease metadata,
`deploymentId`, executable-world identity, root hashes, codec version, and
corruption classification inline. Status scans, revision checks, claims, and
deployment mismatch checks must not hydrate the logical payload.

Batched blob reads are required: hydration collects the full frontier of
missing references per level and fetches in waves. Blob writes are idempotent
by `BlobHash`.

### Hydration points

Every place a stored record re-enters a runtime hydrates fully before use:

- `createDurableDriver` record load (resume, deliverCompletion, recovery scan);
- any host-level `serializeTask` / deserialize pairing that opts into the codec;
- (nothing else — `runTask` live mode never touches the codec).

Hydration reconstructs fresh object identities, so runtime-value marks are
necessarily absent. The required order is:

1. fetch every referenced blob and verify its `BlobHash`;
2. decode refs and reconstruct the complete plain JSON record;
3. validate that record and all known task/continuation shapes;
4. restore runtime-value marks on task nodes and known continuation fields via
   the centralized hydration pass from `../raw-semantics-cleanup.md`; and
5. enter evaluation.

The blob codec serializes content only. It does not encode or restore runtime
identity marks or constant-expression cache metadata.

A missing or corrupt blob is store corruption by default. It becomes a
terminal `"blob-missing"` workflow failure only if the physical
envelope/store protocol can atomically persist that transition without
destroying a record that a repaired store could otherwise resume.

### GC and pinning

Content addressing makes liveness computable but someone must compute it:

- Each workflow record carries its **pin set**: the set of root hashes it
  references (cheap to collect during encode).
- Blob liveness = reachable from the pin set of any non-terminal workflow
  record (plus a configurable grace period for terminal records kept for
  audit).
- v1 ships a **mark-and-sweep utility** over the store (walk live roots,
  enumerate reachable hashes, delete the rest) rather than online refcounting.
  Refcounting under at-least-once delivery and crash-recovery is easy to get
  wrong; sweep is boring and safe. Stores may substitute their own strategy.
- The physical store contract therefore includes blob enumeration and deletion
  plus enumeration of every envelope retained as a GC root.
- Terminal records remain fully readable, and continue pinning their blobs,
  until the configured terminal-record retention policy deletes the record.
  `read()` must not silently degrade to metadata-only while the record itself
  is retained.

### Atomicity and crash interaction

Blob writes must be persisted **before** an envelope that references them.
Create, transition, and claim operations then atomically compare/update the
inline envelope metadata using the same revision and lease rules as the inline
store. A crash after blob writes but before the envelope commit leaks only
orphan blobs (cleaned by sweep); it never exposes a committed dangling
envelope. Claim paths must not require payload hydration.

## What this buys immediately

- O(diff) storage per suspension point instead of O(state).
- Substitution-duplicated captures collapse to one blob + N small refs.
- Cross-workflow dedup of shared config/reference data for free.
- Workflow history becomes diffable (two roots, shared subtrees) — useful for
  debugging and audit tooling later.

## Non-goals (v1)

- No refs inside the running evaluator; no lazy hydration. (Follow-up B.)
- No `eq` hash fast-path, no memoization. (Follow-up B.)
- No change to `spec/` conformance cases — this is host-layer only.
- No cross-host blob negotiation protocol (git-fetch-style "which blobs are
  you missing"); single-store deployments only. Note as future work.

## Open questions

1. **Threshold semantics** — per-deployment config only, or also a per-effect
   / per-entry override? Start with one knob in the deployment profile
   (host-local section, not portable), widen on demand.
2. **Hash in the profile or host config?** The chunking threshold and hash
   algorithm affect stored bytes but not behavior; they should live in host
   configuration, not the portable profile. Confirm this against the
   profile/contract ownership split.
3. **Terminal-record retention duration** — the store-level policy chooses the
   duration, but retained records pin blobs and remain fully readable as
   specified above.
4. **Measurement outcome.** If representative continuations are small, do not
   build this layer; proceed with
   [`module-identity-pinning.md`](module-identity-pinning.md), which shares the
   encoding/hash foundation and is valuable independently.
