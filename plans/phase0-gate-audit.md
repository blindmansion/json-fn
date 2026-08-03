# Phase 0 gate audit

Status: completed 2026-08-03; gate passed.

## Scope

The Phase 0 gate in
[`implementation-roadmap.md`](implementation-roadmap.md) requires that
representative program values, host values, task records, and durable records
each have:

- one valid representation category;
- one defined validation and hydration path;
- deterministic depth/fuel behavior; and
- an unambiguous hash domain, if they are hashed.

The gate is definitional: it is satisfied when each criterion has one settled
contract and one owning path, not when every contract is implemented.
Implementing the settled depth, string-policy, raw/fuel, and hashing contracts
is exactly the work of Phases 1–3, so requiring implementation here would be
circular. This audit records where each criterion is defined, and confirms
that every known implementation gap has exactly one owner and contradicts no
settled contract.

Code references are to the canonical TypeScript implementation.

## Program values

Values produced by evaluating a program: JSON scalars, arrays, objects, and
function values.

- **Representation category.** One: portable guest values are finite, acyclic
  JSON trees (settled Phase 0 invariant). Function values are self-contained
  plain-JSON function bodies — escaping-closure capture keeps closures in the
  same JSON category rather than introducing a host-object category.
  Runtime-only inertness marks (WeakSet-backed raw marks) are ephemeral
  metadata; the settled fuel decision makes their loss observationally
  irrelevant.
- **Validation and hydration path.** Produced values are trusted within one
  evaluation and bounded by `maxValueSize`. They leave evaluation only through
  the host boundary or through task/durable persistence, each of which has the
  single path audited below. Structural checking at every boundary uses one
  mechanism (`schema/values.ts` via `enforceRuntimeContract`).
- **Depth/fuel behavior.** Fuel is the settled stable virtual cost — a pure
  function of program, inputs, and recorded effect results. Depth is the
  settled portable structural-depth contract with one counting rule
  ([`runtime-representation-gaps.md`](runtime-representation-gaps.md) §2);
  enforcement is Phase 1 work.
- **Hash domain.** Not hashed today. When semantic value hashing lands
  (Phase 3), program values hash in the semantic value-hash domain, which the
  settled invariants keep distinct from program-identity and physical-blob
  domains.

## Host values

Values crossing the host boundary: entry arguments, host-function arguments
and results, effect arguments and results, and entry completion values.

- **Representation category.** The same portable guest-value category. The
  settled invariant requires rejecting unsupported host values (non-finite
  numbers, cycles, non-JSON values, ill-formed surrogate strings) before
  persistence or hashing.
- **Validation and hydration path.** One: every crossing is checked by
  `enforceRuntimeContract` against the environment contract — entry arguments
  (`validateArgs`), effect arguments (`step`), effect results
  (`applyResume`), entry completion (`validateCompletion`) in
  `typescript/src/host/task-runtime.ts`, and host-function calls via the
  contract wrappers installed in
  `typescript/src/host/deployment/deployment.ts`. Host values are never
  persisted directly, so no hydration path exists or is needed.
- **Depth/fuel behavior.** Host values are consumed by evaluation under the
  stable virtual-cost fuel rule; effect results are part of the fuel
  function's recorded inputs. The contract-validation walk itself falls under
  the shared structural-depth contract.
- **Hash domain.** Never hashed directly; they reach hashing only after
  becoming parts of durable records or guest values, which carry their own
  domains.

## Task records

Serialized task graphs: `@task`-tagged kernel nodes (`effect`/`pure`/`bind`)
plus self-contained continuation closures.

- **Representation category.** One: inert tagged plain-JSON records built only
  by the kernel constructors, self-contained via escaping-closure capture
  (`typescript/src/task.ts`). Raw marks on task nodes are ephemeral
  runtime-only metadata restored on load.
- **Validation and hydration path.** One: `serializeTask`/`hydrateTask` with
  `remarkTaskNodes` in `typescript/src/host/task-serialization.ts`. Forged or
  malformed nodes fail deterministically as guest-visible errors in
  `stepTask`, never as host exceptions.
- **Depth/fuel behavior.** `stepTask` walks the `bind` spine iteratively and
  meters every step; continuation application is metered through the shared
  `call` path. The recursive hydration re-mark walk falls under the
  structural-depth contract.
- **Hash domain.** Not hashed; no domain is assigned or required.

## Durable records

`WorkflowRecord`: the closed `running`/`suspended`/`completed`/`failed`
variants persisted by the durable host.

- **Representation category.** One: a closed, exhaustively validated record
  union (`typescript/src/host/durable/workflow-record.ts`). Guest payloads
  inside it are portable guest values; continuations are the task-record
  continuation closures above.
- **Validation and hydration path.** One: `validateWorkflowRecord` backs both
  `serializeWorkflowRecord` and `hydrateWorkflowRecord`, and hydration
  validates the complete record before restoring runtime marks — the
  hydration order required by
  [`plan-reconciliation.md`](plan-reconciliation.md).
- **Depth/fuel behavior.** Persisted `fuelUsed` is deterministic under the
  settled fuel decision. Validation and hydration walks fall under the
  structural-depth contract, and the settled depth decision classifies the
  depth error as a durable limit failure alongside fuel, value-size, and
  call-depth exhaustion.
- **Hash domains.** Records are not hashed today. The assigned domains are
  settled and mutually distinct: the normalized semantic module hash
  (enforcement), the authored-artifact hash (provenance only), the aggregate
  executable-world identity, and — if Phase 4B is justified — physical blob
  hashes. Operator `deploymentId` remains a namespace, not a hash domain
  ([`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md)).

## Known implementation gaps (owned, non-blocking)

Each remaining gap implements an already-settled contract and has exactly one
owner:

| Gap | Owner | Lands in |
| --- | --- | --- |
| `__proto__`-safe own-property writes across all construction paths | [`runtime-representation-gaps.md`](runtime-representation-gaps.md) §1 | Phase 1 |
| Portable structural-depth limit enforcement with one counting rule | [`runtime-representation-gaps.md`](runtime-representation-gaps.md) §2 | Phase 1 |
| Ill-formed surrogate rejection at every boundary | [`runtime-representation-gaps.md`](runtime-representation-gaps.md) §3c | Phase 1 |
| Unicode performance/fuel metering (or its explicit deferral) | [`runtime-representation-gaps.md`](runtime-representation-gaps.md) §3b | Phase 1 |
| Precise runtime-value APIs replacing overloaded raw predicates | [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) | Phase 2 |
| Centralized deep task/workflow shape validation before mark restoration | [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) | Phase 2 |
| Ingestion-route-independent `$raw` static-literal fuel | [`raw-semantics-cleanup.md`](raw-semantics-cleanup.md) | Phase 2 |
| Canonical encoding, semantic value hashes, identity hashes | [`content-addressing/content-addressed-values.md`](content-addressing/content-addressed-values.md), [`content-addressing/module-identity-pinning.md`](content-addressing/module-identity-pinning.md) | Phases 3–4A |

No gap is unowned, double-owned, or in conflict with a settled Phase 0
decision.

## Conclusion

All four record categories satisfy the gate criteria. Phase 0 is complete
apart from continuing to run the durable-host instrumentation against real
workloads as they materialize; Phase 1 (representation integrity) may begin.
