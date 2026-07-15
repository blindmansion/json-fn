# Typed host environment

## Goal

An operator defines an **environment** — a bundle of named types, typed
capabilities, and an entrypoint contract — and hands it to both the checker and
the runtime. An agent then writes guest `.jfn` code against that environment:

- it references the operator's types as if they were built in;
- it calls the operator's capabilities and gets precise result types back, so it
  understands the API surface it is coding against; and
- it implements an entrypoint whose signature the operator declared.

The information flows operator → agent. The operator is the source of truth for
the environment, and the checker the agent uses is preloaded with it. This
matters most for capabilities with large API surfaces and complex types, where
the agent cannot be expected to already know the shapes involved.

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

Five workstreams. B1 is foundational and small; B2–B5 are a co-dependent epic
that only delivers the goal together.

```
B1 unify def pool ─┬─> B2 effect manifest ─┬─> B3 Task<A> index ─┐
                   │                        │                     ├─> B5 migrate examples
                   └────────────────────────┴─> B4 entry contract ┘
```

### B1 — Unify the definition pool

Thread builtin `$defs` (and later the manifest's `$defs`) into `runtime.defs`,
which today carries module `$types` only. Fix precedence explicitly:
`builtin $defs` < `manifest $defs` < `module $types`. Everything that resolves
`$ref` at the runtime boundary depends on the runtime and checker agreeing on
this pool. Mostly plumbing in `evaluate.ts` and the runtime-contract context.

### B2 — Effect manifest

A language-agnostic data file (in `spec/`) mapping each effect name to its
positional argument schemas and its result schema, reusing the same tractable
schema fragment and `$defs` vocabulary as the checker and runtime validator.

- **Checker:** a literal `perform("name", args)` checks its arguments and
  recovers the effect's result schema (a code rule alongside the existing
  `handle` rule in `typescript/src/check/builtin-rules.ts`).
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

### B4 — Environment and entry contract

Package `{ $defs, effects, entry }` as the operator-owned artifact, where
`entry` declares `{ name, params, returns }`. `runTask` (and the CLI) take the
environment; the checker verifies the guest entry matches the declared signature
and validates the entry/initial-state arguments at the boundary. Optional
stretch: hand the agent a capability record derived from the manifest so it
never writes raw `perform` strings.

### B5 — Migrate the examples

Convert `thermostat` and `dungeon` to consume the environment. Delete the
`type Task = { "@task": string, ... }` stand-ins, the guest-authored
`dev()`/`io()` wiring, and the `-checked` cousin where the `Task` erasure was its
only reason to exist. This is the acceptance test for the epic.

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
  effects: {
    "sensor.read": { params: [], returns: { anyOf: [{ $ref: "#/$defs/Reading" }, { type: "null" }] } },
    "hvac.set":    { params: [{ $ref: "#/$defs/Mode" }], returns: { type: "null" } },
    "log":         { params: [{ type: "string" }], returns: { type: "null" } },
  },
  entry: { name: "loop",
           params: [{ $ref: "#/$defs/State" }, { type: "integer" }],
           returns: { task: { $ref: "#/$defs/State" } } },
};

await runTask(controller, env, [start, 100], createStdlib(), capabilities);
```

The agent no longer declares `Task`, `Reading`, `Mode`, or the `perform`
wiring — those are injected. Capability results carry their types:

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

## Scope

- **Now (with recenter):** B1. It is small, and it closes a latent soundness gap
  between checker and runtime `$ref` resolution.
- **Epic:** B2 → B3 → B4 → B5, tracked as one unit.

## Open decisions

- **Manifest ownership and merging.** The manifest lives in `spec/` as data, but
  a host must be able to select or extend it. Settle how manifest `$defs` merge
  with builtin `$defs` and module `$types` in both checker and runtime contexts
  (the B1 precedence rule is the starting point), and whether effect names are
  globally qualified.
- **`Task<A>` surface.** Whether guest signatures may write a concrete
  `Task<Report>` or only bare `Task` (erased to `Task<unknown>`); whether a
  residual task preserves only its completion type. Start checker-internal with
  bare `Task` in guest code.
- **Capability record delivery.** Whether B4 hands the agent a manifest-derived
  capability record or leaves it writing `perform` directly.
