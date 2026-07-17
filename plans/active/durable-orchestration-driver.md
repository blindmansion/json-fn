# Durable orchestration driver

Status: proposed.

## Summary

json-fn tasks already suspend as plain JSON:

```json
{
  "pending": {
    "name": "agent.await",
    "args": [{ "id": "agent-123" }],
    "resume": { "$params": ["__v"], "$return": "..." }
  }
}
```

The remaining work is a host driver that turns this representation into durable
execution. Unlike `runTask`, it must not keep a process alive while a long
effect is pending. It advances a workflow through fast effects, persists at a
durable suspension point, returns control, and later restores the continuation
when an external completion arrives.

The motivating case is agent orchestration:

1. spawn one or more subagents;
2. retain their handles;
3. suspend while waiting for results;
4. resume in another process;
5. feed those results into later work; and
6. eventually complete or fail the workflow.

The TypeScript implementation is the first and canonical target.

## Goals

- Run a task across arbitrarily many process lifetimes.
- Keep the task and continuation representation plain JSON.
- Reuse the environment's effect contracts for argument and result validation.
- Preserve the existing distinction between pure in-language handlers and the
  outer host.
- Make replay behavior explicit and give every effect execution a stable
  identity suitable for idempotency.
- Keep storage and external work systems host-owned behind small interfaces.
- Support sequential pipelines and host-concurrent fan-out/fan-in.
- Let the same guest workflow run under an in-language mock for deterministic
  tests and under the durable driver in production.

## Non-goals

- A general workflow service, scheduler, queue, or database implementation.
- Exactly-once execution of external side effects.
- Parallel branches inside the task kernel.
- New task node kinds or evaluator semantics.
- Persisting stateful-handler state through a separate channel.
- Stateful partial handlers that preserve local state while other effects
  bubble to the durable host.
- CLI support in the first implementation.
- Bringing the non-TypeScript interpreters to parity.

## Implemented foundation

The driver should build on the current runtime rather than introduce a second
effect system.

### Task stepping

`stepTask` normalizes an inert task to one of:

```typescript
type Suspended =
  | { done: JSONType }
  | {
      pending: {
        name: string;
        args: JSONType[];
        resume: JSONType;
      };
    };
```

The kernel suspends on one effect at a time. The `resume` value is a
self-contained json-fn closure that reconstructs the rest of the task when
called with the effect result.

### Host execution

`runTask` is the existing run-to-completion trampoline. It:

1. prepares the module and environment;
2. validates entry arguments;
3. calls `stepTask`;
4. validates each effect's arguments;
5. awaits the matching host capability;
6. validates the capability result;
7. applies `resume`; and
8. repeats until the task completes.

The durable driver should share this preparation, validation, dispatch, and
error behavior. The difference is lifecycle: `runTask` awaits every capability
in one invocation, while the durable driver may persist and return instead.

### Typed environment

The operator-owned environment already supplies:

- shared named types;
- direct host functions;
- effect parameter and result contracts; and
- the entrypoint contract.

The runtime injects typed `effects.*` task constructors and validates effect
arguments and results against the same environment. The driver must continue to
use those contracts on both inline and resumed paths.

### Serializable continuations

Task nodes and suspended continuations are plain JSON. `serializeTask` and
`hydrateTask` currently round-trip a top-level task and restore the runtime-only
inertness marks on embedded `@task` nodes.

A `Suspended` record is not itself a task, so it is not accepted by those
helpers. The durable driver needs an equivalent round trip for its persisted
workflow state. Hydration must use the same recursive re-marking behavior; it
must not invent another closure or task encoding.

## Execution model

The driver is still the outermost effect handler. In-language `handle`
expressions may discharge effects first; any unmatched effect bubbles to the
driver.

Each environment effect is classified by the durable host as one of:

- **inline** — invoke the capability now and continue in the current driver
  call; or
- **suspending** — persist the pending continuation and return control without
  awaiting the external result.

For example:

```text
agent.spawn       inline
log               inline
agent.await       suspending
agent.awaitAll    suspending
agent.awaitAny    suspending
```

This classification belongs in durable host configuration, not in the portable
effect manifest:

- the manifest describes the API visible to guest code;
- suspension is a deployment and execution-policy choice;
- the checker needs the effect's argument and result types, but does not need to
  know whether a particular host blocks, polls, or resumes from an event; and
- the same environment can therefore run under `runTask`, a test host, or
  different durable hosts without changing its public contract.

The durable configuration must classify every environment effect. Missing or
extra classifications are configuration errors. The built-in `raise` path
remains intrinsic rather than configurable.

### Advancing a workflow

Starting or resuming a workflow enters the same advance loop:

```text
task
  -> stepTask
     -> done
        -> validate entry completion
        -> persist completed
        -> return completed

     -> pending effect
        -> validate effect arguments
        -> assign stable effect identity

        -> inline
           -> invoke capability
           -> validate result
           -> apply resume
           -> continue loop

        -> suspending
           -> persist suspended workflow
           -> publish/return pending work
           -> return suspended
```

An external completion takes the inverse path:

```text
completion(workflow id, effect id, result)
  -> atomically claim the matching suspension
  -> hydrate the persisted continuation
  -> validate result against the pending effect contract
  -> apply resume(result)
  -> enter the advance loop
```

Only a result for the workflow's current effect identity may resume it. A
duplicate or stale completion must be recognized without running the
continuation again.

### Completion and failure

A workflow has at least these durable states:

```text
running -> suspended -> running -> ... -> completed
                                  \-----> failed
```

`completed` stores the validated entry result. `failed` stores a host-level
failure description suitable for diagnostics and retry policy.

An unhandled `raise`, unknown effect, missing capability, malformed task,
runtime-contract failure, or exhausted execution limit fails the workflow with
the same underlying error semantics as `runTask`.

External operation failure is a host concern. A host may:

- resume with a declared error value if the effect result contract includes it;
- translate the failure into a guest-level protocol explicitly modeled by the
  environment; or
- mark the workflow failed.

The driver must not silently convert arbitrary host exceptions into guest
`raise` values.

## Persistence model

### Persisted workflow record

The exact TypeScript shape should be finalized with the store interface, but a
suspended record needs enough information to resume and deduplicate:

```typescript
type SuspendedWorkflow = {
  workflowId: string;
  revision: number;
  status: "suspended";
  pending: {
    effectId: string;
    name: string;
    args: JSONType[];
    resume: JSONType;
  };
};
```

The store may retain additional timestamps, ownership, retry, or indexing
metadata. Those are not part of the json-fn task representation.

The persisted record does not need to duplicate the guest module, environment,
callable registry, or capability implementations. Those are deployment inputs
identified by the host and reloaded when a worker resumes the workflow. A
production host must pin or version them so that a continuation is not resumed
against incompatible code or contracts.

### Serialization

Add focused helpers for the actual persistence unit, for example:

```typescript
serializeSuspendedWorkflow(value): string
hydrateSuspendedWorkflow(serialized): SuspendedWorkflow
```

The names and public granularity may change during implementation, but the
behavior must:

- reject malformed persisted records;
- restore inertness on every embedded `@task` node using the existing re-mark
  walk;
- leave continuation closure bodies executable;
- preserve effect name, arguments, and identity exactly; and
- round-trip through ordinary `JSON.stringify`/`JSON.parse`.

`serializeTask` and `hydrateTask` remain useful for top-level tasks. The new
helpers close the distinct suspended-record gap rather than replacing them.

### Store contract

The driver defines the consistency operations it needs; the host chooses the
storage backend. The first interface should support:

- creating a workflow with a stable ID;
- atomically writing a new suspended state at an expected revision;
- atomically claiming the current suspension by workflow ID and effect ID;
- writing terminal completion or failure;
- reading current status for recovery and inspection; and
- recovering work left in a nonterminal state after a worker crash.

Compare-and-set or transaction semantics are required around revision changes.
A simple load followed by an unconditional save would allow two completion
events or workers to run the same continuation concurrently.

The core store should index workflows by workflow and effect identity, not by
agent-specific handle shape. An orchestration adapter may additionally index
the pending arguments so that a completed subagent handle finds workflows
waiting on `agent.await`, `agent.awaitAll`, or `agent.awaitAny`.

## Effect identity and at-least-once execution

Durable execution cannot promise exactly once. A worker can crash after an
external side effect succeeds but before the next workflow state is committed.
Recovery then sees the previous durable state and may execute the effect again.

Every effect attempt therefore receives a stable identity derived from durable
workflow state, such as:

```text
<workflow id>:<logical effect sequence>
```

Replaying the same logical effect must reuse the same identity. Advancing to a
new effect must allocate a new one. The driver-specific capability context
should expose at least:

```typescript
type DurableEffectContext = {
  workflowId: string;
  effectId: string;
};
```

Capability adapters use `effectId` as an idempotency key when talking to
external systems. This is especially important for `agent.spawn`, payments,
notifications, deployment mutations, and other side effects. Deterministic
external handles are another valid implementation of the same rule.

The guest-visible effect arguments do not need to contain driver bookkeeping.
An environment may still include a domain idempotency key when that key is part
of its public API.

Persistence must happen before a suspending request is exposed for dispatch.
Publishing that request and committing it atomically may require a transactional
outbox in a production host. The driver specifies the ordering and stable
identity; it does not implement the host's queue/database transaction.

Duplicate completion delivery is also expected. Claiming a suspension by its
effect ID must make a second delivery a no-op or an explicit already-consumed
result, never a second continuation run.

## Concurrency and joins

A task has one continuation stack and reaches one pending effect at a time. The
driver does not add parallel task branches.

Concurrency lives behind host effects:

- `agent.spawn` starts out-of-band work and quickly returns a handle;
- guest code may call it repeatedly to create concurrent work;
- `agent.await` suspends for one handle;
- `agent.awaitAll` suspends until every supplied handle completes; and
- `agent.awaitAny` suspends until one supplied handle completes.

The guest pattern is spawn-all-then-join:

```jfn
spawnAll: (specs: AgentSpec[]) -> Task<Handle[]> =>
  if length(specs) == 0 then pure([])
  else do {
    handle <- effects.agent.spawn(head(specs)!),
    rest <- spawnAll(tail(specs)),
    pure(concat([handle], rest))
  },

research: (topics: string[]) -> Task<Report[]> => do {
  handles <- spawnAll(
    map((topic) => { role: "researcher", input: topic }, topics)
  ),
  results <- effects.agent.awaitAll(handles),
  pure(map(toReport, results))
}
```

Join behavior is an effect-level host contract, not a kernel primitive.
Ordering, empty-input behavior, failure aggregation, cancellation, and
`awaitAny` result shape must be declared by the orchestration environment and
covered by its capability tests.

## Relationship to stateful handler shorthand

The durable driver and
[stateful handler shorthand](stateful-handler-sugar.md) are independent
implementation tracks:

- stateful handler shorthand is parser/printer sugar over existing pure
  closures and `handle`;
- the durable driver consumes the already-lowered task and continuation data;
  and
- neither feature requires evaluator or task-node changes from the other.

They reinforce one another at the test and example layer. A stateful in-language
handler can supply deterministic agent handles and results while recording an
event transcript. The same unwrapped workflow can let those effects bubble to
the durable host in production.

State captured by a lowered stateful handler is already enclosed in the
persisted continuation. The driver needs no state-specific serializer, store,
or commit protocol.

The driver core may be implemented before or in parallel with the shorthand.
The orchestration example and paired mock/production acceptance tests should
land after the shorthand, or initially use its manual state-transformer
expansion and migrate as soon as the shorthand is available.

Stateful partial handlers remain separate future work. The first shorthand
version is a total in-language interpreter; it does not provide stateful
middleware that handles some effects while allowing durable effects to bubble.

## Orchestration acceptance example

Add one typed example centered on durable orchestration. Its environment should
define at least:

- `AgentSpec`;
- `Handle`;
- `AgentResult`;
- `Report`;
- `agent.spawn`;
- `agent.await`; and
- `agent.awaitAll`.

The guest module should demonstrate both:

1. a pipeline in which one agent's output becomes another agent's input; and
2. fan-out/fan-in in which several agents are spawned before one join.

The example needs two hosts:

- a deterministic in-language mock, preferably using stateful handler
  shorthand, with canned results and an event transcript; and
- a durable test host with an in-memory store and explicitly delivered
  completion events.

The in-memory store is test infrastructure, not the production storage
recommendation.

## Implementation slices

### 1. Extract a reusable task-driving runtime

Refactor the shared preparation and one-hop behavior currently internal to
`runTask` so `runTask` and the durable driver cannot drift on:

- module/environment preparation;
- entry argument and completion validation;
- effect argument and result validation;
- `raise` and unknown-effect behavior;
- application of `resume`; and
- execution limits.

Keep `runTask`'s public behavior unchanged.

### 2. Add suspended-state round trips

- Define the persisted suspended-workflow shape.
- Add serialize/hydrate validation and inert-task re-marking.
- Test continuations containing recursive local functions, nested tasks, and
  in-language handlers across a JSON round trip.
- Add direct coverage for the existing task serialize/hydrate helpers.

### 3. Define durable host and store interfaces

- Add explicit inline/suspending effect classification.
- Reject missing, extra, or invalid classifications.
- Define stable workflow and effect identities.
- Define compare-and-set transitions and duplicate-completion behavior.
- Pass durable effect context to host adapters.

Start with an in-memory reference store used only by tests and examples.

### 4. Implement start, advance, and resume

- Start from a validated module entry.
- Drive through inline effects.
- Persist and return on suspending effects.
- Resume only the matching current effect.
- Validate externally supplied results before applying the continuation.
- Persist terminal completion and failure.
- Recover safely from stale workers and duplicate events.

### 5. Add orchestration joins and acceptance coverage

- Define the agent orchestration environment and guest module.
- Cover pipelines, fan-out/fan-in, empty joins, failures, and duplicate
  completions.
- Run the same guest workflow under the in-language mock and durable test host.
- Simulate process boundaries by discarding runtime objects between suspend and
  resume and rebuilding them solely from deployment inputs plus stored JSON.

### 6. Document the host contract

Document:

- inline versus suspending configuration;
- store consistency requirements;
- module/environment version pinning;
- at-least-once execution;
- stable effect IDs and idempotent capabilities;
- duplicate and stale completion handling; and
- which errors fail a workflow versus resume a declared guest result.

## Acceptance criteria

- A workflow can suspend, be serialized, lose all live runtime state, and resume
  to the same result in a newly prepared runtime.
- Inline and suspending effects use the same environment contracts as
  `runTask`.
- The driver never awaits a suspending capability in the worker invocation that
  reaches it.
- A stale or duplicate completion cannot run a continuation twice.
- Replaying an inline effect presents the same stable effect ID to its
  capability adapter.
- Completion, unhandled `raise`, contract errors, missing capabilities, and
  execution-limit failures produce durable terminal states.
- Fan-out work runs out of band and joins resume through ordinary effect
  results; no parallel task node is introduced.
- Stateful in-language mocks require no driver-specific state support.
- The orchestration example passes under both its deterministic mock and the
  durable in-memory test host.

## Open design details

The architecture above fixes the major boundaries, but implementation should
settle these concrete API details:

- whether suspended serialization is exported as a generic `Suspended` helper
  or only through the workflow-record codec;
- the exact durable capability signature and effect-context shape;
- the minimum compare-and-set store interface that supports recovery without
  prescribing a database;
- whether module/environment version identifiers are mandatory driver fields or
  host-owned metadata validated by a resume hook;
- how execution fuel is budgeted across hops: one persisted cumulative budget,
  a fresh per-invocation budget, or both; and
- the orchestration environment's exact `awaitAny`, cancellation, and aggregate
  failure contracts.

These choices should be resolved in slice 3 before the public durable-driver API
is committed.
