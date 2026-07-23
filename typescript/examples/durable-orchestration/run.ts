// Durable orchestration example
// =============================
//
// Run from the repository root:
//   bun run typescript/examples/durable-orchestration/run.ts
//
// The same `workflow()` task is interpreted twice:
//   1. entirely in json-fn by the state-transformer handler in orchestration.jfn;
//   2. by createDurableDriver plus this small in-memory runtime adapter.
//
// The runtime adapter is intentionally ordinary application code. The durable driver
// knows effect IDs and continuations, but it does not know what an "agent" or a
// join means. Tracking handles and aggregating joins belongs here.

import {
  InMemoryWorkflowStore,
  callProgram,
  createDurableDriver,
  createStdlib,
  loadBuiltinTable,
  loadEnvironmentContract,
  loadDeploymentProfile,
  linkModule,
  parseShorthand,
  prepareDeployment,
  type AdvanceOutcome,
  type DeliveryOutcome,
  type DurableDriver,
  type JSONType,
} from "../../src";
const modulePath = `${import.meta.dir}/orchestration.jfn`;
const contractPath = `${import.meta.dir}/orchestration.contract.json`;
const profilePath = `${import.meta.dir}/orchestration.profile.json`;
const source = await Bun.file(modulePath).text();
const program = parseShorthand(source) as Record<string, JSONType>;
const builtins = loadBuiltinTable();
const contract = loadEnvironmentContract(contractPath, builtins);
const profile = loadDeploymentProfile(profilePath, contract);
if (profile.mode !== "durable") {
  throw new Error("orchestration requires a durable deployment profile");
}
const linked = linkModule({ module: program, builtins, contract });
const registry = createStdlib();

// Development invocation of `demo` needs the same generated effect namespace
// that a task host injects. `demo` then handles every effect in-language, so no
// TypeScript capability runs for this first interpretation.
const mockRun = callProgram(
  linked.module,
  "demo",
  [],
  registry,
  undefined,
  linked.definitionSources,
) as { report: JSONType; transcript: JSONType[] };

type AgentResult = { ok: true; output: string } | { ok: false; error: string };

// These results stand in for real remote workers. A production runtime adapter would
// receive them from queues or webhooks; keeping them deterministic makes the
// persistence and join behavior easy to see.
const cannedResults: Record<string, AgentResult> = {
  research: { ok: true, output: "release facts" },
  summarize: { ok: true, output: "summary: release facts" },
  alpha: { ok: true, output: "alpha report" },
  broken: { ok: false, error: "agent failed safely" },
  bravo: { ok: true, output: "bravo report" },
  fast: { ok: true, output: "fast result" },
  slow: { ok: true, output: "slow result" },
};

const store = new InMemoryWorkflowStore();
const handlesBySpawnEffect = new Map<string, string>();
const durableEvents: string[] = [];
let driver: DurableDriver;
let staleDeliveries = 0;

driver = createDurableDriver({
  deployment: prepareDeployment({
    module: program,
    contract,
    profile,
    adapter: {
      functions: {},
      effects: {
        // Spawn is inline, so recovery may call it more than once. Memoizing by
        // effectId makes the returned handle deterministic across replays.
        "agent.spawn": ({ effectId }, spec) => {
          const existing = handlesBySpawnEffect.get(effectId);
          if (existing !== undefined) return existing;
          const handle = (spec as { name: string }).name;
          handlesBySpawnEffect.set(effectId, handle);
          durableEvents.push(`spawn ${handle} (${effectId})`);
          return handle;
        },
        // Log is also inline. A real host must accept at-least-once execution;
        // this example de-duplicates by effectId to keep its display concise.
        log: ({ effectId }, message) => {
          durableEvents.push(`log ${String(message)} (${effectId})`);
          return null;
        },
      },
    },
  }),
  store,
});

let outcome: AdvanceOutcome = await driver.start("release-report", []);
while (outcome.status === "suspended") {
  outcome = await completeSuspension(outcome);
}

if (outcome.status === "failed") {
  throw new Error(`workflow failed: ${outcome.failure.code}: ${outcome.failure.message}`);
}
assertEqual(outcome.result, mockRun.report, "durable and in-language reports");

console.log("In-language transcript:");
for (const event of mockRun.transcript) console.log(`  ${String(event)}`);
console.log("\nDurable runtime-adapter transcript:");
for (const event of durableEvents) console.log(`  ${event}`);
console.log(`\nStale duplicate/straggler deliveries: ${staleDeliveries}`);
console.log("\nFinal report:");
console.log(JSON.stringify(outcome.result, null, 2));

async function completeSuspension(
  suspended: Extract<AdvanceOutcome, { status: "suspended" }>,
): Promise<AdvanceOutcome> {
  const { effectId, name, args } = suspended.pending;

  if (name === "agent.await") {
    const handle = args[0] as string;
    durableEvents.push(`complete ${handle} (${effectId})`);
    return requireAdvance(
      await driver.deliverCompletion("release-report", effectId, result(handle)),
    );
  }

  if (name === "agent.awaitAll") {
    const handles = args[0] as string[];
    const buffered: AgentResult[] = [];

    // Partial join state is adapter state, not WorkflowRecord state. We buffer
    // each worker result and deliver exactly once when the join is complete.
    for (const handle of handles) {
      buffered.push(result(handle));
      durableEvents.push(`buffer ${handle} for ${effectId}`);
    }
    if (handles.length === 0) durableEvents.push(`complete empty join (${effectId})`);

    const next = requireAdvance(
      await driver.deliverCompletion("release-report", effectId, buffered),
    );

    // A queue may redeliver the same completed join. The store claim has
    // already consumed this effectId, so the driver returns stale and never
    // invokes its continuation twice.
    await recordStale(await driver.deliverCompletion("release-report", effectId, buffered));
    return next;
  }

  if (name === "agent.awaitAny") {
    const handles = args[0] as string[];
    const winner = handles[0]!;
    const loser = handles[1]!;
    durableEvents.push(`winner ${winner} (${effectId})`);
    const next = requireAdvance(
      await driver.deliverCompletion("release-report", effectId, {
        handle: winner,
        result: result(winner),
      }),
    );

    // awaitAny does not cancel losers. When the slower worker reports back, it
    // targets the already-consumed effect and is safely classified as stale.
    durableEvents.push(`late straggler ${loser} (${effectId})`);
    await recordStale(
      await driver.deliverCompletion("release-report", effectId, {
        handle: loser,
        result: result(loser),
      }),
    );
    return next;
  }

  throw new Error(`example adapter does not implement suspending effect "${name}"`);
}

function result(handle: string): AgentResult {
  const value = cannedResults[handle];
  if (value === undefined) return { ok: false, error: `unknown handle: ${handle}` };
  return value;
}

function requireAdvance(delivery: DeliveryOutcome): AdvanceOutcome {
  if (delivery.status === "stale") {
    throw new Error("expected the first delivery to claim the suspension");
  }
  return delivery;
}

async function recordStale(delivery: Promise<DeliveryOutcome> | DeliveryOutcome): Promise<void> {
  if ((await delivery).status !== "stale") {
    throw new Error("duplicate or straggler delivery unexpectedly advanced the workflow");
  }
  staleDeliveries += 1;
}

function assertEqual(actual: JSONType, expected: JSONType, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differ`);
  }
}
