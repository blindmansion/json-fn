// Phase 0 durable-host measurement report.
//
// Runs representative durable workloads against an instrumented in-memory
// store and prints the non-sensitive measurements the implementation roadmap
// gates on: record sizes by state, repeated-subtree / closure-substitution
// expansion, changes between suspensions, hydration time and memory, and
// estimated blob read/write amplification under candidate thresholds.
//
// Usage (from typescript/):
//   bun run instrument:durable          # headline summary per workload
//   bun run instrument:durable --json   # full JSON reports

import {
  InMemoryWorkflowStore,
  createDurableDriver,
  createDurableInstrumentation,
  instrumentWorkflowStore,
  parseShorthand,
  prepareDeployment,
  type DeliveryOutcome,
  type DurableInstrumentationReport,
  type EnvironmentContract,
  type JSONType,
} from "../src";

type Workload = {
  name: string;
  description: string;
  source: string;
  contract: EnvironmentContract;
  effects: Record<string, "inline" | "suspending">;
  args: JSONType[];
  /** Synthesize the external completion for one suspension. */
  respond: (effectName: string, args: JSONType[], sequence: number) => JSONType;
};

const integer = { type: "integer" } as const;

const workloads: Workload[] = [
  {
    name: "accumulating-state",
    description:
      "Order-fulfillment style: 24 suspending hops, each appending a fetched " +
      "record to a list carried in the continuation. State grows every hop.",
    source: `
      gather: (remaining, acc) =>
        if remaining <= 0 then pure(acc)
        else do {
          parcel <- effects.fetch_parcel(remaining),
          gather(remaining - 1, concat(acc, [parcel]))
        }
      main: (count) => gather(count, [])
    `,
    contract: {
      version: 1,
      effects: {
        fetch_parcel: { params: [integer], returns: { type: "object" } },
      },
      entry: {
        name: "main",
        required: [integer],
        optional: [],
        returns: { task: { type: "array" } },
      },
    },
    effects: { fetch_parcel: "suspending" },
    args: [24],
    respond: (_effectName, _args, sequence) => ({
      id: sequence,
      sku: `SKU-${String(sequence).padStart(6, "0")}`,
      quantity: (sequence % 7) + 1,
      destination: { region: "us-east", bay: sequence % 12, priority: sequence % 3 === 0 },
      scans: [`in:${sequence}`, `sort:${sequence}`, `out:${sequence}`],
      notes: "routine parcel; no manual inspection required at this checkpoint",
    }),
  },
  {
    name: "shared-config",
    description:
      "Closure-substitution pressure: a sizable config object passed as an " +
      "argument is captured by the continuation across 16 suspending hops.",
    source: `
      classify: (config, reading) =>
        if reading > config.limits.high then "high"
        else if reading < config.limits.low then "low"
        else "ok"
      loop: (config, remaining, statuses) =>
        if remaining <= 0 then pure(statuses)
        else do {
          reading <- effects.sample(remaining),
          loop(config, remaining - 1, concat(statuses, [classify(config, reading)]))
        }
      main: (config) => loop(config, 16, [])
    `,
    contract: {
      version: 1,
      effects: {
        sample: { params: [integer], returns: integer },
      },
      entry: {
        name: "main",
        required: [{ type: "object" }],
        optional: [],
        returns: { task: { type: "array" } },
      },
    },
    effects: { sample: "suspending" },
    args: [
      {
        name: "line-7 sorter",
        limits: { low: 12, high: 96 },
        stations: Array.from({ length: 12 }, (_, index) => ({
          id: `station-${index}`,
          lane: index % 4,
          calibration: { offset: index * 0.25, gain: 1.02, updated: "2026-07-30T00:00:00Z" },
          alerts: ["overweight", "jam", "misread"],
        })),
        escalation: {
          contacts: ["ops@example.test", "floor@example.test"],
          policy: "page on two consecutive high readings within five minutes",
        },
      },
    ],
    respond: (_effectName, _args, sequence) => (sequence * 37) % 120,
  },
  {
    name: "steady-loop",
    description:
      "Thermostat style: 30 suspending hops with a small fixed-shape state; " +
      "records should stay flat and mostly reusable between suspensions.",
    source: `
      loop: (state, remaining) =>
        if remaining <= 0 then pure(state)
        else do {
          temp <- effects.read_temp(remaining),
          loop({ target: state.target, last: temp }, remaining - 1)
        }
      main: (state) => loop(state, 30)
    `,
    contract: {
      version: 1,
      effects: {
        read_temp: { params: [integer], returns: integer },
      },
      entry: {
        name: "main",
        required: [{ type: "object" }],
        optional: [],
        returns: { task: { type: "object" } },
      },
    },
    effects: { read_temp: "suspending" },
    args: [{ target: 21, last: 20 }],
    respond: (_effectName, _args, sequence) => 18 + (sequence % 6),
  },
];

async function runWorkload(workload: Workload): Promise<DurableInstrumentationReport> {
  const instrumentation = createDurableInstrumentation();
  const store = instrumentWorkflowStore(new InMemoryWorkflowStore(), instrumentation);
  const deployment = prepareDeployment({
    module: parseShorthand(workload.source) as Record<string, JSONType>,
    contract: workload.contract,
    profile: {
      version: 1,
      mode: "durable",
      deploymentId: `instrument-${workload.name}`,
      effects: workload.effects,
    },
    adapter: { functions: {}, effects: {} },
  });
  const driver = createDurableDriver({ deployment, store });

  const workflowId = `${workload.name}-1`;
  let outcome: DeliveryOutcome = await driver.start(workflowId, workload.args);
  let sequence = 0;
  while (outcome.status === "suspended") {
    const { effectId, name, args } = outcome.pending;
    outcome = await driver.deliverCompletion(
      workflowId,
      effectId,
      workload.respond(name, args, sequence),
    );
    sequence += 1;
  }
  if (outcome.status !== "completed") {
    throw new Error(`workload "${workload.name}" did not complete: ${JSON.stringify(outcome)}`);
  }
  return instrumentation.report();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function printHeadline(workload: Workload, report: DurableInstrumentationReport): void {
  console.log(`\n## ${workload.name}`);
  console.log(workload.description);
  console.log(`records observed: ${report.records.count}`);
  for (const [status, entry] of Object.entries(report.records.byStatus)) {
    console.log(
      `  ${status}: ${entry.count} records, mean ${formatBytes(entry.bytes.mean)}, ` +
        `max ${formatBytes(entry.bytes.max)}`,
    );
  }
  const duplication = report.duplication;
  console.log(
    `duplication: ratio mean ${duplication.duplicationRatio.mean.toFixed(3)} ` +
      `(max ${duplication.duplicationRatio.max.toFixed(3)}), ` +
      `${duplication.duplicateSubtreeInstances} repeated subtrees / ` +
      `${formatBytes(duplication.duplicateSubtreeBytes)}`,
  );
  const continuation = duplication.continuation;
  if (continuation.count > 0) {
    console.log(
      `continuation: mean ${formatBytes(continuation.bytes.mean)} ` +
        `(${(continuation.shareOfRecordBytes.mean * 100).toFixed(1)}% of record), ` +
        `duplication ratio mean ${continuation.duplicationRatio.mean.toFixed(3)}`,
    );
  }
  const between = report.betweenSuspensions;
  if (between.count > 0) {
    console.log(
      `between suspensions: ${between.count} pairs, growth mean ` +
        `${formatBytes(between.grownBytes.mean)}, reused bytes mean ` +
        `${(between.reusedBytesRatio.mean * 100).toFixed(1)}%`,
    );
  }
  console.log(
    `hydration: mean ${report.hydration.durationMs.mean.toFixed(3)} ms, ` +
      `max ${report.hydration.durationMs.max.toFixed(3)} ms, ` +
      `peak RSS ${formatBytes(report.hydration.peakRssBytes)}`,
  );
  console.log("blobbing estimates (threshold: write amp, read amp, stored blobs):");
  for (const estimate of report.blobbing) {
    console.log(
      `  ${String(estimate.thresholdBytes).padStart(5)} B: ` +
        `write x${estimate.writeAmplification.toFixed(3)}, ` +
        `read x${estimate.readAmplification.toFixed(3)} ` +
        `(${estimate.readOpsPerHydration.mean.toFixed(1)} reads/hydration), ` +
        `${estimate.storedBlobCount} blobs / ${formatBytes(estimate.storedBlobBytes)}`,
    );
  }
}

const asJson = process.argv.includes("--json");
const reports: Record<string, DurableInstrumentationReport> = {};
for (const workload of workloads) {
  reports[workload.name] = await runWorkload(workload);
}

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  console.log("# Durable-host Phase 0 measurements");
  for (const workload of workloads) {
    printHeadline(workload, reports[workload.name]!);
  }
  console.log("\nRun with --json for the full reports.");
}
