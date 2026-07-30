# Module identity pinning for durable resume (follow-up A)

Status: proposed; the Phase 0 artifact/semantic identity and executable-world
projection decisions are settled (see "What gets hashed"). Depends only on the
canonical-encoding + hashing layer from
[`content-addressed-values.md`](content-addressed-values.md) — not on the blob
store. Can land with v1 or independently before it.

## Summary

A serialized continuation is deliberately **not** self-contained with respect
to the module: escaping-closure capture attaches `where`-locals and nested
locals, but module-level (registry) functions resolve **by name at call time**
on whatever host resumes the task. `docs/language.md` states the contract
plainly: a shipped closure "still relies on the target host providing the
registry (module + stdlib) — exactly as it already relies on `add`, `map`, and
friends being present."

For live evaluation that contract is fine. For **durable** execution it hides a
real hazard: a workflow suspended in month 1 and resumed in month 3 runs its
continuation against whatever module the month-3 deployment links. If the
module changed in between, the workflow silently changes semantics
mid-execution — the stored continuation calls `applyDiscount` by name and gets
the new `applyDiscount`. Sometimes that is exactly what the operator wants
(bug-fix picked up by in-flight workflows); sometimes it is a corruption bug.
Today there is no way to even *detect* which one happened.

The fix is small: give every workflow record the content hash of the linked
world it was suspended under, and let the driver enforce a policy when the
resuming world differs.

## Design

### What gets hashed

The settled projection computes one **deployment identity hash** at
`prepareDeployment` time over the canonical encoding of:

- the authored module after program normalization, including `$types`, but
  before contract-derived effect bindings are injected;
- the environment contract;
- the full builtin signature table plus an explicit engine/stdlib semantic
  version;
- the portable profile projection: mode, effect selection and
  inline/suspending classification, and the closed portable limits
  (`maxCallDepth`, `maxFuel`, `maxValueSize`).

Contract-derived injection is covered by the contract component and must not
also change the module component. Host-local chunking, storage, logging, and
timeout settings are excluded because they do not define the portable
executable world. Executable adapter code is also outside automatic identity
and remains an operator responsibility.

These inputs use the canonical-bytes + domain-separated hash foundation from
the base plan. Hashing `spec/builtins.json` alone is insufficient because an
implementation can change behavior without changing signatures; hashing prose
would create irrelevant drift. The explicit engine/stdlib semantic version is
the reviewed signal for those behavior changes.

**Phase 0 decision (settled): executable-world projection.** The guiding
principle is that automatic identity covers exactly what is deterministic and
portable, errs toward visible rejection over silent acceptance, and hands the
genuinely unhashable residue to the operator as a named obligation:

- **Builtin table: hash the full table for v1.** The failure asymmetry
  decides this: the full table errs toward spurious but visible drift when a
  new builtin is added (a new name cannot change the meaning of an existing
  continuation — existing names win lookups and new names were unresolvable
  before), while an unsound referenced subset errs toward silently resuming
  under a changed builtin, the exact corruption this plan exists to prevent.
  A referenced-builtin subset may replace the full table only under a new
  identity domain version, and only after an audit proves capability analysis
  finds every direct and transitive builtin reference, including higher-order
  and dynamically resolved ones. The engine/stdlib semantic version remains
  an identity input under either table, because a behavior change to an
  existing builtin is invisible to signature hashing.
- **Profile projection rule: deterministic guest-observable outcomes.** A
  profile field participates in automatic identity if and only if changing it
  can alter a deterministic guest-observable outcome — values, errors,
  suspension structure, or deterministic-limit failures. For profile v1 that
  is: mode, effect selection and inline/suspending classification, and the
  closed portable limits (`maxCallDepth`, `maxFuel`, `maxValueSize`;
  `maxFuel` is unambiguously semantic because fuel is a settled stable
  virtual cost). Excluded by the same rule: `deploymentId` (operator
  namespace, per the settled invariants), host-local run options (`signal`,
  `timeoutMs`, `perf`, `usage`), and storage, logging, and chunking
  configuration. Future profile fields apply this rule at introduction.
- **Adapter compatibility: `deploymentId` is the attestation.** Executable
  adapter code stays outside automatic identity. Keeping a `deploymentId` is
  an operator assertion that the current `adapter.functions` and inline
  `adapter.effects` are behaviorally compatible — in the behavioral-parity
  sense of `docs/environment-contract.md` — with every in-flight workflow
  under that id. A behaviorally incompatible adapter change requires a new
  `deploymentId`, which the existing non-mutating deployment-mismatch path
  already enforces. `deploymentId` is not an input to `identityHash`; it is
  the human-attested channel beside the machine-checked one.

Program normalization and JSON byte canonicalization are separate steps. The
authored module first passes through the program normalizer from
`../raw-semantics-cleanup.md`, so redundant `$raw` spellings cannot create
different deployment identities for semantically equivalent modules. The
environment contract and profile are data documents and do not pass through
that AST normalizer.

**Phase 0 decision (settled): the manifest retains both hashes.** The
normalized semantic module hash answers whether the executable program changed
under the selected normalization; a distinct authored-artifact hash answers
whether the reviewed artifact itself changed. Retaining both costs one
manifest field and one hash pass, and buys a normalizer-independent ground
truth: forensics if the normalizer ever mis-normalizes, mechanical
re-attestation across normalizer version bumps (artifact hash unchanged →
safe to re-hash under the new normalization version), and a direct answer to
"is production running byte-for-byte what was approved?" — the review story
the language is built around.

The settled roles are:

- **Enforcement keys on the normalized module hash only.** The aggregate
  `identityHash` compared by `moduleDrift` policies includes the normalized
  module component. The authored-artifact hash is provenance and diagnostic
  metadata; it must never be an enforcement input, so semantically neutral
  respellings (reformatting, redundant-`$raw` removal) cannot reject
  in-flight workflows.
- **The artifact hash input is the canonical-JSON module exactly as
  reviewed** — after shorthand parsing, before program normalization,
  canonically encoded. The `.jfn` source text is not the artifact; the
  canonical JSON is.
- **Separate versioned domains**: the artifact hash occupies its own domain
  (for example `jfn:module-artifact:v1`) alongside `jfn:module:v1`, per the
  roadmap's settled domain invariants.
- **Component diffs report both hashes**, so drift diagnostics distinguish
  "artifact changed, program unchanged" from "program changed."

The artifact hash has no dependency on the program normalizer, so it can be
implemented and tested as soon as the canonical-encoding/hashing layer exists,
before normalized module identity is ready to ship.

Normalized module identity must not ship until `$raw` fuel equivalence and the
program normalizer are complete. A normalization that changes fuel, errors, or
quoted expression-shaped data is not identity-preserving.

Version and domain-separate each component hash and the aggregate deployment
hash (for example `jfn:module:v1`, `jfn:module-artifact:v1`,
`jfn:contract:v1`, and `jfn:deployment:v1`). The shared JSON encoder remains
content-only; the domain prefix is part of the hash input.

### What gets stored

Every durable workflow record gains:

- `identityManifest` — a versioned manifest containing the module,
  authored-artifact, contract, builtin table, engine/stdlib, and
  portable-profile component versions and hashes;
- `identityHash` — the aggregate hash of that manifest at `start()`;
- `resumedUnder` — appended history of identity hashes it was advanced under
  (bounded to the original plus the eight most recent distinct identities).

The manifest is persisted on every closed workflow-record variant so mismatch
diagnostics can name the changed component without reconstructing an old
deployment.

### Enforcement policy

A new driver option, per deployment:

```ts
createDurableDriver({ deployment, store, moduleDrift: "reject" | "warn" | "allow" })
```

- `"reject"` (default): advancing a workflow whose stored `identityHash`
  differs from the current deployment's throws a structured identity mismatch
  before claim or transition. The workflow record is unchanged, matching the
  existing non-mutating deployment-mismatch behavior, so the correct
  deployment can still resume it. The error carries both hashes and the
  component-level diff.
- `"warn"`: advance, return the structured warning in the driver outcome and
  emit it through the configured host logger, then record the bounded
  `resumedUnder` history.
- `"allow"`: current behavior, but still record `resumedUnder` so drift is at
  least auditable after the fact.

`deploymentId` (the existing non-empty string requirement) stays what it is —
an operator-chosen namespace and broader compatibility/policy boundary. The
identity hash is the machine-checked portable-world counterpart; it does not
prove behavioral equivalence of executable adapters.

Old records without identity fields have unknown executable-world identity.
The default is non-mutating rejection with an explicit compatibility error.
An operator may opt into one-time `"allow"`/`"warn"` resume, which records the
current manifest and audit history. Stores must not silently backfill identity
during a read.

### Migration story (explicitly out of scope, enabled by this)

Rejecting drift creates the obvious next question: how does an operator *move*
in-flight workflows to a new module version? That is a separate plan
(version-routing: keep N prepared deployments keyed by identity hash, route
each record to its own version; or an explicit migrate hook). This plan only
makes the situation **visible and controllable**; today it is neither.

## Why this ranks above the blob store

- It shares the expensive design work (canonical encoding, hash discipline)
  with the base plan but needs no store surface, no GC, no chunking policy.
- The failure it prevents is silent semantic corruption of long-lived
  workflows — worse than any storage cost the blob store addresses.
- It is a few fields on the record plus one comparison in the driver.

## Open questions

Artifact identity and the executable-world projection — portable-profile
projection, adapter compatibility signaling, and stdlib evolution — are
settled; see "What gets hashed". The remaining open question is:

1. **Rollout UX for old records.** This may influence operator guidance, but does
   not change the non-mutating default or make `"warn"` underspecified.
