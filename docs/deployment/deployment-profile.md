# Deployment profile

A deployment profile is portable JSON policy that selects how an
[environment contract](environment-contract.md) is hosted. It contains no
functions, credentials, queues, stores, abort signals, or timeouts. Executable
bindings and other process-local concerns belong to the runtime adapter.

Files conventionally use the `.profile.json` suffix. Version 1 supports live and
durable profiles.

## Live profile

```json
{
  "version": 1,
  "mode": "live",
  "effects": ["clock.now", "log.write"],
  "limits": {
    "maxCallDepth": 256,
    "maxFuel": 100000,
    "maxValueSize": 1000000
  }
}
```

`effects` is a required array of unique, non-empty effect names. When validated
with a contract, every name must be declared by `contract.effects`. The array is
a selected **subset**, not a coverage claim: declared effects may be omitted.
A pure module uses an empty array (and an empty adapter) — see
`examples/spreadsheet.profile.json`.

`prepareDeployment` requires the live runtime adapter's `effects` object to contain
exactly the selected names—no missing or extra implementations. `runTask` owns
the invocation until a direct entry returns or a task entry completes:

```ts
const deployment = prepareDeployment({
  module,
  contract,
  profile,
  adapter: {
    functions: { lookupUser },
    effects: {
      "clock.now": () => Date.now(),
      "log.write": (message) => {
        console.log(message);
        return null;
      },
    },
  },
});

const result = await runTask(deployment, args, {
  signal,
  timeoutMs: 30_000,
});
```

## Durable profile

```json
{
  "version": 1,
  "mode": "durable",
  "deploymentId": "orders-v7",
  "effects": {
    "cache.get": "inline",
    "approval.wait": "suspending"
  },
  "limits": {
    "maxFuel": 100000
  }
}
```

`deploymentId` is required and non-empty. Every selected effect is classified:

- **`inline`** runs inside a driver invocation. Its runtime-adapter capability receives
  `{workflowId, effectId}` before the guest arguments and may return a value or
  promise. Inline effects are at-least-once and must use `effectId` for
  idempotency when repetition is not naturally safe.
- **`suspending`** is persisted as pending work. It has no function in
  `adapter.effects`; application code observes the suspended outcome and later
  calls `deliverCompletion` or `deliverFailure`.

Durable entries must use `entry.returns: {"task": A}`. Preparation rejects a
direct entry. The driver API consumes the prepared deployment:

```ts
const driver = createDurableDriver({
  deployment: prepareDeployment({
    module,
    contract,
    profile,
    adapter: {
      functions: { lookupUser },
      effects: {
        "cache.get": ({ workflowId, effectId }, key) => cacheGet(key),
      },
    },
  }),
  store,
});
```

See [Durable task hosting](../runtime/durable-host.md) for storage, delivery, recovery, and
failure semantics.

## Exact runtime-adapter bindings

For both modes, `prepareDeployment` validates and links all four layers:

- `adapter` may contain only `functions` and `effects`;
- `adapter.functions` must implement **exactly every** contract `functions`
  name, regardless of which module paths happen to call it;
- live `adapter.effects` must implement exactly the names in the live
  `profile.effects` array;
- durable `adapter.effects` must implement exactly the names classified
  `"inline"`; a function for a `"suspending"` or omitted effect is extra and is
  rejected;
- every implementation value must be a function.

Mismatches throw `AdapterLinkError` with a stable code and path. Profile
structure errors throw `DeploymentProfileValidationError`
(`code: "INVALID_DEPLOYMENT_PROFILE"`).

## Omitted effects and guest handlers

Omitting a contract effect deliberately attenuates the host capability set. A
module may still mention that effect when an in-language `handle` always
discharges it before it reaches the host. The profile validator does not require
full effect coverage and deployment analysis is conservative; neither proves
that a guest handler catches every runtime path.

If an omitted declared effect reaches a live host boundary, `runTask` throws
`UnhandledEffectError`. In durable execution the same condition becomes a
terminal workflow failure with code `"unknown-effect"`. An effect absent from
the contract fails earlier as a runtime contract error when task stepping tries
to resolve its effect contract.

The intrinsic `raise` effect is never listed in a profile. An unhandled `raise`
becomes `TaskRaiseError` in live execution or a durable `"raise"` failure.

## Portable limits and host-local options

The optional profile `limits` object is closed and supports non-negative integer
values for:

- `maxCallDepth`
- `maxFuel`
- `maxValueSize`

These are portable execution policy and must be placed in the profile.
`runTask`'s third argument is only for host-local controls and instrumentation:

```ts
type HostLocalRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  perf?: PerfStats;
  usage?: ExecutionUsage;
};
```

Unknown run-option keys are rejected, including attempts to pass portable limits
there. Every prepared deployment exposes `createTaskSession(runOptions?)` and
returns a fresh session on each call. `runTask` and the durable driver use this
prepared-deployment method. The durable driver applies profile limits afresh on every start,
recovery, or delivery invocation. Its accumulated `fuelUsed` is observability,
not a cross-invocation budget. The public durable driver API currently accepts
no host-local timeout or abort options.

## Deployment analysis

`analyzeDeploymentCapabilities({module, contract, profile})` returns:

```ts
{
  possibleNames: string[];
  dynamic: boolean;
  profileBindings: string[];
  uncovered: string[];
}
```

It scans the canonical module for literal task effects, literal `perform`
calls, `raise`, and statically recoverable `effects.foo.bar` paths. `raise` is
removed from the report. Dynamic effect access sets `dynamic: true`; in that
case every contract effect omitted from the profile is conservatively
uncovered.

Analysis is non-fatal and intentionally over-approximates. It does not perform
control-flow reachability or subtract effects handled in-language. Operators
may use `uncovered` as an admission warning or enforce their own rejection
policy, but `prepareDeployment` itself preserves subset semantics.

## Validation API and CLI

The TypeScript package exports:

```ts
validateDeploymentProfile(value, contract);
const profile = loadDeploymentProfile(path, contract);
```

Supplying the contract checks that selected effects are declared. The CLI
requires it:

```sh
cd typescript
bun run src/cli.ts validate-profile \
  --contract ../examples/dungeon.contract.json \
  --file ../examples/dungeon.profile.json
```

Profile validation is structural. `prepareDeployment` is the separate linking
step that checks the module, contract, profile, and executable runtime adapter together.
