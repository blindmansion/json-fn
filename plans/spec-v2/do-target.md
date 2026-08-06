# celld / Durable Objects as a primary durable-host target

Status: proposed. Records how a celld (or Cloudflare Durable Objects)
deployment changes the assumptions, priorities, and value calculus of the
content-addressing plans. The three existing plans —
[`content-addressed-values.md`](content-addressed-values.md) (v1),
[`module-identity-pinning.md`](module-identity-pinning.md) (follow-up A), and
[`lazy-refs-and-cas-runtime.md`](lazy-refs-and-cas-runtime.md) (follow-up B) —
remain platform-neutral and own their semantics. This document owns the
DO-shaped deployment profile of that work: which of their assumptions invert
on this target, which motivations strengthen, and which options exist here
that exist nowhere else.

Nothing in this document changes language semantics, the conformance suite,
or the logical `WorkflowStore` contract.

## Target platform, in the terms that matter here

celld runs Cloudflare Workers and Durable Objects on operator-owned machines.
The storage properties this plan depends on:

- **One SQLite database per cell.** Each durable object is its own SQLite
  database, addressed by name. There is no shared database across cells;
  applications shard by construction.
- **Single writer, epoch-fenced.** Object-storage compare-and-swap gives each
  cell exactly one owning node at a time. All access to a cell's state is
  serialized through that owner.
- **RPO=0 replication on the acknowledgment path.** Writes are durably
  replicated (LTX to an S3-compatible bucket) _before_ they are acknowledged.
  Region-local durable write latency is on the order of ~90 ms.
- **Hibernation to object storage.** An idle cell's recurring cost is the
  bucket footprint of its database. Wake is milliseconds.
- **Memory density.** Resident cells cost ~4 MB baseline; density
  (cells per node) is a first-class operational currency.
- **Synchronous local storage API.** The DO SQLite storage API is
  synchronous; reads against the cell's own database do not cross an async
  boundary.
- **One application per fleet, rolling deployments.** Every node loads the
  latest committed deployment. There is no fleet-level side-by-side
  versioning of worker code.

The recommended workflow mapping, assumed throughout: **one workflow per
cell**, cell name derived from the workflow ID. Variants (small fixed sets of
workflows per cell) inherit the same conclusions.

## 1. The v1 physical store is the workflow's own cell

The base plan's codec/store split assumes blobs and envelopes may not share a
transaction, and therefore specifies: blob writes persist before the envelope
that references them; a crash between the two leaks orphan blobs; sweep GC
cleans orphans; a missing blob is store corruption.

On this target, the v1 physical store is the workflow cell's own SQLite
database — envelope row(s) and a blob table in the same database. That yields
a stronger property than the plan requires:

- **Single-transaction commit.** Blobs and the envelope that references them
  commit in one SQLite transaction. The ordering rule is satisfied
  degenerately; the orphan window does not exist; a committed envelope cannot
  dangle.
- **Corruption classification simplifies.** "Missing blob" ceases to be an
  expected crash artifact and becomes what it should be: genuine store
  corruption, as rare as SQLite corruption itself.
- **GC is local and bounded.** The pin set and the blob table live in one
  database covering one workflow's history. Mark-and-sweep collapses to a
  local query over that database, cheap enough to run opportunistically on
  terminal transitions or from a DO alarm. The plan's store-wide sweep
  utility remains correct here but is no longer doing distributed work.
- **Claim machinery is partially subsumed.** The store protocol's
  revision/claim/lease rules defend against contended multi-writer stores.
  celld's epoch-fenced single writer serializes all access to the cell, so
  the claim path reduces to a revision check inside the cell. External
  at-least-once delivery semantics (effectId dedup, stale-delivery rejection
  after a claim) are unchanged — those defend against the _world_, not the
  store.

The inline codec/store escape hatch from the base plan is retained unchanged:
a deployment that fails the measurement gate runs the same logical store with
inline records in the same cell database.

### What this costs: cross-workflow dedup is demoted

The base plan lists cross-workflow dedup of shared config/reference data as a
free win. Per-cell isolation takes exactly that away: equal content in two
workflows stores twice, once per cell. This is accepted for v1, for the same
reason celld accepts it — shared state is the thing this architecture designs
out.

The intra-workflow wins — the plan's two headline costs — are fully
preserved: substitution duplication collapses within a record, and per-step
duplication collapses across a workflow's suspension records, because all of
a workflow's records share one blob table.

Cross-workflow dedup returns, if ever, as a later **two-tier store**: the
cell-local store remains authoritative, and large or widely shared blobs are
promoted to a shared content-addressed tier (a dedicated CAS cell, or a
content-addressed prefix in the fleet bucket — write-once objects keyed by
`BlobHash` need no coordination to write). The codec/physical-store
abstraction already permits this substitution without semantic change. A
shared tier reintroduces distributed GC and cross-cell reads on the hydration
path; it must clear its own measurement gate. The base plan's v1 non-goal
("no cross-host blob negotiation; single-store deployments only") is
unaffected: the cell-local store is a single store per workflow.

## 2. New motivations the base plan does not list

The base plan justifies Merkle encoding by at-rest storage pressure and
gates on measurement. This target adds two costs that are structural, not
speculative, and one of them sits on the latency-critical path.

- **Acknowledgment-path write amplification.** RPO=0 means every suspension
  record replicates before the suspension is acknowledged. A workflow that
  threads a large state value through K suspension points does not merely
  _store_ K near-copies — it _replicates_ K near-copies, each on the ack path
  of its own suspension. O(diff) encoding is therefore a suspension-latency
  feature on this target, not only a storage feature.
- **Hibernation is priced by at-rest bytes.** A hibernated cell's recurring
  cost is its bucket footprint. Per-step duplication multiplies the monthly
  cost of every sleeping workflow — and long-sleeping workflows are the
  workload this host exists for.
- **(For follow-up B) memory density.** See §4.

### Measurement gate, made concrete

The base plan's gate metrics remain. On this target they acquire directly
instrumentable forms, which candidate deployments should record:

- durable-write bytes and ack latency per suspension transition, inline codec
  vs. blob codec;
- hibernated database size per workflow state (the bucket footprint);
- hydration latency and peak JS heap at cell wake;
- blob read amplification at candidate thresholds `T`, measured in local
  SQLite reads (see §4 — the reads are local here, which moves the
  amplification cost from network round-trips to page cache pressure).

The gate's decision rule is unchanged: if representative continuations are
small, do not build the blob layer; proceed with module identity pinning,
which is independently valuable and (per §3) _more_ urgent on this target.

## 3. Module identity pinning: more urgent, and one new policy option

Follow-up A frames the hazard as the month-1 suspension resumed in month 3.
On this target the exposure is much wider: a fleet rolls forward as one
application, and hibernation/wake is the _normal_ duty cycle, not a rare
recovery. Every wake after any deploy is a potential world change. Two
consequences:

- **Check identity at wake.** The stored deployment identity hash is compared
  against the current world's on every cell wake that will advance the
  workflow, not only on explicit resume/recovery paths. The check is a hash
  comparison against inline envelope metadata; it must not hydrate the
  payload (the base plan's envelope rules already guarantee this is
  possible).
- **Mismatch is a mainstream path, not an edge case.** The driver policy
  (reject / accept / operator-mediated) should be a first-class part of the
  DO host's configuration surface, with reject as the default, exactly as
  follow-up A specifies.

### Resume-under-pinned-world

This target admits a policy option follow-up A does not currently name, and
which code-versioned platforms cannot offer: **resume the in-flight workflow
under the world it was suspended in.**

It is possible here because the components of the deployment identity are
almost entirely _data_: the normalized authored module, the environment
contract, and the portable profile projection are JSON, and the module is
executed by an interpreter, not deployed as worker code. A cell can therefore
retain (content-addressed, in its own blob table — these artifacts are the
first and best customers of the v1 store) the exact module/contract/profile
projection it suspended under, and the durable host can link and run that
pinned world for in-flight workflows while new workflows take the current
deployment.

The unhashable residue identified by follow-up A bounds this precisely, and
those bounds are adopted here unchanged:

- The **engine/stdlib semantic version** is an identity component that is
  _not_ data. If the current interpreter's semantic version differs from the
  pinned one, resume-under-pinned-world is unavailable and the policy falls
  back to reject/accept. (A fleet could in principle carry prior interpreter
  builds via runtime isolate loading; that is out of scope here and gated on
  that mechanism maturing.)
- **Adapter compatibility remains attested by `deploymentId`**, exactly as
  settled in follow-up A. Resuming under a pinned module does not relax the
  operator's obligation that the live adapter is behaviorally compatible with
  that workflow's `deploymentId`, and `deploymentId` remains outside the
  identity hash.

Scope note: this section proposes an _addition to follow-up A's policy
enumeration_ ("reject / accept" gains "resume-pinned" where the engine
component matches). The identity projection itself — what gets hashed — is
untouched.

A natural integration point: compute the deployment identity hash at
`celld deploy` time and publish it alongside the deployment artifact in the
bucket, so the wake-time check compares two precomputed hashes and drift is
visible in deployment tooling, not only in workflow failures.

## 4. Follow-up B: the async blocker dissolves; re-scope as partial hydration

Follow-up B's first unresolved architecture requirement is that blob reads
are asynchronous while evaluation is synchronous, forcing a choice between
async evaluation, complete prefetch, a synchronous cache, or a new suspension
mechanism.

On this target, with the v1 store in the cell's own database, that choice is
made by the platform: **the synchronous local cache is the storage itself.**
Forcing a ref is a synchronous local SQLite read through the DO storage API.
No async evaluation, no new suspension mechanism, no separate cache layer
with its own coherence story.

This does not unblock follow-up B wholesale. The remaining blockers stand
unchanged and are restated here so this document cannot be read as a green
light: unforgeable runtime ref representation; `ValueHash`-only equality
evidence; the `maxValueSize` boundary audit; transitive-purity rules for
memoization; the builtin/validator forcing-depth audit. The former fuel
blocker — portable fuel that does not leak chunk thresholds or cache warmth —
is dissolved by the Stage 1 event-trace cost model: size-dependent charges
are computable from blob metadata, so a lazy-ref runtime charges
inline-equivalent fuel by construction. The base plan's ordering also
stands: v1 ships and is measured first.

What changes is the _framing and the payoff ranking_. On this target,
follow-up B's most valuable capability is **partial hydration**, and its
justification is memory density: resident-cell memory is the currency of a
celld node, and a workflow whose continuation reads `state.cursor` should not
materialize a 50 MB `state.history` into the JS heap at wake. Cells-per-node
is the measurable outcome. The `eq` fast-path and memoization remain real but
secondary on this target, and nothing here advances their blockers.

Recommended re-scope, when v1 measurements justify going further: a
DO-native partial-hydration milestone — lazy refs, synchronous forcing
against cell storage, no equality fast-path, no memoization — rather than the
full content-addressed-runtime program in one step.

## 5. Interactions and invariants to preserve

- **Envelope metadata stays inline.** Status scans, revision checks, wake-time
  identity checks, and deployment-mismatch checks read inline envelope
  metadata only. Nothing on the wake path may require payload hydration.
  (Restates the base plan's envelope rule; wake frequency on this target is
  why it is worth restating.)
- **The codec remains host-layer.** No `spec/` conformance case changes; the
  guest cannot observe ref vs. inline. All of §1–§4 lives below the language.
- **Thresholds are host-local.** The chunking threshold `T` and hash/storage
  configuration stay in host configuration, not the portable profile,
  consistent with the base plan's open question 2 and the profile's
  exclusion of host-local controls. A per-cell-store deployment may want a
  lower `T` than a networked-store deployment, since read amplification is
  local; that is a host tuning decision with no portable footprint.
- **Fuel is settled by the Stage 1 cost model.** Charges that depend on a
  value's measures (value production, static data, re-entry) are computable
  from blob metadata without hydration, so local reads change host time
  only, never fuel. Follow-up B needs no virtual-charge schedule and no
  non-portable profile.
- **Hash foundation is shared.** All addresses here use the canonical
  encoding and domain-separated `jfn:*` hash framing from
  `docs/runtime/hashing.md`; this document introduces no new hash domains.

## Open questions

1. **Workflow-per-cell as the only supported mapping, or one of several?**
   Multi-workflow cells keep §1's conclusions but complicate GC roots and
   pin-set enumeration slightly. Decide before the store schema is fixed.
2. **Pinned-world retention.** Resume-under-pinned-world pins the old
   module/contract/profile blobs for the life of the workflow. Is retention
   bounded by workflow terminality alone, or does the operator need a policy
   to force-migrate long-lived workflows off ancient worlds?
3. **Where does the deployment identity hash live in the celld artifact?**
   Alongside `deploy/current.json`, inside it, or derived on node start?
   Affects tooling only, not semantics.
4. **Two-tier promotion criteria.** If the shared tier is ever built: size
   threshold, reference count, or operator-designated namespaces (e.g.
   shared reference data)? Deferred with the tier itself.
5. **Suspension-latency budget.** Is there a target ack-latency per
   suspension that the measurement gate should test against (e.g. one
   region-local durable write), giving the gate a pass/fail number rather
   than a judgment call?
