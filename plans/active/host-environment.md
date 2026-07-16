# Typed host environment

## Goal

An operator defines an **environment** — a bundle of named types, direct
callable contracts, typed effect capabilities, and an entrypoint contract — and
hands it to both the checker and the runtime. An agent then writes guest `.jfn`
code against that environment:

- it references the operator's types as if they were built in;
- it calls the operator's direct functions and effect capabilities and gets
  precise result types back, so it understands the API surface it is coding
  against; and
- it implements an entrypoint whose signature the operator declared.

The information flows operator → agent. The operator is the source of truth for
the environment, and the checker the agent uses is preloaded with it. This
matters most for capabilities with large API surfaces and complex types, where
the agent cannot be expected to already know the shapes involved.

### Primary use case: durable agent orchestration

A motivating target is agents writing orchestration scripts that spawn
subagents. Those subagents run asynchronously and may take minutes or hours; the
script pipelines their results and spawns further work. The operator defines the
capabilities for spawning agents and reading their state/output; the guest script
orchestrates. Such a script must be **durable**: stored, rehydrated, and resumed
across process boundaries over long periods, not held in a live process while it
waits.

This use case is the strongest driver for the typed environment (a large,
complex capability surface the agent must understand) and for `Task<A>` (results
pipelined through `bind` are useless as opaque `Task`). It also adds a durable
execution requirement covered by workstream B6.

The portable callable format and host-language type-rule extension point are
planned separately in [callable-contracts.md](callable-contracts.md). The
cross-plan sequencing is summarized in
[typed-environment-roadmap.md](typed-environment-roadmap.md).

## Context in the code

### The effect kernel

A task is an inert tagged JSON record with three node kinds
(`typescript/src/task.ts`):

```
{ "@task": "effect", name, args }
{ "@task": "pure", value }
{ "@task": "bind", task, then }
```

`perform`/`pure`/`bind`/`raise` are data constructors registered in
`typescript/src/stdlib.ts`; `perform` only builds an `effect` node and never
calls host code. `raise(e)` is `perform("raise", [e])`. Real work happens only
when a task is run.

`runTask` (`typescript/src/host.ts`) is the host trampoline: it steps the task,
and on a pending effect looks up `capabilities[name]`, `await`s it, and resumes
the continuation with the result. `raise` is special-cased into a
`TaskRaiseError`; a missing capability is an `UnhandledEffectError`. The
capability table is a bare `Record<string, (...args) => JSONType>` with no
schemas — arguments and results are untyped `JSONType`.

`requiredCapabilities` provides name-level admission only (which effect names a
program can reach). It does not carry types and does not subtract effects
discharged by an in-language `handle`.

### Durability primitives already exist

When a task suspends on an effect, `stepTask` folds the remaining work into a
plain-JSON `resume` closure (escaping-closure capture, `buildStepResume` in
`task.ts`), so continuations are self-contained JSON. `serializeTask` /
`hydrateTask` (`typescript/src/host.ts`) round-trip a task across process
boundaries; `hydrateTask` re-marks `@task` nodes as inert (the `raw()` marks live
in a `WeakSet` and do not survive JSON). The kernel was designed for
suspend → persist → rehydrate → resume.

Two facts constrain the orchestration use case:

- **`stepTask` suspends on one effect at a time** — a task has a single
  continuation stack, not parallel branches. Real concurrency therefore lives in
  the host: `spawn` returns a handle immediately (subagent runs out-of-band), and
  a join effect (`await` / `awaitAll`) is the suspension point. The script owns
  orchestration; the host owns concurrency and durability.
- **`runTask` is run-to-completion in a single process.** It `await`s each
  capability inline and never persists mid-run. It suits fast effects, not an
  hours-long `await`. Its own doc comment already notes the at-least-once /
  idempotency-key reality of durable resume.

### The shared runtime validator already exists

`typescript/src/runtime-contract.ts` validates concrete data against a schema
and, for `$fnType` schemas, installs a serializable callable wrapper
(`$runtimeContract` metadata: `{ schema, defs, target }`) that validates
eventual arguments and return values. `enforceRuntimeContract` is the entry
point; `RuntimeContractError` distinguishes a failed declared boundary.

This validator is currently wired only to the annotated three-argument form of
`handle` (`handle task -> ResultType with { ... }`), which validates the
handler's produced value at the boundary and rejects an unmatched effect instead
of bubbling. It is not yet used for host inputs, outputs, or capabilities. New
boundary work should reuse it rather than introduce a second validator.

### The definition pool is asymmetric

The checker resolves `$ref` against `spec/builtins.json` `$defs` merged with
module `$types`, module winning (`typescript/src/check/module.ts`). The runtime
carries **module `$types` only** — builtin `$defs` such as `Task` are not in
`runtime.defs`. The runtime context channel that would carry them already
exists: builtins receive `runtime.defs` as a separate argument
(`typescript/src/evaluate.ts`, `typescript/src/types.ts` `RuntimeContext` /
`EvaluationContext.runtimeDefs`), and `handle` is its only consumer today.

### `Task` is opaque, and it erases capability results

Statically, `Task` is the coarse floor `{ "@task": string }` in
`spec/builtins.json`. `perform`/`pure`/`bind`/`raise` all return that floor;
two-argument `handle` returns top. There is no completion type, so a capability
result cannot flow out of `perform`/`bind` into a continuation.

### What the examples show

`examples/typed/thermostat.jfn` and `examples/dungeon.jfn` are the closest
existing programs to the goal, and they demonstrate the gap by flowing
information the wrong way — the guest declares the whole environment:

- both hand-declare `type Task = { "@task": string, ... }` as an opaque stand-in
  because there is no completion type;
- both declare their capability record and its wiring in guest code
  (`dev()` → `perform("sensor.read", [])`, `io()` → `perform("input", [])`),
  including the raw effect-name strings;
- capability results are typed as bare `Task`, so `bind(dev().read(), (reading)
  => ...)` gives `reading: any`;
- the hosts (`typescript/examples/thermostat.ts`, `dungeon.ts`) supply
  capabilities as untyped functions and pick the entry and initial args as
  untyped values in the `runTask(module, entry, args, stdlib, capabilities)`
  call.

The operator contributes no types to the checker; every type the agent sees, it
wrote itself. The `-checked` cousin of the thermostat exists only to work around
the `Task` erasure.

## Plan

B1 is foundational and small. B1.5 establishes the callable-contract and
host-language rule substrate needed before operators can add typed direct
functions or complex HOFs. B2–B5 are a co-dependent epic that only delivers the
typed-environment goal together. B6 is the durable driver for the orchestration
use case; it builds on the same primitives but is independent of most type work
and can proceed in parallel.

```
B1 unify def pool ─> B1.5 callable contracts/rules ─┬─> B2 effect manifest ─┐
                                                    ├─> B3 Task<A> index ───┼─> B4 environment/entry ─> B5
                                                    └─> host functions ─────┘

B6 durable driver   (uses serializeTask/hydrateTask + the manifest; parallel track)
```

### B1 — Unify the definition pool

Status: complete.

Thread builtin `$defs` and the environment's `$defs` into `runtime.defs`
alongside module `$types`, with explicit precedence:
`builtin $defs` < `environment $defs` < `module $types`. Everything that resolves
`$ref` at the runtime boundary depends on the runtime and checker agreeing on
this pool.

The TypeScript implementation now centralizes that merge in
`definition-pool.ts`. Checker entrypoints accept the environment layer, runtime
entrypoints accept explicit builtin/environment definition sources, and the CLI
supplies the canonical builtin definitions. The merged pool is propagated
through the existing runtime context to boundary contracts. Tests cover all
three precedence layers and both checker/runtime resolution.

### B1.5 — Portable callable contracts and type rules

Complete the substrate in
[callable-contracts.md](callable-contracts.md) before B2–B4:

- every core or host callable has validated portable fallback signatures;
- complex call-dependent typing is named by an optional, namespaced rule;
- checker entrypoints receive an injected rule registry instead of switching on
  a closed set of rule names;
- current hardcoded rule floors and name-based return refinements migrate to
  that mechanism; and
- core and operator callable tables merge through a public, explicit API.

An unavailable rule retains its fallback checks and reports a coverage
degradation. This keeps the environment useful across implementations while
accepting that precise rules for `pipe`, `perform`, `bind`, or a host-defined
HOF must be implemented in the host language.

The HOF correctness work in
[hof-type-corrections.md](hof-type-corrections.md) is mostly independent.
`flatMap` is intentionally the first precision rule built on B1.5.

### B2 — Effect manifest

A language-agnostic data file (in `spec/`) mapping each effect name to its
positional argument schemas and its result schema, reusing the same tractable
schema fragment and `$defs` vocabulary as the checker and runtime validator.

- **Checker:** a literal `perform("name", args)` checks its arguments and
  recovers the effect's result schema through the environment-aware
  `core.perform` rule established by B1.5.
- **Runtime:** `runTask` validates outgoing effect arguments before invoking the
  capability and validates the returned value before resuming, using
  `runtime-contract.ts`. No schema lives inside a capability function.

Dynamic effect names cannot be resolved statically and remain a reported
degradation and an operator-policy admission case; unknown literal effects are
errors on both sides.

### B3 — Erased `Task<A>` index

A distinguished checker node like `$fnType`, fully erased at runtime (the inert
task records are unchanged). Wire the effect builtins to thread a completion
type: `pure(A) -> Task<A>`, `bind(Task<A>, (A) -> Task<B>) -> Task<B>`,
manifest-backed `perform(...) -> Task<ResultOfName>`, `raise -> Task<never>`.
Guest signatures keep writing bare `Task` (= `Task<unknown>`); no guest
generics. Track only the completion type, not an effect set.

This is a co-requisite of B2, not optional follow-up: without it, the manifest's
result types are known but never reach the agent's `bind`/`do` continuations.
The orchestration use case makes this concrete — a pipeline that binds a
subagent `Handle` and then its `AgentResult` is unusable if both erase to opaque
`Task`.

### B4 — Environment, direct functions, and entry contract

Package `{ $defs, functions, effects, entry }` as the operator-owned artifact:

- `functions` declares direct host-callable contracts using B1.5's portable
  fallback signatures and optional rule IDs;
- `effects` declares host capability argument and result schemas;
- `entry` declares `{ name, params, returns }`; and
- `$defs` supplies the shared domain vocabulary used by all three.

Runtime function implementations, effect capabilities, and host-language type
rules remain a separate host configuration matched against this portable
artifact. `runTask` (and the CLI) take the environment; the checker verifies the
guest entry and validates entry/initial-state arguments at the boundary.
Tractable direct host-function arguments/results use the existing runtime
contract machinery.

Optional stretch: hand the agent a capability record derived from the effect
manifest so it never writes raw `perform` strings.

### B5 — Migrate the examples

Convert `thermostat` and `dungeon` to consume the environment. Delete the
`type Task = { "@task": string, ... }` stand-ins, the guest-authored
`dev()`/`io()` wiring, and the `-checked` cousin where the `Task` erasure was its
only reason to exist. This is the acceptance test for the epic.

### B6 — Durable orchestration driver

A driver, distinct from run-to-completion `runTask`, that persists and resumes a
workflow across process boundaries. It builds on `stepTask` and
`serializeTask`/`hydrateTask`, adding:

- **A suspension-point policy.** The manifest (or host config) marks which
  effects suspend (e.g. `agent.await`, `agent.awaitAll`) versus which run inline
  and fast (e.g. `agent.spawn`, `log`). On a suspending effect the driver
  persists the continuation and returns control instead of blocking; on an
  external completion event it rehydrates and resumes.
- **A resume-continuation serializer** alongside `serializeTask`/`hydrateTask`.
  `stepTask`'s `resume` is self-contained JSON; the driver needs to persist and
  restore it (re-marking `@task` nodes via the existing `remark` walk), not only
  a top-level task value.
- **Workflow/handle identity and storage.** A store maps a subagent `Handle` to
  the suspended workflow it should resume, holds the persisted continuation, and
  records completion/failure. Storage is the host's; the driver defines the
  contract it needs.
- **Concurrency/join conventions.** Because the kernel suspends one effect at a
  time, fan-out is `spawn`-all-then-join: `spawn` returns a handle immediately and
  standard `awaitAll`/`awaitAny` join capabilities resolve when the underlying
  subagents finish. These conventions belong in the manifest.
- **Idempotency / at-least-once guidance.** A crash between running a capability
  and persisting the resumed workflow reruns the effect on recovery. Capabilities
  with external side effects (spawning especially) need idempotency keys or
  deterministic handles. Promote this from the current `runTask` comment into the
  contract.

The same script runs under a mock in-language `handle` (deterministic tests with
canned results) and the durable driver (production), because effects bubble to
whichever handler is outermost. That testability is a property to preserve.

## Target state

With B1–B4, the operator authors the environment once and the runtime validates
the boundary:

```typescript
const env = {
  $defs: {
    Mode:    { enum: ["heat", "cool", "off"] },
    Reading: { type: "object", required: ["temp", "battery"],
               properties: { temp: { type: "number" },
                             battery: { type: "integer", minimum: 0, maximum: 100 } } },
    State:   { type: "object", required: ["config", "mode"], properties: { /* … */ } },
  },
  functions: {
    "reading.label": {
      signatures: [{
        params: [{ $ref: "#/$defs/Reading" }],
        returns: { type: "string" }
      }]
    }
  },
  effects: {
    "sensor.read": { params: [], returns: { anyOf: [{ $ref: "#/$defs/Reading" }, { type: "null" }] } },
    "hvac.set":    { params: [{ $ref: "#/$defs/Mode" }], returns: { type: "null" } },
    "log":         { params: [{ type: "string" }], returns: { type: "null" } },
  },
  entry: { name: "loop",
           params: [{ $ref: "#/$defs/State" }, { type: "integer" }],
           returns: { task: { $ref: "#/$defs/State" } } },
};

await runTask(controller, env, [start, 100], {
  registry: { ...createStdlib(), "reading.label": readingLabel },
  capabilities,
  typeRules,
});
```

The agent no longer declares `Task`, `Reading`, `Mode`, direct host-function
types, or the `perform` wiring — those are injected. Capability results carry
their types:

```jfn
// Reading, Mode, State, and Task<_> come from the environment.
loop: (st: State, fuel: integer) -> Task<State> =>
  if fuel <= 0 then pure(st)
  else bind(perform("sensor.read", []), (reading) =>   // reading : Reading | null
    if isNull(reading) then pure(st)
    else bind(onReading(st, reading), (next) => loop(next, fuel - 1))),
```

`reading` flows as `Reading | null` and narrows; `loop` is checked against the
declared entry signature; outgoing args and capability results are validated at
runtime.

### Orchestration target state

With the same machinery plus B6, an orchestration script references injected
types (`AgentSpec`, `Handle`, `AgentResult`, `Report`) and pipelines subagents.
`spawn` is fast and non-blocking; each `await`/`awaitAll` is a durable
suspension point:

```jfn
// AgentSpec, Handle, AgentResult, Report and the effect signatures are injected.
{
  spawn:    (spec: AgentSpec) -> Task<Handle>        => perform("agent.spawn", [spec]),
  await:    (h: Handle)       -> Task<AgentResult>   => perform("agent.await", [h]),
  awaitAll: (hs: Handle[])    -> Task<AgentResult[]> => perform("agent.awaitAll", [hs]),

  // pipelining: researcher output feeds the writer
  writeReport: (topic: string) -> Task<Report> => do {
    rh       <- spawn({ role: "researcher", input: topic }),
    research <- await(rh),                       // research : AgentResult
    wh       <- spawn({ role: "writer", input: research.output }),
    draft    <- await(wh),
    pure({ topic: topic, draft: draft.output })
  },

  // fan-out / fan-in: spawn all (concurrent out-of-band), then one join
  spawnAll: (specs: AgentSpec[]) -> Task<Handle[]> =>
    if length(specs) == 0 then pure([])
    else bind(spawn(head(specs)!), (h) =>
         bind(spawnAll(tail(specs)), (rest) => pure(concat([h], rest)))),

  research: (topics: string[]) -> Task<Report[]> => do {
    handles <- spawnAll(map((t) => { role: "researcher", input: t }, topics)),
    results <- awaitAll(handles),                // suspends until all finish
    pure(map((r) => { topic: r.topic, draft: r.output }, results))
  }
}
```

## Scope

- **Completed:** B1 closes the checker/runtime `$ref` resolution gap with one
  explicit definition-pool precedence.
- **Next host-environment prerequisite:** B1.5, tracked in
  `plans/active/callable-contracts.md`.
- **Epic:** B2 + B3 → B4 → B5, tracked as one unit.
- **Durable driver:** B6, a parallel track on the same primitives; sequence
  against the orchestration use case rather than the typed-environment milestone.

## Resolved decisions

- **Named-type ownership and merging.** Core builtin definitions, operator
  environment definitions, and guest module definitions are separate explicit
  sources. Name collisions resolve by proximity to the guest:
  `builtin $defs` < `environment $defs` < `module $types`. The checker and
  runtime enforce the same order.

## Open decisions

- **Callable/effect ownership and naming.** Core contracts live in `spec/`, but
  a host must be able to select or extend callable and effect contracts. Settle
  their collision policy and decide whether host function/effect names are
  globally qualified. Named-type precedence is resolved above.
- **Type-rule delivery and trust.** Decide how a checker host supplies
  namespaced rule implementations, how rule API versions are negotiated, and
  which runtime validations remain possible for a callable whose precise type
  is computed by host-language code.
- **`Task<A>` surface.** Whether guest signatures may write a concrete
  `Task<Report>` or only bare `Task` (erased to `Task<unknown>`); whether a
  residual task preserves only its completion type. Start checker-internal with
  bare `Task` in guest code.
- **Capability record delivery.** Whether B4 hands the agent a manifest-derived
  capability record or leaves it writing `perform` directly.
- **Suspension-point declaration.** Whether an effect being a suspension point is
  declared in the manifest, in host driver config, or inferred — and how join
  capabilities (`awaitAll`/`awaitAny`) are represented so the driver and the
  checker agree on them.
