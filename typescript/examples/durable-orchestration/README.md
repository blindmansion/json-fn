# Durable orchestration example

This directory is a runnable example of a typed json-fn workflow driven by a
durable host:

- `orchestration.jfn` contains only the guest workflow and its domain logic.
- `orchestration.contract.json` defines the shared named types and effect
  contracts.
- `orchestration.profile.json` selects durable hosting, classifies inline and
  suspending effects, and pins the deployment ID.
- `run.ts` runs the workflow with `prepareDeployment` plus
  `createDurableDriver`.

The automated test suite keeps a deterministic in-language handler under
`typescript/test/examples/` and compares its report with this durable run. That
oracle is test support rather than part of the public guest module.

See [`docs/deployment/environment-contract.md`](../../../docs/deployment/environment-contract.md),
[`docs/deployment/deployment-profile.md`](../../../docs/deployment/deployment-profile.md), and
[`docs/runtime/durable-host.md`](../../../docs/runtime/durable-host.md) for the artifact and
driver contracts used here.

Run it from the repository root:

```sh
bun run typescript/examples/durable-orchestration/run.ts
```

The workflow demonstrates a sequential agent pipeline, recursive
spawn-before-join fan-out, an in-band subagent failure, an empty `awaitAll`,
and an `awaitAny` race. The TypeScript runtime adapter also deliberately redelivers a
completed join and reports the losing race result late. Both deliveries are
stale, so neither continuation runs twice.

The example uses an in-memory store and canned agent results to stay
self-contained. In a production host, durable records would live in a
transactional store and the runtime adapter's buffered join results would normally
arrive from queues or webhooks.
