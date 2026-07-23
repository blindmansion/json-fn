# Content-addressed value storage (v1: at-rest codec)

Status: proposed. This is the base plan; two follow-ups build on it —
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
immutable values, no reference identity, no cycles. json-fn passes all three by
construction — values are immutable JSON trees and structural `eq` is the only
equality. The guest cannot observe whether two equal subtrees are one blob or
two copies, so the representation choice is invisible. (Prior art: Unison for
content-addressed code/values; git and IPLD for the storage model.)

This also means the alternative — users threading an opaque pointer and
resolving it via `effects.store.get(...)` — is strictly worse ergonomically: it
forces effect plumbing through every function and turns state opaque to the
checker. Keeping values as values is the point of the language; the codec layer
is where this belongs.

## Design

### Canonical encoding and hashing

- Define **one canonical byte encoding** of a JSON value, RFC 8785 (JCS) style:
  object keys sorted, ES number-to-string formatting, UTF-8.
- Key-order canonicalization is mandatory, not optional: structural `eq`
  ignores object key order, so structurally equal values MUST hash equal.
- Hash: BLAKE3 or SHA-256 over the canonical bytes. Ref strings carry the
  algorithm prefix (`"b3:..."` / `"sha256:..."`) so the algorithm can be
  rotated later.
- Number edge cases inherit JCS behavior (`1.0` encodes as `1`, `-0` as `0`).
  This matches scalar `===` equality closely enough; note it in the spec text.

### Ref representation

Follow the `@task` precedent: a non-`$` tag key, so a ref classifies as plain
data and is never re-interpreted as an expression form:

```json
{ "@blob": "b3:9f2c..." }
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

### Store interface

Extend the workflow store with an optional blob side-table:

```ts
interface BlobStore {
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;   // idempotent
  getBlobs(hashes: string[]): Promise<Map<string, Uint8Array>>; // batched
  hasBlobs(hashes: string[]): Promise<Set<string>>;          // for write-skip
}
```

- `getBlobs` is batched by design — hydration of a deep DAG must not be one
  round-trip per node. The codec collects the full frontier of missing refs
  per level and fetches in waves.
- A store that does not implement `BlobStore` gets the current inline codec;
  the feature is opt-in per store. `InMemoryWorkflowStore` implements it
  trivially (a `Map`) so tests and examples exercise the path.
- `putBlob` is idempotent by content: writing an existing hash is a no-op
  (this is where cross-step and cross-workflow dedup comes from).

### Hydration points

Every place a stored record re-enters a runtime hydrates fully before use:

- `createDurableDriver` record load (resume, deliverCompletion, recovery scan);
- any host-level `serializeTask` / deserialize pairing that opts into the codec;
- (nothing else — `runTask` live mode never touches the codec).

Hydration failure (missing blob) is a terminal workflow failure with a new
failure code (`"blob-missing"`), distinct from `"contract"`/`"host"` — it means
the store violated its retention contract, and retrying cannot help.

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

### Idempotency / crash interaction

Blob writes must be persisted **before** the workflow record that references
them (write blobs, then record — the same ordering discipline the driver
already uses for suspension records). A crash between the two leaks orphan
blobs (cleaned by sweep), never a dangling record.

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
3. **Terminal-record retention** — how long do completed/failed workflows pin
   their blobs? Needs a store-level retention policy hook.
4. **Measurement first.** Before building: instrument the durable codec to log
   serialized record sizes and cross-record redundancy on realistic workloads.
   If real continuations are small, do
   [`module-identity-pinning.md`](module-identity-pinning.md) first — it
   shares the canonical-hash machinery and is valuable independently.
