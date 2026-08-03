import { describe, expect, test } from "bun:test";
import {
  InMemoryWorkflowStore,
  createDurableDriver,
  createDurableInstrumentation,
  instrumentWorkflowStore,
  parseShorthand,
  prepareDeployment,
  type DeliveryOutcome,
  type DurableInstrumentation,
  type EnvironmentContract,
  type JSONType,
  type WorkflowRecord,
} from "../src";

const integer = { type: "integer" } as const;

function createDriver(options: {
  source: string;
  contract: EnvironmentContract;
  effects: Record<string, "inline" | "suspending">;
  instrumentation: DurableInstrumentation;
}) {
  const store = instrumentWorkflowStore(new InMemoryWorkflowStore(), options.instrumentation);
  return createDurableDriver({
    deployment: prepareDeployment({
      module: parseShorthand(options.source) as Record<string, JSONType>,
      contract: options.contract,
      profile: {
        version: 1,
        mode: "durable",
        deploymentId: "instrumented",
        effects: options.effects,
      },
      adapter: { functions: {}, effects: {} },
    }),
    store,
  });
}

const waitContract: EnvironmentContract = {
  version: 1,
  effects: { wait: { params: [integer], returns: integer } },
  entry: { name: "main", required: [], optional: [], returns: { task: integer } },
};

describe("durable instrumentation", () => {
  test("instrumented store preserves driver behavior and counts records by status", async () => {
    const instrumentation = createDurableInstrumentation();
    const driver = createDriver({
      source: `
        main: () => do {
          value <- effects.wait(40),
          pure(value + 2)
        }
      `,
      contract: waitContract,
      effects: { wait: "suspending" },
      instrumentation,
    });

    expect(await driver.start("flow", [])).toEqual({
      status: "suspended",
      pending: { effectId: "flow:0", name: "wait", args: [40] },
    });
    expect(await driver.deliverCompletion("flow", "flow:0", 40)).toEqual({
      status: "completed",
      result: 42,
    });
    expect(await driver.deliverCompletion("flow", "flow:0", 41)).toEqual({ status: "stale" });

    const report = instrumentation.report();
    // Revisions: running (start), suspended, running (claim), completed.
    expect(report.records.count).toBe(4);
    expect(report.records.byStatus.running?.count).toBe(2);
    expect(report.records.byStatus.suspended?.count).toBe(1);
    expect(report.records.byStatus.completed?.count).toBe(1);
    expect(report.records.bytes.min).toBeGreaterThan(0);
    expect(report.records.depth.max).toBeGreaterThan(1);

    // Hydration is measured once per observed record.
    expect(report.hydration.count).toBe(4);
    expect(report.hydration.durationMs.total).toBeGreaterThan(0);
    expect(report.hydration.peakRssBytes).toBeGreaterThan(0);

    // Continuations exist on the suspended record and the claimed resume.
    expect(report.duplication.continuation.count).toBe(2);
    expect(report.duplication.continuation.shareOfRecordBytes.max).toBeLessThanOrEqual(1);

    // The report is plain, non-sensitive JSON: no IDs, names, or values.
    const encoded = JSON.stringify(report);
    expect(JSON.parse(encoded)).toEqual(report as unknown as JSONType);
    expect(encoded).not.toContain("flow");
    expect(encoded).not.toContain("wait");
  });

  test("measures reuse and growth between consecutive suspensions", async () => {
    const instrumentation = createDurableInstrumentation();
    const driver = createDriver({
      source: `
        gather: (remaining, acc) =>
          if remaining <= 0 then pure(length(acc))
          else do {
            item <- effects.wait(remaining),
            gather(remaining - 1, concat(acc, [item]))
          }
        main: () => gather(4, [])
      `,
      contract: {
        version: 1,
        effects: { wait: { params: [integer], returns: { type: "object" } } },
        entry: { name: "main", required: [], optional: [], returns: { task: integer } },
      },
      effects: { wait: "suspending" },
      instrumentation,
    });

    let outcome: DeliveryOutcome = await driver.start("grow", []);
    let sequence = 0;
    while (outcome.status === "suspended") {
      const bulky = {
        payload: `item-${sequence}`,
        details: { attempt: sequence, tags: ["alpha", "beta", "gamma", "delta"] },
      };
      outcome = await driver.deliverCompletion("grow", `grow:${sequence}`, bulky);
      sequence += 1;
    }
    expect(outcome).toEqual({ status: "completed", result: 4 });

    const report = instrumentation.report();
    expect(report.betweenSuspensions.count).toBe(3);
    // Accumulated items persist verbatim, so later suspensions reuse bytes
    // from earlier ones and records grow.
    expect(report.betweenSuspensions.reusedBytesRatio.mean).toBeGreaterThan(0);
    expect(report.betweenSuspensions.grownBytes.mean).toBeGreaterThan(0);
  });

  test("detects repeated subtrees and closure-substitution expansion", () => {
    const instrumentation = createDurableInstrumentation();
    const repeated = {
      threshold: { low: 10, high: 90, unit: "celsius", calibration: [1, 2, 3, 4, 5] },
    };
    const record: WorkflowRecord = {
      workflowId: "dup",
      revision: 1,
      deploymentId: "instrumented",
      effectSequence: 1,
      fuelUsed: 10,
      status: "suspended",
      pending: {
        effectId: "dup:0",
        name: "wait",
        args: [repeated, repeated, repeated],
        resume: { $params: ["x"], $return: [repeated, { $var: "x" }] } as unknown as JSONType,
      },
    };

    instrumentation.observeRecord(record);
    const report = instrumentation.report();
    expect(report.duplication.duplicateSubtreeInstances).toBeGreaterThanOrEqual(3);
    expect(report.duplication.duplicationRatio.mean).toBeGreaterThan(1);
    expect(report.duplication.dedupedBytes.mean).toBeLessThan(report.records.bytes.mean);
    expect(report.duplication.continuation.count).toBe(1);
  });

  test("blob estimates dedup repeats and shrink with larger thresholds", () => {
    const instrumentation = createDurableInstrumentation({
      blobThresholdsBytes: [128, 4096],
    });
    const bigShared = {
      manifest: Array.from({ length: 20 }, (_, index) => ({
        line: index,
        text: "a stable shared subtree that exceeds the smaller threshold",
      })),
    };
    const recordAt = (revision: number, sequence: number): WorkflowRecord => ({
      workflowId: "blobs",
      revision,
      deploymentId: "instrumented",
      effectSequence: sequence,
      fuelUsed: revision * 5,
      status: "suspended",
      pending: {
        effectId: `blobs:${sequence}`,
        name: "wait",
        args: [bigShared, sequence],
        resume: { $params: ["x"], $return: { $var: "x" } } as unknown as JSONType,
      },
    });

    instrumentation.observeRecord(recordAt(1, 0));
    instrumentation.observeRecord(recordAt(3, 1));
    const report = instrumentation.report();

    const [small, large] = report.blobbing;
    expect(small!.thresholdBytes).toBe(128);
    expect(large!.thresholdBytes).toBe(4096);
    // Smaller thresholds produce at least as many blobs.
    expect(small!.storedBlobCount).toBeGreaterThanOrEqual(large!.storedBlobCount);
    expect(small!.storedBlobCount).toBeGreaterThan(0);
    // The shared subtree is written once but referenced by both records, so
    // blobbed writes undercut rewriting the full record each revision.
    expect(small!.writeAmplification).toBeLessThan(1);
    expect(small!.readOpsPerHydration.mean).toBeGreaterThan(1);
    expect(small!.logicalWriteBytes).toBe(report.records.bytes.total);
  });
});
