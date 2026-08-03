import { describe, expect, test } from "bun:test";
import {
  AdapterLinkError,
  InMemoryWorkflowStore,
  WorkflowAlreadyExistsError,
  WorkflowRevisionConflictError,
  prepareDeployment,
  type EnvironmentContract,
  type JSONType,
  type PendingEffect,
  type WorkflowRecord,
} from "../src";
import { isRuntimeValue } from "../src/runtime-values";

const integer = { type: "integer" } as const;
const contract: EnvironmentContract = {
  version: 1,
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
const durableProfile = {
  version: 1,
  mode: "durable",
  deploymentId: "deployment-a",
  effects: { inline: "inline", wait: "suspending" },
} as const;
const durableModule = {
  main: { $params: [], $return: { $call: "pure", $args: [1] } },
} as Record<string, JSONType>;

describe("durable deployment preparation", () => {
  test("accepts only inline effect implementations", () => {
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: contract,
        profile: durableProfile,
        adapter: { functions: {}, effects: { inline: (_context, value) => value ?? null } },
      }),
    ).not.toThrow();
  });

  test("requires a task entry", () => {
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: { ...contract, entry: { ...contract.entry, returns: integer } },
        profile: durableProfile,
        adapter: { functions: {}, effects: { inline: () => null } },
      }),
    ).toThrow(/requires a task entry/);
  });

  test("reports stable codes and paths for adapter parity", () => {
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: contract,
        profile: durableProfile,
        adapter: { functions: {}, effects: {} },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "AdapterLinkError",
        code: "MISSING_ADAPTER_EFFECT",
        path: "adapter.effects.inline",
      }),
    );
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: contract,
        profile: durableProfile,
        adapter: { functions: {}, effects: { inline: () => null, wait: () => null } },
      }),
    ).toThrow(AdapterLinkError);
  });

  test("requires exactly the contract functions and inline profile effects", () => {
    const contractWithFunction: EnvironmentContract = {
      ...contract,
      functions: {
        lookup: {
          signatures: [{ required: [], optional: [], returns: integer }],
        },
      },
    };
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: contractWithFunction,
        profile: durableProfile,
        adapter: { functions: {}, effects: { inline: () => null } },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_ADAPTER_FUNCTION",
        path: "adapter.functions.lookup",
      }),
    );
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: contractWithFunction,
        profile: durableProfile,
        adapter: {
          functions: { lookup: () => 1 },
          effects: { inline: () => null, wait: () => null },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "EXTRA_ADAPTER_EFFECT",
        path: "adapter.effects.wait",
      }),
    );
  });

  test("keeps raise intrinsic rather than profile-selectable", () => {
    expect(() =>
      prepareDeployment({
        module: durableModule,
        contract: {
          ...contract,
          effects: {
            ...contract.effects,
            raise: { params: [true], returns: true },
          },
        },
        profile: {
          ...durableProfile,
          effects: { ...durableProfile.effects, raise: "inline" },
        },
        adapter: { functions: {}, effects: { inline: () => null, raise: () => null } },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_DEPLOYMENT_PROFILE",
        path: "profile.effects.raise",
      }),
    );
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
    expect(isRuntimeValue(first.pending.resume)).toBe(true);
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
    expect(isRuntimeValue(outcome.claimed.basis.pending.resume)).toBe(true);
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
