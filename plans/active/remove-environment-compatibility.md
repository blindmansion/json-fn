# Remove typed-environment compatibility paths

## Goal

Simplify the typed-environment implementation after slice 8 by deleting legacy
APIs and fragmented configuration. There is no backwards-compatibility
requirement: older examples and callers should be migrated or removed rather
than supported through overloads.

## Cleanup

- Make `runTask(module, environment, args, host, limits?)` the only task-running
  API; remove the positional `entry`, registry, definitions, effects, and
  capabilities form.
- Make the packaged environment the only way checker entrypoints receive
  operator definitions, callable contracts, and effects. Remove the separate
  `environmentDefs` and `effects` options.
- Treat `environment.entry` as the authoritative entry signature. Check the
  entry body contextually against it instead of requiring and reconciling a
  duplicate guest `$sig`.
- Refactor function-body checking to accept an injected signature so entry
  parameters, recursive calls, and `Task<A>` completion flow through the normal
  checker path rather than an entry-specific compatibility pass.
- Make CLI module checking and execution environment-driven; remove legacy
  environment-free entry execution where it duplicates the host API.
- Rename builtin-specific callable table and rule plumbing where it now serves
  both core and host callables.
- Update tests and current examples to the single API, then delete tests whose
  only purpose is preserving removed call forms.

## Keep

- Collision-rejecting core/host callable composition.
- Separate portable contracts and host implementations.
- Runtime validation of entry, direct-function, and effect boundaries.
- The shared builtin < environment < module definition-pool policy unless that
  policy is reconsidered separately.

## Completion criteria

- No public overload or option exists solely for pre-environment callers.
- Entry contracts are declared once, in the environment.
- Checker and runtime setup each consume one environment plus host
  implementations.
- TypeScript checks and the migrated test suite pass without compatibility
  shims.
