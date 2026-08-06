# Deployment profile

A deployment profile is portable policy for hosting an
[environment contract](environment-contract.md). It selects live or durable
execution, exposes a subset of the contract's effects, and sets portable
execution limits. It contains no executable bindings, credentials, stores,
queues, cancellation signals, or timeouts. Profile files conventionally use
`.profile.json`.

## Common rules

Every profile is a closed object with:

- `version`: the integer `1`;
- `mode`: `"live"` or `"durable"`;
- `effects`: the selected contract effects;
- `limits`: optional portable execution limits.

Selected effect names are non-empty and unique. When a profile is validated
with a contract, every selected effect must be declared by that contract.
`raise` is intrinsic and is never selected.

Selection is a subset, not a coverage claim. A contract effect may be omitted
when the module does not use it or handles it entirely in-language.

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

`effects` is an array. Each selected effect executes directly through its host
binding when task evaluation reaches it. The host owns execution until a
direct entry returns or a task entry completes.

A live deployment may use either a direct or task entry. A pure deployment uses
a direct entry and an empty effect selection.

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

`deploymentId` is a required non-empty string. `effects` maps each selected
effect to one execution class:

- `"inline"` executes within a workflow-driver invocation. Its host binding
  receives `workflowId` and `effectId` metadata in addition to the guest
  arguments. Delivery is at-least-once, so `effectId` is the idempotency key.
- `"suspending"` is persisted as pending work. It has no direct effect binding.
  The application observes the suspension and later delivers a completion or
  failure.

A durable deployment requires an entry with `returns: {"task": A}`. See
[Durable task hosting](../runtime/durable-host.md) for persistence, delivery,
recovery, and failure semantics.

## Executable bindings

Executable host bindings are supplied separately from the profile. Their shape
is exact:

- every contract function has one function binding;
- a live deployment has one effect binding for every selected effect;
- a durable deployment has one effect binding for every selected `"inline"`
  effect;
- omitted and `"suspending"` effects have no effect binding;
- no undeclared or unselected binding is present.

Every binding value is callable. These checks apply to the full contract and
profile, independent of which paths the module appears to execute.

## Omitted effects

Omitting an effect attenuates the host capability set. Profile validation does
not prove that every runtime path handles omitted effects.

If an omitted declared effect reaches the host boundary, live execution fails
as an unhandled effect and durable execution records a terminal
`"unknown-effect"` failure. An effect absent from the contract fails contract
resolution before dispatch.

An unhandled intrinsic `raise` fails live task execution or records a durable
`"raise"` failure.

## Portable limits

`limits` is a closed object containing any of:

- `maxCallDepth`;
- `maxFuel`;
- `maxValueSize`.

Each value is a non-negative integer. These limits are part of portable
deployment policy. Cancellation, timeout, total allocation, performance, and
usage collection are host-local controls and do not belong in the profile.

Each live run starts with fresh limits. In durable mode, limits restart for
each start, recovery, and delivery invocation. Accumulated fuel usage is
observability data, not a cross-invocation budget.

## Capability analysis

Static capability analysis is conservative and non-fatal. It reports:

- literal task-effect names;
- literal `perform` names;
- statically recoverable `effects.foo.bar` paths;
- whether dynamic effect access exists;
- selected profile bindings;
- possible effects not selected by the profile.

`raise` is excluded from capability reports. Dynamic access conservatively
marks every omitted contract effect as potentially uncovered. Analysis does
not prove control-flow reachability or subtract effects handled in-language.
It may inform admission policy, but does not change subset selection semantics.

## Validation and preparation

Profile validation checks the profile's structure and, when given a contract,
checks selected effect names. Deployment preparation separately combines the
module, contract, profile, and executable bindings. It enforces entry-mode
compatibility and the exact binding rules above.
