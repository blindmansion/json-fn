# Durable task hosting

A durable host persists every continuation needed to suspend a task, discard
all in-memory execution state, and resume in another process from a JSON
workflow record. Durability does not provide exactly-once host effects.

Portable inputs are defined by the
[environment contract](../deployment/environment-contract.md) and
[deployment profile](../deployment/deployment-profile.md). Durable execution
requires:

- a contract entry returning `Task<A>`;
- a durable profile with a non-empty `deploymentId`;
- each selected effect classified as `"inline"` or `"suspending"`;
- bindings for every direct contract function and exactly the selected inline
  effects;
- no profile entry for the intrinsic `raise` effect.

Contract effects may be omitted from the profile. If an omitted effect reaches
the host, the workflow fails with `"unknown-effect"`.

## Workflow lifecycle

A stored workflow has one state:

- `running`: recomputable from a persisted start or resume basis;
- `suspended`: a pending effect and its private continuation;
- `completed`: a terminal, validated entry result;
- `failed`: a terminal structured failure.

Starting a workflow validates entry arguments before reserving its workflow ID.
Invalid arguments leave no record.

A start, recovery, or claimed delivery advances until it completes, fails, or
suspends. No live execution object is retained between host invocations.

## Effects

### Inline effects

An inline effect executes during the current host invocation. Its binding
receives this durable context in addition to the guest arguments:

```text
{ workflowId, effectId }
```

The host awaits the result, validates it against the effect contract, applies
the continuation, and keeps advancing. A thrown or rejected host call produces
a terminal `"host"` failure.

Inline effects are at-least-once. A process may perform an effect and fail
before its record transition commits; recovery then performs it again. For one
`effectId`, the binding must return the same logical result on every
invocation. External side effects must use that ID for deduplication or be
naturally idempotent.

Inline results are not journaled separately, so the store protocol does not
provide exactly-once execution.

### Suspending effects

A suspending effect has no executable binding. Before exposing pending work,
the host persists a `suspended` record containing the continuation. The public
outcome contains only:

```text
{ status: "suspended", pending: { effectId, name, args } }
```

Queue publication, transactional outboxes, webhooks, and joins belong to the
application. Dispatch is safe only after the suspended outcome exists, because
the continuation is then durable.

A completion delivery atomically claims the exact current suspension and then
validates the delivered result. An invalid result produces a terminal
`"contract"` failure. A duplicate delivery after the claim is stale.

When external work cannot produce a result, a failure delivery terminates the
workflow with code `"external"`. Guest-visible failures belong in the effect's
declared result type and should be delivered as ordinary completion values.

## Effect IDs

Effect IDs have the form:

```text
<workflowId>:<sequence>
```

The sequence starts at zero and advances for every stepped effect, inline or
suspending. A running basis stores the sequence from which replay begins.
Deterministic replay therefore assigns the same IDs to the same effects.

The full effect ID is an opaque replay identity, not a globally ordered event
ID.

## Store contract

A workflow store provides these atomic operations:

- `create(record)` inserts only when the workflow ID is absent.
- `transition(expectedRevision, record)` writes only when the current revision
  equals `expectedRevision`.
- `claim(workflowId, effectId, result)` changes the matching suspended record
  into a running resume basis and increments its revision. A missing, running,
  terminal, or differently suspended record returns stale without mutation.
- `read(workflowId)` returns the current record, if present.
- `listNonterminal()` returns running and suspended workflow IDs for recovery
  scans.

Compare-and-set prevents competing workers from both committing a transition.
The losing worker discards its computed transition, though its inline effects
may already have run.

Storage must preserve the complete workflow record as JSON. Serialization and
hydration validate the entire record, including embedded `@task` shapes,
continuations, and the fixed structural-depth limit. Malformed or unknown task
shapes are rejected before evaluation. Hydration reconstructs executable task
and continuation values only after validation.

## Recovery and deployment identity

A running record is a replay basis:

- a start basis contains validated entry arguments;
- a resume basis contains the claimed pending effect, its continuation, and
  delivered result.

Recovery starts a fresh execution session from that basis and the configured
module, contract, bindings, and profile limits.

Every workflow record stores its `deploymentId`. Recovery and delivery require
an exact match with the active deployment. A mismatch leaves the record
untouched. The identifier is opaque and must identify mutually compatible
module and host inputs; workflow migration is an operator-controlled operation.

## Duplicate and stale delivery

A completion or failure delivery claims only the current matching suspension.
It returns a normal stale outcome for:

- an unknown workflow;
- the wrong effect ID;
- a running workflow;
- a terminal workflow;
- a duplicate delivery already claimed by another worker.

A stale delivery never runs the continuation. This makes duplicate messages,
late race losers, and repeated join completion attempts idempotent.

## Failure codes

Terminal failures use these codes:

- `"raise"`: unhandled guest `raise`; the raised value is the payload.
- `"contract"`: effect arguments, effect results, or workflow completion fail
  their contract.
- `"unknown-effect"`: an effect is absent from the contract or durable profile.
- `"malformed-task"`: the task cannot be stepped.
- `"limit"`: fuel, call depth, value size, or structural depth is exhausted.
- `"host"`: an inline effect or direct host function throws or rejects.
- `"external"`: external work reports failure for a suspended effect.

Failures found while advancing are persisted as terminal records. Errors that
occur outside advancement do not create terminal failures: invalid start
arguments precede record creation, deployment mismatches precede mutation, and
store I/O or consistency failures propagate to the host. Stale delivery remains
a normal outcome.

## Limits

Portable `maxCallDepth`, `maxFuel`, and `maxValueSize` limits apply afresh to
each start, recovery, and delivery invocation. A workflow record may accumulate
fuel usage for observation, but that total is not a cross-invocation budget.

See [Execution limits](execution-limits.md) for the complete cost and limit
model.
