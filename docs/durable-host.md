# Durable task hosting

The TypeScript implementation can persist and resume task-mode environment
entries through `createDurableDriver`. Unlike `runTask`, which owns a live task
until it completes, the durable driver stores every continuation needed to
cross a process boundary.

Durability here means that a workflow can suspend, lose all in-memory runtime
objects, and resume in a newly prepared runtime from its stored JSON record.
It does not mean exactly-once execution of host side effects.

## 1. Creating a driver

The driver combines deployment inputs with a workflow store:

```typescript
import {
  InMemoryWorkflowStore,
  createDurableDriver,
  createStdlib,
} from "json-fn";

const store = new InMemoryWorkflowStore();
const driver = createDurableDriver({
  module,
  environment,
  store,
  host: {
    registry: createStdlib(),
    deploymentId: "orders-2026-07-22",
    effects: {
      log: "inline",
      "payment.await": "suspending",
    },
    capabilities: {
      log: ({ workflowId, effectId }, message) => {
        console.log(workflowId, effectId, message);
        return null;
      },
    },
  },
});
```

The environment entry must return `Task<A>`. Driver construction also requires:

- `effects` to classify every environment effect exactly once;
- every classification to be either `"inline"` or `"suspending"`;
- `capabilities` to contain exactly the inline effects;
- a non-empty `deploymentId`; and
- the intrinsic `raise` effect to be absent from both maps.

Configuration errors throw `EnvironmentConfigurationError`.

`start(workflowId, args)` validates entry arguments before creating the
workflow. Invalid start arguments throw `RuntimeContractError` and do not
reserve the workflow ID.

## 2. Inline and suspending effects

An **inline** effect runs inside the current driver invocation. Its capability
receives a durable context followed by the guest arguments:

```typescript
type DurableEffectContext = {
  workflowId: string;
  effectId: string;
};
```

The driver awaits the capability, validates its result against the environment
effect contract, applies the stored continuation, and keeps advancing. If the
capability throws or rejects, the workflow becomes terminal with failure code
`"host"`.

A **suspending** effect has no capability in the driver configuration. The
driver first transitions the workflow to a durable `suspended` record, then
returns:

```typescript
{
  status: "suspended",
  pending: { effectId, name, args },
}
```

The continuation is intentionally omitted from this public outcome. An
application adapter may dispatch the pending work only after receiving the
outcome, because the corresponding continuation is already durable. Queue
publication, transactional outboxes, webhooks, and join aggregation remain
application responsibilities.

When external work finishes, deliver its result:

```typescript
const outcome = await driver.deliverCompletion(
  workflowId,
  effectId,
  effectResult,
);
```

The result is validated after the suspension is claimed. An invalid result
therefore produces a terminal `"contract"` failure; retrying the same effect ID
with a different value is stale.

If the external work itself cannot produce a result, terminate the workflow
explicitly:

```typescript
await driver.deliverFailure(workflowId, effectId, {
  message: "payment worker exhausted its retries",
  payload: { providerRequestId },
});
```

This produces failure code `"external"`. Guest-visible failures should instead
be represented in the effect's declared result type and delivered in-band with
`deliverCompletion`.

## 3. The at-least-once inline obligation

Inline capabilities may run more than once. A process can execute one or more
inline effects and crash before its compare-and-set transition reaches the
store. `recover` then recomputes from the persisted running basis and executes
those effects again.

This is the central host obligation:

> For a given `effectId`, an inline capability must return the same logical
> result every time it is invoked.

If an inline capability causes an external side effect, it must also make
repetition safe. Typical approaches are:

- pass `effectId` as the idempotency key to the external service;
- record completed effect IDs in an application-owned deduplication table; or
- make the operation naturally idempotent.

Do not use an ordinary non-idempotent operation and assume the driver will
journal its result. Version 1 deliberately has no per-effect inline result
journal and does not provide exactly-once execution.

## 4. Stable effect IDs

Effect IDs have the form:

```text
${workflowId}:${sequence}
```

The sequence begins at zero and advances once for every stepped effect, inline
or suspending. A running record stores the sequence from which its basis must
replay. Deterministic guest execution therefore assigns the same IDs to the
same effects whenever that basis is recovered.

Effect IDs are stable replay identities, not globally ordered event IDs. Hosts
should treat the complete string as opaque except when displaying it for
diagnostics.

## 5. Store consistency contract

A production `WorkflowStore` must provide these operations with the stated
atomicity:

- `create(record)` inserts only if `workflowId` is absent.
- `transition(expectedRevision, record)` is a compare-and-set. It writes only
  when the current revision equals `expectedRevision` and otherwise throws
  `WorkflowRevisionConflictError`.
- `claim(workflowId, effectId, result)` atomically checks that the workflow is
  suspended on exactly that effect ID and changes it to a running resume basis
  with revision incremented by one. Any missing, running, terminal, or
  differently suspended record returns `{ stale: true }` without modification.
- `read(workflowId)` returns the current record, if any.
- `listNonterminal()` returns IDs for running and suspended workflows so an
  operator can perform recovery scans.

Revision compare-and-set prevents competing workers from both publishing a
computed state transition. The losing worker discards its computed transition,
although inline capabilities it already called may have run; this is another
reason the at-least-once obligation is mandatory.

Store boundaries must preserve the complete `WorkflowRecord` as JSON. Use
`serializeWorkflowRecord` and `hydrateWorkflowRecord` when persisting text.
Hydration validates the record and restores the interpreter's inertness marks
on task nodes and continuation closures. Do not parse a stored record with
plain `JSON.parse` and pass it directly to the driver.

`InMemoryWorkflowStore` is a reference implementation for tests and examples.
It deliberately serializes and hydrates every access, but it is not a
production database.

## 6. Recovery and deployment pinning

A running record is a durable replay basis, not a transient lock:

- a start basis contains validated entry arguments;
- a resume basis contains the claimed pending effect, its continuation, and
  the delivered result.

Call `recover(workflowId)` when the host decides a running workflow should be
replayed. The driver creates a fresh task runtime from the module, environment,
registry, and configured limits. It keeps no live runtime object between API
calls.

Every record stores the configured `deploymentId`. Before recovery or delivery,
the driver compares that value with the current host configuration. A mismatch
throws `DeploymentMismatchError` and leaves the record untouched. The string is
opaque to the driver; use a version, build ID, Git commit, or content hash that
identifies compatible module and host inputs.

Migration is an operator concern. Do not change `deploymentId` merely to force
an old continuation through new code.

## 7. Duplicate and stale delivery

`deliverCompletion` and `deliverFailure` claim only the exact current
suspension. They return `{ status: "stale" }` for:

- an unknown workflow;
- a wrong effect ID;
- a workflow that is running;
- a terminal workflow; or
- a duplicate delivery whose first copy already claimed the suspension.

Stale delivery is an expected idempotency outcome, not an exception. It never
runs the continuation. This also makes joins and races straightforward:
application code may complete one workflow-level suspension when its join
condition is met, while duplicate queue messages or late `awaitAny` losers
become stale.

## 8. Workflow states and outcomes

A stored workflow is one of:

- `running`: recomputable from its start or resume basis;
- `suspended`: durable pending effect plus private continuation;
- `completed`: terminal validated entry result; or
- `failed`: terminal structured failure.

`start`, `recover`, and a successfully claimed delivery return a completed,
failed, or suspended outcome. `read` exposes the complete stored record for
inspection. The record codec is the supported serialization boundary; there is
no separate public durable-continuation codec.

## 9. Failure codes

Terminal failures use one of these codes:

- `"raise"` — an unhandled guest `raise`; `payload` contains the raised value.
- `"contract"` — a contract failed while advancing a durable basis, including
  effect arguments, effect results, or workflow completion.
- `"unknown-effect"` — the task performed an effect absent from the environment
  manifest.
- `"malformed-task"` — task structure could not be stepped.
- `"limit"` — fuel, call depth, value size, timeout, or cancellation stopped
  evaluation.
- `"host"` — an inline capability threw or rejected.
- `"external"` — the host called `deliverFailure` for suspended work.

Failures detected while advancing are persisted as terminal records. Store and
configuration errors remain host exceptions rather than workflow failures.

## 10. Limits and fuel

`host.limits` applies fresh limits to each driver invocation. Suspension and a
later delivery therefore use separate per-invocation fuel and timeout budgets.
The record's `fuelUsed` field accumulates consumed fuel across persisted hops
for observability only; it is not a cross-hop budget.

See [Execution limits](execution-limits.md) for the interpreter's fuel, depth,
size, cancellation, and timeout model.

## 11. Complete example

`typescript/examples/durable-orchestration/` contains a commented, runnable
example with:

- a typed guest workflow;
- an in-language deterministic mock;
- an in-memory durable adapter;
- sequential and fan-out/fan-in orchestration;
- empty joins and in-band subagent failure; and
- duplicate and late-straggler stale deliveries.

Run it from the repository root:

```sh
bun run typescript/examples/durable-orchestration/run.ts
```
