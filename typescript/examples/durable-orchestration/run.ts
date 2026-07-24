// Durable orchestration example
// =============================
//
// Run from the repository root:
//   bun run typescript/examples/durable-orchestration/run.ts
//
// The runtime adapter is intentionally ordinary application code. The durable
// driver knows effect IDs and continuations, but it does not know what an
// "agent" or a join means. Tracking handles and aggregating joins belongs here.

import {
  InMemoryWorkflowStore,
  createDurableDriver,
  loadBuiltinTable,
  loadEnvironmentContract,
  loadDeploymentProfile,
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

type AgentResult = { ok: true; output: string } | { ok: false; error: string };

export type OrchestrationRun = {
  result: JSONType;
  durableEvents: string[];
  staleDeliveries: number;
};

// These results stand in for real remote workers. A production runtime adapter
// would receive them from queues or webhooks; keeping them deterministic makes
// the persistence and join behavior easy to inspect and test.
const cannedResults: Record<string, AgentResult> = {
  research: { ok: true, output: "release facts" },
  summarize: { ok: true, output: "summary: release facts" },
  alpha: { ok: true, output: "alpha report" },
  broken: { ok: false, error: "agent failed safely" },
  bravo: { ok: true, output: "bravo report" },
  fast: { ok: true, output: "fast result" },
  slow: { ok: true, output: "slow result" },
};

export async function runOrchestrationExample(): Promise<OrchestrationRun> {
  const source = await Bun.file(modulePath).text();
  const program = parseShorthand(source) as Record<string, JSONType>;
  const builtins = loadBuiltinTable();
  const contract = loadEnvironmentContract(contractPath, builtins);
  const profile = loadDeploymentProfile(profilePath, contract);
  if (profile.mode !== "durable") {
    throw new Error("orchestration requires a durable deployment profile");
  }

  const store = new InMemoryWorkflowStore();
  const handlesBySpawnEffect = new Map<string, string>();
  const durableEvents: string[] = [];
  let staleDeliveries = 0;

  const driver: DurableDriver = createDurableDriver({
    deployment: prepareDeployment({
      module: program,
      contract,
      profile,
      adapter: {
        functions: {},
        effects: {
          // Spawn is inline, so recovery may call it more than once. Memoizing
          // by effectId keeps the returned handle deterministic across replays.
          "agent.spawn": ({ effectId }, spec) => {
            const existing = handlesBySpawnEffect.get(effectId);
            if (existing !== undefined) return existing;
            const handle = (spec as { name: string }).name;
            handlesBySpawnEffect.set(effectId, handle);
            durableEvents.push(`spawn ${handle} (${effectId})`);
            return handle;
          },
          // Log is also inline. A real host must accept at-least-once execution.
          log: ({ effectId }, message) => {
            durableEvents.push(`log ${String(message)} (${effectId})`);
            return null;
          },
        },
      },
    }),
    store,
  });

  async function recordStale(delivery: DeliveryOutcome): Promise<void> {
    if (delivery.status !== "stale") {
      throw new Error("duplicate or straggler delivery unexpectedly advanced the workflow");
    }
    staleDeliveries += 1;
  }

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

      // Partial join state is adapter state, not WorkflowRecord state.
      for (const handle of handles) {
        buffered.push(result(handle));
        durableEvents.push(`buffer ${handle} for ${effectId}`);
      }
      if (handles.length === 0) durableEvents.push(`complete empty join (${effectId})`);

      const next = requireAdvance(
        await driver.deliverCompletion("release-report", effectId, buffered),
      );

      // A queue may redeliver a completed join. The store has already consumed
      // this effectId, so the continuation does not run twice.
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

      // awaitAny does not cancel losers. A late result is safely stale.
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

  let outcome: AdvanceOutcome = await driver.start("release-report", []);
  while (outcome.status === "suspended") {
    outcome = await completeSuspension(outcome);
  }

  if (outcome.status === "failed") {
    throw new Error(`workflow failed: ${outcome.failure.code}: ${outcome.failure.message}`);
  }

  return { result: outcome.result, durableEvents, staleDeliveries };
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

if (import.meta.main) {
  const run = await runOrchestrationExample();
  console.log("Durable runtime-adapter transcript:");
  for (const event of run.durableEvents) console.log(`  ${event}`);
  console.log(`\nStale duplicate/straggler deliveries: ${run.staleDeliveries}`);
  console.log("\nFinal report:");
  console.log(JSON.stringify(run.result, null, 2));
}
