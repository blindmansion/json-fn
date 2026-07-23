# Module identity pinning for durable resume (follow-up A)

Status: proposed. Depends only on the canonical-encoding + hashing layer from
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

At `prepareDeployment` time, compute one **deployment identity hash** over the
canonical encoding of:

- the linked module (post-linking canonical JSON, including `$types`);
- the environment contract;
- the builtin table version (a version string is enough; hashing the full
  builtin signature table is better and cheap since it is already JSON);
- the profile's effect selection/classification (mode-relevant fields only).

These are all plain JSON already, so this is the canonical-bytes + hash
function from the base plan applied to values that exist today. Expose it as
`deployment.identityHash` and include the component hashes individually
(`moduleHash`, `contractHash`, ...) for diagnostics.

### What gets stored

Every durable workflow record gains two fields:

- `identityHash` — the deployment identity at `start()`;
- `resumedUnder` — appended history of identity hashes it was advanced under
  (bounded list; first + most recent is enough if space matters).

### Enforcement policy

A new driver option, per deployment:

```ts
createDurableDriver({ deployment, store, moduleDrift: "reject" | "warn" | "allow" })
```

- `"reject"` (default): advancing a workflow whose stored `identityHash`
  differs from the current deployment's is a terminal failure with a new
  failure code `"module-drift"`, carrying both hashes and the component-level
  diff (which of module/contract/builtins/profile moved).
- `"warn"`: advance, but surface the mismatch in the outcome and record
  `resumedUnder`.
- `"allow"`: current behavior, but still record `resumedUnder` so drift is at
  least auditable after the fact.

`deploymentId` (the existing non-empty string requirement) stays what it is —
an operator-chosen namespace. The identity hash is the machine-checked
counterpart.

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

1. Should `identityHash` cover the **adapter**? It can't (executable code),
   which is worth stating in docs: pinning covers the portable world; host
   capability behavior remains the operator's responsibility — consistent
   with the structural-vs-behavioral parity split in
   `docs/environment-contract.md`.
2. Stdlib evolution: adding a new builtin changes the builtin-table hash but
   cannot change the meaning of an existing continuation (existing names win
   lookups; new names were unresolvable before). Consider hashing only the
   builtins the module actually references (the `analyzeDeploymentCapabilities`
   machinery already walks names) to avoid spurious drift rejections on
   harmless stdlib additions.
3. Whether `"reject"`-by-default is too aggressive for the first release —
   shipping as `"warn"` default with `"reject"` recommended in
   `docs/durable-host.md` may be the gentler rollout.
