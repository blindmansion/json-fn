# Durable orchestration driver

Status: planned. This is the concrete revision of the earlier design sketch;
the open questions in that sketch are resolved in **Decisions** below.

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

The motivating case is agent orchestration: spawn subagents, retain their
handles, suspend while waiting, resume in another process, feed results into
later work, and eventually complete or fail the workflow.

The TypeScript implementation is the only target.

## Decisions

Each of these was open in the design sketch. They are now fixed; changing one
requires revisiting this plan, not silently diverging during implementation.

1. **Task entries only.** The durable driver requires
   `entry.returns: { task: ... }`. A direct-return entry (supported by
   `runTask` since the entry-return-consistency change) is rejected at driver
   construction with `EnvironmentConfigurationError`: a direct entry can never
   suspend, so durable execution is meaningless for it.

2. **Replay, not journaling.** The driver persists only at suspension and
   terminal points. After a crash, every inline effect executed since the last
   persisted basis re-runs. There is no per-effect event journal. In exchange,
   inline capabilities carry a documented obligation: **given the same
   `effectId`, an inline capability must return the same result value** (not
   merely avoid duplicating its side effect). A replayed `agent.spawn` must
   yield the same handle, or the recomputed continuation diverges from the
   agents actually running. Deterministic external handles or
   idempotency-keyed lookups both satisfy this.

3. **Effect classification lives in durable host configuration.** The portable
   effect manifest is unchanged. `DurableHostConfiguration` classifies every
   environment effect as `"inline"` or `"suspending"`. Missing, extra, or
   unknown names are configuration errors. `raise` is intrinsic and cannot be
   classified.

4. **Capability parity is mode-specific.** `prepareEnvironmentRuntime`
   currently requires a capability for every effect and rejects extras. That
   check is correct for `runTask` but wrong for the durable host, where
   suspending effects have no capability at all. The effect/capability parity
   check moves out of `prepareEnvironmentRuntime` (which keeps the
   registry/host-function work) into each entry point: `runTask` keeps the
   existing all-effects rule; the durable driver requires capabilities for
   exactly the inline effects and rejects a capability for a suspending
   effect.

5. **Durable capabilities take a context first argument.** A new type,
   distinct from the existing `Capability`:

   ```typescript
   type DurableEffectContext = { workflowId: string; effectId: string };
   type DurableCapability = (
     context: DurableEffectContext,
     ...args: JSONType[]
   ) => Promise<JSONType> | JSONType;
   ```

   `runTask` capabilities are unchanged. The shared task runtime (slice 2)
   takes dispatch as a function argument, so each caller adapts its own
   capability shape.

6. **The driver persists, the host publishes.** On a suspending effect the
   driver writes the suspended record first, then returns the pending
   descriptor (`effectId`, `name`, `args` — never `resume`) to its caller.
   Publishing that work to a queue, and any transactional-outbox machinery, is
   the host's job. The driver only guarantees ordering: nothing is exposed for
   dispatch before it is durable.

7. **Deployment pinning is a mandatory opaque string.** The host supplies
   `deploymentId: string` (a version, git SHA, content hash — the driver does
   not interpret it). It is written into every record at creation. On resume,
   a mismatch between the record and the current configuration throws
   `DeploymentMismatchError` and leaves the record untouched; the operator
   decides whether to migrate or explicitly fail the workflow. It is not a
   guest-visible value.

8. **Fuel is per-invocation.** Each driver invocation gets a fresh
   `ExecutionLimits` from host configuration. The record accumulates
   `fuelUsed` across hops for observability only; there is no cross-hop
   budget enforcement in v1. Exceeding per-invocation limits fails the
   workflow (terminal), like any other runtime error.

9. **Serialization is exposed only as a workflow-record codec.** No generic
   `Suspended` helper is exported. `serializeWorkflowRecord` /
   `hydrateWorkflowRecord` validate the record shape, re-mark embedded
   `@task` nodes with the existing recursive walk, and re-apply the `raw`
   inertness mark to continuation closures (`pending.resume` and the resume
   basis). The mark is a `WeakSet` membership, so it never survives
   `JSON.parse`; the codec restores creation-time state rather than relying on
   the mark being unnecessary.

10. **Inline capability exceptions fail the workflow.** A thrown host
    exception during an inline effect becomes a terminal `failed` record with
    `code: "host"`. Hosts that want guest-visible errors declare them in the
    effect's result contract and return them in-band. The driver never
    converts a host exception into a guest `raise`.

11. **External failure of suspended work uses `deliverFailure`.** For a
    suspending effect whose external work dies, the host either delivers an
    in-band error value (if the result contract declares one) via
    `deliverCompletion`, or calls `deliverFailure(workflowId, effectId,
    failure)`, which claims the suspension and writes a terminal `failed`
    record. Same claim semantics as completion: stale deliveries are no-ops.

12. **Join aggregation is example infrastructure, not driver core.** The core
    store indexes by workflow ID and effect ID only. Buffering partial
    results for `agent.awaitAll` (two of three subagents done, one running)
    lives in the example's in-memory orchestration host, which maps subagent
    completions onto single workflow-level completion deliveries. The
    orchestration environment contracts are fixed in this plan (see
    **Orchestration example**) so the example can be written without further
    design work.

13. **No dependency on stateful handler shorthand.** The deterministic
    in-language mock in the acceptance example uses the manual
    state-transformer expansion (`(handle task -> (State) -> Result with
    {...})(initial)`). It migrates to the shorthand when that lands;
    neither track blocks the other.

14. **Slice 0 is a validation spike.** The plan's load-bearing assumption —
    that a `resume` closure produced by `stepTask` survives a JSON round trip
    and resumes correctly in a freshly prepared runtime — currently has almost
    no test coverage (one hand-built round trip in
    `typescript/test/prepared-program.test.ts`). Proving it is the first
    slice, before any driver code. If it fails, this plan is revised rather
    than patched around.

## Non-goals

- A general workflow service, scheduler, queue, or database implementation.
- Exactly-once execution of external side effects.
- A per-effect event journal (see decision 2).
- Parallel branches inside the task kernel; no new task node kinds or
  evaluator changes.
- Worker leases, heartbeats, or automatic crash detection. Deciding *when* a
  `running` record is abandoned is a host/deployment concern; the driver only
  makes re-running it safe.
- Cancellation of in-flight subagents (see **Orchestration example**).
- Cross-hop fuel budgets (decision 8).
- Persisting stateful-handler state through a separate channel; stateful
  partial handlers.
- CLI support.
- Bringing the Go, Python, or Rust interpreters to parity.

## Current code inventory

What the driver builds on, with post-reorganization paths:

- `typescript/src/task.ts` — `stepTask` normalizes a task to
  `{ done } | { pending: { name, args, resume } }`; `resume` is a
  self-contained raw-marked closure built by `buildStepResume`.
- `typescript/src/host/run-task.ts` — `runTask`, the run-to-completion
  trampoline, now branching on `isTaskReturn`. Its per-hop logic (raise →
  `TaskRaiseError`, unknown effect → `RuntimeContractError`, effect argument
  and result contracts, `call(resume, [checked])`) is what slice 2 extracts.
- `typescript/src/host/environment-runtime.ts` —
  `prepareEnvironmentRuntime`: registry/contract parity, host-function
  wrapping, and the effect/capability parity check that decision 4 relocates.
- `typescript/src/host/task-serialization.ts` — `serializeTask` /
  `hydrateTask` and the recursive `@task` re-mark walk the codec reuses.
- `typescript/src/eval/program.ts` — `prepareProgram`: one prepared module
  scope, shared execution state, `invokeEntry` / `call` / `meter` /
  `refreshDeadline`.
- `typescript/src/environment/` — environment types, effect manifest
  validation, `buildEffectNamespace`, `EFFECTS_BINDING`, `isTaskReturn`,
  `entryCompletionType`.
- `typescript/src/utils.ts` — `raw` / `isRaw` (`WeakSet`-based, identity-keyed;
  the reason hydration must re-mark).

New code lives in `typescript/src/host/durable/` and is exported through
`typescript/src/host/index.ts`.

## Public API

Shapes below are the committed design. Field names may be adjusted during
implementation; structure and semantics may not.

### Configuration

```typescript
type DurableHostConfiguration = {
  registry: FunctionRegistry;
  /** Every environment effect, exactly once. */
  effects: Record<string, "inline" | "suspending">;
  /** Exactly the inline effects. */
  capabilities: Record<string, DurableCapability>;
  /** Opaque version pin written into records and checked on resume. */
  deploymentId: string;
  limits?: ExecutionLimits;
};
```

Validation at driver construction:

- entry must be task-mode (decision 1);
- `effects` keys must equal the environment's effect names exactly;
- `capabilities` keys must equal the inline effect names exactly;
- `"raise"` may not appear in either.

### Workflow record

```typescript
type PendingEffect = {
  effectId: string;
  name: string;
  args: JSONType[];
  resume: JSONType;
};

type RunningBasis =
  | { kind: "start"; args: JSONType[] }
  | { kind: "resume"; pending: PendingEffect; result: JSONType };

type WorkflowFailure = {
  code:
    | "raise"            // unhandled guest raise; payload holds the raise value
    | "contract"         // runtime contract violation (args, results, completion)
    | "unknown-effect"   // effect name absent from the manifest
    | "malformed-task"   // stepTask structural error
    | "limit"            // fuel / depth / size / timeout
    | "host"             // inline capability threw (decision 10)
    | "external";        // deliverFailure (decision 11)
  message: string;
  payload?: JSONType;
};

type WorkflowRecord = {
  workflowId: string;
  revision: number;
  deploymentId: string;
  /** Sequence number the next stepped effect receives when advancing from
      this record's basis. */
  effectSequence: number;
  /** Cumulative, informational only (decision 8). */
  fuelUsed: number;
} & (
  | { status: "running"; basis: RunningBasis }
  | { status: "suspended"; pending: PendingEffect }
  | { status: "completed"; result: JSONType }
  | { status: "failed"; failure: WorkflowFailure }
);
```

A `running` record is not an in-flight marker that goes stale — it is the
durable basis from which the current advance is (re)computable. Re-running it
is always safe under decision 2.

### Store contract

```typescript
type ClaimOutcome =
  | { claimed: WorkflowRecord } // now running with a resume basis
  | { stale: true };            // wrong status, wrong effectId, or terminal

interface WorkflowStore {
  /** Fails if workflowId already exists. */
  create(record: WorkflowRecord): Promise<void>;
  /** Compare-and-set on revision; fails (distinguishably) on mismatch. */
  transition(expectedRevision: number, record: WorkflowRecord): Promise<void>;
  /**
   * Atomically: if the workflow is suspended on exactly this effectId,
   * transition it to running with a resume basis and revision + 1.
   * Anything else returns { stale } without modifying the record.
   */
  claim(workflowId: string, effectId: string, result: JSONType): Promise<ClaimOutcome>;
  read(workflowId: string): Promise<WorkflowRecord | undefined>;
  /** Recovery scan: running and suspended workflows. */
  listNonterminal(): Promise<string[]>;
}
```

CAS on `revision` is what makes two workers or two duplicate completions
safe: the loser's `transition` fails and its computed state is discarded. Its
inline side effects may already have run — that is the at-least-once window
decision 2 accepts and the `effectId` obligation covers.

The reference implementation is an in-memory store used by tests and the
example only.

### Driver

```typescript
type AdvanceOutcome =
  | { status: "completed"; result: JSONType }
  | { status: "failed"; failure: WorkflowFailure }
  | { status: "suspended"; pending: { effectId: string; name: string; args: JSONType[] } };

type DeliveryOutcome = AdvanceOutcome | { status: "stale" };

function createDurableDriver(options: {
  module: Record<string, JSONType>;
  environment: Environment;
  host: DurableHostConfiguration;
  store: WorkflowStore;
}): {
  /** Validate entry args, persist the start basis, advance. */
  start(workflowId: string, args: JSONType[]): Promise<AdvanceOutcome>;
  /** Claim the suspension, validate the result, resume, advance. */
  deliverCompletion(
    workflowId: string,
    effectId: string,
    result: JSONType,
  ): Promise<DeliveryOutcome>;
  /** Claim the suspension and write a terminal failure (decision 11). */
  deliverFailure(
    workflowId: string,
    effectId: string,
    failure: { message: string; payload?: JSONType },
  ): Promise<DeliveryOutcome>;
  /** Re-run a running record from its persisted basis after a crash. */
  recover(workflowId: string): Promise<AdvanceOutcome>;
  read(workflowId: string): Promise<WorkflowRecord | undefined>;
};
```

Notes:

- `resume` closures never leave the driver; outcomes expose only the pending
  descriptor.
- Every invocation rebuilds the runtime from `module` + `environment` +
  configuration. Nothing lives across calls except the store.
- `deliverCompletion` validates the external result against the effect's
  declared result contract **after** claiming; a validation failure writes a
  terminal `failed` record (`code: "contract"`), because the claim has already
  consumed the suspension and retrying with the same bad payload cannot
  succeed.
- Serialization: `serializeWorkflowRecord(record): string` and
  `hydrateWorkflowRecord(serialized): WorkflowRecord` per decision 9. Store
  implementations that persist as text use the codec; the in-memory store
  round-trips through it deliberately, so every test exercises hydration.

## Execution model

### Advance loop

`start`, `deliverCompletion` (after a successful claim), and `recover` all
enter the same loop, beginning from a `running` record:

```text
basis "start":   task = invokeEntry(validated args)
basis "resume":  task = applyResume(pending.resume, validated result)

loop:
  stepTask(task)
    -> done
       validate against entryCompletionType
       CAS transition -> completed          (terminal)

    -> pending { name, args, resume }
       name == "raise"        -> CAS transition -> failed (code "raise")
       unknown effect         -> CAS transition -> failed (code "unknown-effect")
       validate args against manifest; failure -> failed (code "contract")
       effectId = `${workflowId}:${sequence}`; sequence += 1

       inline:
         result = capability({ workflowId, effectId }, ...args)
         throw               -> CAS transition -> failed (code "host")
         validate result; failure -> failed (code "contract")
         task = applyResume(resume, result); continue

       suspending:
         CAS transition -> suspended { effectId, name, args, resume },
                           effectSequence = sequence
         return { status: "suspended", pending descriptor }
```

Any evaluator error (malformed task, fuel, depth, timeout) maps to the failure
codes above and is written as a terminal state via the same CAS transition.
If a CAS transition itself fails (another worker won), the driver discards its
computed state and returns the store's current record as the outcome.

### Effect identity

`effectId` is `` `${workflowId}:${sequence}` ``. The sequence counter starts
at the record's `effectSequence` and increments once per stepped effect —
inline and suspending alike. Because the guest is deterministic and inline
capabilities must be result-deterministic per `effectId` (decision 2),
re-running the advance from the same persisted basis allocates identical IDs
to identical effects. The suspended record stores the suspending effect's ID
in `pending.effectId`; the running record written by `claim` stores
`effectSequence` = that ID's sequence + 1.

### Error mapping parity with `runTask`

The shared task runtime (slice 2) guarantees both drivers agree on:

- entry argument and completion validation;
- effect argument and result validation;
- `raise` semantics (`TaskRaiseError` in `runTask`; `code: "raise"` here);
- unknown-effect semantics;
- `resume` application through the metered `call`.

`runTask` surfaces errors as exceptions; the durable driver additionally
persists them as terminal records. The underlying detection is one code path.

## Persistence and hydration

`hydrateWorkflowRecord` must:

- reject structurally malformed records (unknown status, missing fields,
  non-array args) with a dedicated error, before any evaluation;
- run the recursive `@task` re-mark walk (shared with `hydrateTask`) over the
  whole record;
- re-apply `raw` to `pending.resume` and to `basis.pending.resume` when
  present (decision 9);
- leave everything else untouched — no closure or task re-encoding.

`serializeTask` / `hydrateTask` remain exported for top-level tasks; the
record codec composes the same walk rather than duplicating it.

## Orchestration example

One typed example, `examples/orchestration.*`, with these fixed environment
contracts:

- `AgentSpec`, `Handle`, `AgentResult`, `Report` named types. `AgentResult`
  is a tagged union that includes failure in-band, e.g.
  `{ ok: true, output: ... } | { ok: false, error: string }`.
- `agent.spawn(spec) -> Handle` — **inline**.
- `agent.await(handle) -> AgentResult` — **suspending**. Subagent failure
  arrives as `ok: false`; it does not fail the workflow.
- `agent.awaitAll(handles) -> AgentResult[]` — **suspending**. Results in
  handle order; failures in-band; no aggregate host-level failure.
  `awaitAll([])` still suspends; the orchestration host delivers `[]`
  immediately. The guest does not special-case empty joins.
- `agent.awaitAny(handles) -> { handle: Handle, result: AgentResult }` —
  **suspending**. Losers keep running; their later completions hit a workflow
  no longer suspended on that effect ID and come back `stale`. Cancellation
  is explicitly out of scope for v1.
- `log(message) -> null` — **inline**.

The guest module demonstrates a sequential pipeline (one agent's output feeds
the next spawn) and fan-out/fan-in (spawn several, one `awaitAll`), with the
spawn-all-then-join recursion pattern from the design sketch.

Two hosts run the same guest module:

- a deterministic in-language mock using the manual state-transformer handler
  expansion (decision 13), with canned results and an event transcript;
- a durable test host: in-memory store plus an orchestration adapter that
  tracks which workflow+effectId waits on which handles, buffers partial
  results for `awaitAll`, and calls `deliverCompletion` when a join is
  satisfied. The adapter is test infrastructure; its buffering state is
  ordinary adapter data, not driver or store state.

## Implementation slices

Each slice lands green (`bun run check`, `bun test`) before the next starts.

### 0. Continuation round-trip spike (tests only)

In `typescript/test/`, prove that a real `stepTask`-produced `resume`
survives `JSON.stringify`/`JSON.parse` plus re-marking and resumes correctly
in a **freshly prepared** runtime (new `prepareProgram` from the same module
JSON, all prior runtime objects discarded). Cover continuations containing:

- recursive local functions;
- nested tasks and multi-effect `do` chains;
- an in-language `handle` wrapping the suspension point;
- state-transformer handlers holding accumulated state across the suspension.

Also add direct coverage for `serializeTask`/`hydrateTask` beyond the single
existing case. Any failure here stops the plan for redesign.

### 1. Relocate capability parity

Split the effect/capability parity check out of `prepareEnvironmentRuntime`
into the `runTask` path (behavior-preserving; existing
`EnvironmentConfigurationError` messages and tests unchanged). This unblocks
durable configuration validation without weakening `runTask`.

### 2. Extract the shared task runtime

New `typescript/src/host/task-runtime.ts`:

```typescript
function prepareTaskRuntime(
  module: Record<string, JSONType>,
  environment: Environment,
  registry: FunctionRegistry,
  limits?: ExecutionLimits,
): {
  validateArgs(args: JSONType[]): JSONType[];
  invokeEntry(args: JSONType[]): JSONType;
  /** stepTask + raise / unknown-effect / arg-contract handling. */
  step(task: JSONType): { done: JSONType } | { pending: PendingStep };
  /** Validates result against the effect contract, then call(resume, [checked]). */
  applyResume(resume: JSONType, name: string, result: JSONType): JSONType;
  validateCompletion(value: JSONType): JSONType;
  refreshDeadline(): void;
  fuelUsed(): number;
}
```

It owns the `EFFECTS_BINDING` guard, effect-namespace injection,
`prepareProgram`, and definition merging. Rewrite `runTask` on top of it;
capability dispatch stays in `run-task.ts`. `runTask`'s public behavior,
including direct-entry execution, is unchanged — verified by the existing
`environment.test.ts` and `example-environments.test.ts` suites.

### 3. Workflow record and codec

`typescript/src/host/durable/workflow-record.ts`: the `WorkflowRecord` types,
structural validation, `serializeWorkflowRecord`, `hydrateWorkflowRecord`
(re-mark walk shared with `task-serialization.ts`, `raw` re-application).
Tests: malformed-record rejection, round trips for every status, and a resumed
continuation from a hydrated record in a fresh runtime (reusing slice 0
fixtures).

### 4. Durable configuration and store

`typescript/src/host/durable/config.ts`: `DurableHostConfiguration`
validation per **Public API**, including task-entry enforcement.
`typescript/src/host/durable/store.ts`: the `WorkflowStore` interface and the
in-memory reference store (serializing through the codec on every write/read).
Tests: classification parity errors, CAS conflicts, claim/stale matrix
(wrong status, wrong effectId, terminal, duplicate claim).

### 5. Driver

`typescript/src/host/durable/driver.ts`: `createDurableDriver` with `start`,
`deliverCompletion`, `deliverFailure`, `recover`, `read`, implementing the
advance loop, effect-sequence accounting, deployment-pin check, and failure
mapping. Tests:

- inline-only workflow completes in one `start`;
- suspend → serialize store contents → new driver instance from the same
  deployment inputs → `deliverCompletion` → completion (process boundary
  simulated by discarding all runtime objects);
- duplicate and stale completions return `{ status: "stale" }` and never
  re-run a continuation;
- crash-mid-advance: re-`recover` from a running basis replays inline effects
  with identical `effectId`s (asserted via a recording capability);
- every failure code, including `deliverFailure` and deployment mismatch;
- fuel accumulation across hops in `fuelUsed`.

### 6. Orchestration example and acceptance coverage

The example module, environment, in-language mock, and durable test host per
**Orchestration example**. Acceptance tests run the same guest module under
both hosts and assert equal reports; durable-side tests cover pipeline,
fan-out/fan-in, empty `awaitAll`, in-band subagent failure, `awaitAny` with a
losing straggler (stale delivery), and duplicate join completions.

### 7. Documentation

A durable-host section in `docs/` covering: inline versus suspending
configuration; the store consistency contract; deployment pinning;
at-least-once execution and the inline result-determinism obligation
(decision 2, prominently); stable effect IDs; duplicate/stale handling; and
the failure-code table. Update `AGENTS.md` pointers if a new doc file is
added.

## Acceptance criteria

- A workflow can suspend, be serialized, lose all live runtime state, and
  resume to the same result in a newly prepared runtime built only from
  deployment inputs plus stored JSON.
- Inline and suspending effects enforce the same environment contracts as
  `runTask`, through the shared task runtime.
- The driver never awaits a suspending capability; suspended work is exposed
  only after its record is durable.
- A stale or duplicate completion (or failure delivery) can never run a
  continuation twice; it yields an explicit `stale` outcome.
- Re-running an advance from the same persisted basis presents identical
  `effectId`s to inline capabilities.
- Unhandled `raise`, contract violations, unknown effects, malformed tasks,
  execution limits, inline host exceptions, and external failures all produce
  terminal records with the documented failure codes.
- Fan-out runs out of band and joins resume through ordinary effect results;
  no parallel task node exists.
- The in-language mock needs no driver-specific state support.
- The orchestration example passes under both the deterministic mock and the
  durable in-memory host.

## Deferred work

Explicitly out of this plan, tracked for later consideration:

- worker leases / abandoned-`running` detection;
- an inline-result journal for hosts that cannot meet the determinism
  obligation;
- cross-hop fuel budgets enforced from persisted usage;
- subagent cancellation effects and `awaitAny` loser cancellation;
- stateful partial handlers that keep local state while durable effects
  bubble;
- migrating the example mock to stateful handler shorthand when it lands;
- CLI integration and non-TypeScript implementations.
