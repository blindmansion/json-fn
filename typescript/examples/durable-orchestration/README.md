# Durable orchestration example

This directory is a runnable example of one typed json-fn workflow interpreted
by two different hosts:

- `orchestration.jfn` contains the guest workflow and a deterministic
  in-language state-transformer handler.
- `orchestration.contract.json` defines the shared named types and effect
  contracts.
- `orchestration.profile.json` selects durable hosting, classifies inline and
  suspending effects, and pins the deployment ID.
- `run.ts` runs the in-language handler, then runs the same workflow with
  `prepareDeployment` plus `createDurableDriver` and verifies that both reports
  match.

See [`docs/environment-contract.md`](../../../docs/environment-contract.md),
[`docs/deployment-profile.md`](../../../docs/deployment-profile.md), and
[`docs/durable-host.md`](../../../docs/durable-host.md) for the artifact and
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
