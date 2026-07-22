import { describe, expect, test } from "bun:test";
import {
  EnvironmentConfigurationError,
  InMemoryWorkflowStore,
  WorkflowAlreadyExistsError,
  WorkflowRevisionConflictError,
  createStdlib,
  validateDurableHostConfiguration,
  type DurableHostConfiguration,
  type Environment,
  type JSONType,
  type PendingEffect,
  type WorkflowRecord,
} from "../src";
import { isRaw } from "../src/utils";

const integer = { type: "integer" } as const;
const environment: Environment = {
  effects: {
    inline: { params: [integer], returns: integer },
    wait: { params: [integer], returns: integer },
  },
  entry: {
    name: "main",
    required: [],
    optional: [],
    returns: { task: integer },
  },
};
const validHost: DurableHostConfiguration = {
  registry: createStdlib(),
  effects: { inline: "inline", wait: "suspending" },
  capabilities: { inline: (_context, value) => value ?? null },
  deploymentId: "deployment-a",
};

describe("durable host configuration", () => {
  test("accepts exact effect classifications and inline capabilities", () => {
    expect(() => validateDurableHostConfiguration(environment, validHost)).not.toThrow();
  });

  test("requires a task entry", () => {
    const directEnvironment: Environment = {
      ...environment,
      entry: { ...environment.entry, returns: integer },
    };
    expect(() => validateDurableHostConfiguration(directEnvironment, validHost)).toThrow(
      /requires a task entry/,
    );
  });

  test("rejects missing, extra, and unknown classifications", () => {
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        effects: { inline: "inline" },
      }),
    ).toThrow(/"wait" has no durable classification/);
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        effects: { ...validHost.effects, extra: "suspending" },
      }),
    ).toThrow(/classification "extra" has no effect contract/);
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        effects: {
          inline: "other",
          wait: "suspending",
        } as unknown as DurableHostConfiguration["effects"],
      }),
    ).toThrow(/unknown durable classification "other"/);
  });

  test("requires capabilities for exactly the inline effects", () => {
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        capabilities: {},
      }),
    ).toThrow(/inline effect "inline" has no capability/);
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        capabilities: {
          ...validHost.capabilities,
          wait: () => null,
        },
      }),
    ).toThrow(/"wait" has no inline effect classification/);
  });

  test("forbids classifying or implementing intrinsic raise", () => {
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        effects: { ...validHost.effects, raise: "inline" },
      }),
    ).toThrow(/"raise" is intrinsic and cannot be classified/);
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        capabilities: { ...validHost.capabilities, raise: () => null },
      }),
    ).toThrow(/"raise" is intrinsic and cannot have a capability/);
  });

  test("reports configuration errors with the shared error type", () => {
    expect(() =>
      validateDurableHostConfiguration(environment, {
        ...validHost,
        deploymentId: "",
      }),
    ).toThrow(EnvironmentConfigurationError);
  });
});

const resume: JSONType = {
  $params: ["value"],
  $return: { "@task": "pure", value: { $var: "value" } },
};

function pending(effectId: string): PendingEffect {
  return { effectId, name: "wait", args: [1], resume };
}

function suspendedRecord(
  workflowId: string,
  revision = 0,
): Extract<WorkflowRecord, { status: "suspended" }> {
  return {
    workflowId,
    revision,
    deploymentId: "deployment-a",
    effectSequence: 1,
    fuelUsed: 12,
    status: "suspended",
    pending: pending(`${workflowId}:0`),
  };
}

describe("InMemoryWorkflowStore", () => {
  test("round trips records through the codec on writes and reads", async () => {
    const store = new InMemoryWorkflowStore();
    const record = suspendedRecord("round-trip");
    await store.create(record);

    const first = await store.read(record.workflowId);
    const second = await store.read(record.workflowId);
    expect(first).toEqual(record);
    expect(first).not.toBe(record);
    expect(second).not.toBe(first);
    if (first?.status !== "suspended") throw new Error("Expected suspended record");
    expect(isRaw(first.pending.resume)).toBe(true);
  });

  test("rejects duplicate creates and distinguishes revision conflicts", async () => {
    const store = new InMemoryWorkflowStore();
    const record = suspendedRecord("cas");
    await store.create(record);

    await expect(store.create(record)).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
    const completed: WorkflowRecord = {
      workflowId: record.workflowId,
      revision: 1,
      deploymentId: record.deploymentId,
      effectSequence: record.effectSequence,
      fuelUsed: record.fuelUsed,
      status: "completed",
      result: 42,
    };
    await expect(store.transition(1, completed)).rejects.toMatchObject({
      name: "WorkflowRevisionConflictError",
      expectedRevision: 1,
      actualRevision: 0,
    });
    await expect(store.transition(0, completed)).resolves.toBeUndefined();
    expect(await store.read(record.workflowId)).toEqual(completed);
    await expect(
      store.transition(0, { ...completed, workflowId: "missing" }),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
  });

  test("claims only the exact current suspension and increments revision", async () => {
    const store = new InMemoryWorkflowStore();
    const record = suspendedRecord("claim", 4);
    await store.create(record);

    expect(await store.claim(record.workflowId, "wrong", 20)).toEqual({ stale: true });
    expect(await store.read(record.workflowId)).toEqual(record);

    const outcome = await store.claim(record.workflowId, record.pending.effectId, 20);
    if ("stale" in outcome) throw new Error("Expected claim to succeed");
    expect(outcome.claimed).toMatchObject({
      workflowId: record.workflowId,
      revision: 5,
      effectSequence: record.effectSequence,
      fuelUsed: record.fuelUsed,
      status: "running",
      basis: { kind: "resume", result: 20 },
    });
    if (outcome.claimed.status !== "running" || outcome.claimed.basis.kind !== "resume") {
      throw new Error("Expected resume basis");
    }
    expect(isRaw(outcome.claimed.basis.pending.resume)).toBe(true);
    expect(await store.claim(record.workflowId, record.pending.effectId, 21)).toEqual({
      stale: true,
    });
  });

  test("returns stale for missing, running, terminal, and duplicate claims", async () => {
    const store = new InMemoryWorkflowStore();
    const running: WorkflowRecord = {
      workflowId: "running",
      revision: 0,
      deploymentId: "deployment-a",
      effectSequence: 0,
      fuelUsed: 0,
      status: "running",
      basis: { kind: "start", args: [] },
    };
    const completed: WorkflowRecord = {
      workflowId: "completed",
      revision: 0,
      deploymentId: "deployment-a",
      effectSequence: 0,
      fuelUsed: 0,
      status: "completed",
      result: 1,
    };
    await store.create(running);
    await store.create(completed);

    expect(await store.claim("missing", "missing:0", null)).toEqual({ stale: true });
    expect(await store.claim("running", "running:0", null)).toEqual({ stale: true });
    expect(await store.claim("completed", "completed:0", null)).toEqual({ stale: true });
  });

  test("lists only running and suspended workflows", async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(suspendedRecord("suspended"));
    await store.create({
      workflowId: "running",
      revision: 0,
      deploymentId: "deployment-a",
      effectSequence: 0,
      fuelUsed: 0,
      status: "running",
      basis: { kind: "start", args: [] },
    });
    await store.create({
      workflowId: "failed",
      revision: 0,
      deploymentId: "deployment-a",
      effectSequence: 0,
      fuelUsed: 0,
      status: "failed",
      failure: { code: "external", message: "stopped" },
    });

    expect(await store.listNonterminal()).toEqual(["suspended", "running"]);
  });
});
