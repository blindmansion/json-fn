import { describe, expect, test } from "bun:test";
import {
  DeploymentMismatchError,
  InMemoryWorkflowStore,
  createDurableDriver as createPreparedDriver,
  parseShorthand,
  prepareDeployment,
  type DeliveryOutcome,
  type DurableCapability,
  type EnvironmentContract,
  type JSONType,
  type WorkflowStore,
} from "../src";

const integer = { type: "integer" } as const;

function module(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

function contract(
  effects: EnvironmentContract["effects"] = {},
  returns: EnvironmentContract["entry"]["returns"] = { task: integer },
): EnvironmentContract {
  return {
    version: 1,
    effects,
    entry: { name: "main", required: [], optional: [], returns },
  };
}

type DurableTestHost = {
  effects: Record<string, "inline" | "suspending">;
  capabilities: Record<string, DurableCapability>;
  deploymentId: string;
  limits?: { maxCallDepth?: number; maxFuel?: number; maxValueSize?: number };
};

function host(
  effects: DurableTestHost["effects"],
  capabilities: DurableTestHost["capabilities"] = {},
  overrides: Partial<DurableTestHost> = {},
): DurableTestHost {
  return {
    effects,
    capabilities,
    deploymentId: "deployment-a",
    ...overrides,
  };
}

function createDurableDriver(options: {
  module: Record<string, JSONType>;
  contract: EnvironmentContract;
  host: DurableTestHost;
  store: WorkflowStore;
}) {
  const { module, contract, host, store } = options;
  return createPreparedDriver({
    deployment: prepareDeployment({
      module,
      contract: contract,
      profile: {
        version: 1,
        mode: "durable",
        deploymentId: host.deploymentId,
        effects: host.effects,
        ...(host.limits === undefined ? {} : { limits: host.limits }),
      },
      adapter: { functions: {}, effects: host.capabilities },
    }),
    store,
  });
}

describe("durable driver", () => {
  test("does not reserve a workflow ID when start arguments are invalid", async () => {
    const store = new InMemoryWorkflowStore();
    const env = contract();
    env.entry.required = [integer];
    const driver = createDurableDriver({
      module: module("main: (value) => pure(value)"),
      contract: env,
      host: host({}),
      store,
    });

    await expect(driver.start("invalid-args", ["bad"])).rejects.toThrow();
    expect(await driver.read("invalid-args")).toBeUndefined();
    expect(await driver.start("invalid-args", [1])).toEqual({ status: "completed", result: 1 });
  });

  test("wraps contract functions with the same runtime contracts as live mode", async () => {
    const functionContract: EnvironmentContract = {
      ...contract(),
      functions: {
        inc: {
          signatures: [{ required: [integer], optional: [], returns: integer }],
        },
      },
    };
    const source = module("main: () => pure(inc(1))");
    const makeDriver = (implementation: (value: JSONType) => JSONType) =>
      createPreparedDriver({
        deployment: prepareDeployment({
          module: source,
          contract: functionContract,
          profile: {
            version: 1,
            mode: "durable",
            deploymentId: "function-test",
            effects: {},
          },
          adapter: { functions: { inc: implementation }, effects: {} },
        }),
        store: new InMemoryWorkflowStore(),
      });

    expect(await makeDriver((value) => (value as number) + 1).start("valid-function", [])).toEqual({
      status: "completed",
      result: 2,
    });
    expect(await makeDriver(() => "bad").start("invalid-function", [])).toMatchObject({
      status: "failed",
      failure: { code: "contract" },
    });
    expect(
      await makeDriver(() => {
        throw new Error("adapter failed");
      }).start("throwing-function", []),
    ).toMatchObject({
      status: "failed",
      failure: { code: "host" },
    });
  });

  test("completes an inline-only workflow in start", async () => {
    const store = new InMemoryWorkflowStore();
    const driver = createDurableDriver({
      module: module(`
        main: () => do {
          value <- effects.double(20),
          pure(value + 2)
        }
      `),
      contract: contract({
        double: { params: [integer], returns: integer },
      }),
      host: host(
        { double: "inline" },
        {
          double: ({ workflowId, effectId }, value) => {
            expect({ workflowId, effectId }).toEqual({
              workflowId: "inline",
              effectId: "inline:0",
            });
            return (value as number) * 2;
          },
        },
      ),
      store,
    });

    expect(await driver.start("inline", [])).toEqual({
      status: "completed",
      result: 42,
    });
    expect(await driver.read("inline")).toMatchObject({
      revision: 1,
      effectSequence: 1,
      status: "completed",
      result: 42,
    });
  });

  test("allows omitted durable effects until they escape guest handlers", async () => {
    const subsetContract = contract({ wait: { params: [], returns: integer } });
    const deployment = (source: string) =>
      prepareDeployment({
        module: module(source),
        contract: subsetContract,
        profile: {
          version: 1,
          mode: "durable",
          deploymentId: "subset",
          effects: {},
        },
        adapter: { functions: {}, effects: {} },
      });

    const handled = createPreparedDriver({
      deployment: deployment(`
        main: () => pure(handle effects.wait() with {
          wait: (resume) => resume(7)
        })
      `),
      store: new InMemoryWorkflowStore(),
    });
    expect(await handled.start("handled", [])).toEqual({ status: "completed", result: 7 });

    const escaped = createPreparedDriver({
      deployment: deployment("main: () => effects.wait()"),
      store: new InMemoryWorkflowStore(),
    });
    expect(await escaped.start("escaped", [])).toMatchObject({
      status: "failed",
      failure: { code: "unknown-effect" },
    });
  });

  test("resumes from serialized state in a new driver and rejects stale deliveries", async () => {
    const store = new InMemoryWorkflowStore();
    const source = `
      main: () => do {
        value <- effects.wait(40),
        pure(value + 2)
      }
    `;
    const env = contract({ wait: { params: [integer], returns: integer } });
    const first = createDurableDriver({
      module: module(source),
      contract: env,
      host: host({ wait: "suspending" }),
      store,
    });

    const suspended = await first.start("boundary", []);
    expect(suspended).toEqual({
      status: "suspended",
      pending: { effectId: "boundary:0", name: "wait", args: [40] },
    });

    // Build every runtime object again; only the store crosses this boundary.
    const second = createDurableDriver({
      module: module(source),
      contract: structuredClone(env),
      host: host({ wait: "suspending" }),
      store,
    });
    expect(await second.deliverCompletion("boundary", "boundary:0", 40)).toEqual({
      status: "completed",
      result: 42,
    });
    expect(await second.deliverCompletion("boundary", "boundary:0", 41)).toEqual({
      status: "stale",
    });
    expect(await second.deliverCompletion("boundary", "wrong", 41)).toEqual({
      status: "stale",
    });
    expect(await second.read("boundary")).toMatchObject({
      revision: 3,
      status: "completed",
      result: 42,
    });
  });

  test("recovery replays inline effects with stable IDs after a crash", async () => {
    const backing = new InMemoryWorkflowStore();
    let crash = true;
    const crashingStore: WorkflowStore = {
      create: (record) => backing.create(record),
      transition: async (revision, record) => {
        if (crash) {
          crash = false;
          throw new Error("simulated crash");
        }
        return backing.transition(revision, record);
      },
      claim: (workflowId, effectId, result) => backing.claim(workflowId, effectId, result),
      read: (workflowId) => backing.read(workflowId),
      listNonterminal: () => backing.listNonterminal(),
    };
    const effectIds: string[] = [];
    const driver = createDurableDriver({
      module: module(`
        main: () => do {
          value <- effects.inline(1),
          effects.wait(value)
        }
      `),
      contract: contract({
        inline: { params: [integer], returns: integer },
        wait: { params: [integer], returns: integer },
      }),
      host: host(
        { inline: "inline", wait: "suspending" },
        {
          inline: ({ effectId }, value) => {
            effectIds.push(effectId);
            return value ?? null;
          },
        },
      ),
      store: crashingStore,
    });

    await expect(driver.start("recover", [])).rejects.toThrow("simulated crash");
    expect(await backing.read("recover")).toMatchObject({
      revision: 0,
      status: "running",
      basis: { kind: "start" },
    });
    expect(await driver.recover("recover")).toMatchObject({
      status: "suspended",
      pending: { effectId: "recover:1", name: "wait" },
    });
    expect(effectIds).toEqual(["recover:0", "recover:0"]);
  });

  test("maps execution, capability, and external failures", async () => {
    const cases: {
      name: string;
      source: string;
      contract: EnvironmentContract;
      host: DurableTestHost;
      code: string;
    }[] = [
      {
        name: "raise",
        source: `main: () => raise("boom")`,
        contract: contract(),
        host: host({}),
        code: "raise",
      },
      {
        name: "unknown",
        source: `main: () => perform("missing", [])`,
        contract: contract(),
        host: host({}),
        code: "unknown-effect",
      },
      {
        name: "malformed",
        source: `main: () => 1`,
        contract: contract(),
        host: host({}),
        code: "malformed-task",
      },
      {
        name: "contract",
        source: `main: () => perform("inline", ["bad"])`,
        contract: contract({
          inline: { params: [integer], returns: integer },
        }),
        host: host({ inline: "inline" }, { inline: () => 1 }),
        code: "contract",
      },
      {
        name: "limit",
        source: `main: () => pure(1)`,
        contract: contract(),
        host: host({}, {}, { limits: { maxFuel: 0 } }),
        code: "limit",
      },
      {
        name: "host",
        source: `main: () => effects.inline(1)`,
        contract: contract({
          inline: { params: [integer], returns: integer },
        }),
        host: host(
          { inline: "inline" },
          {
            inline: () => {
              throw new Error("capability failed");
            },
          },
        ),
        code: "host",
      },
    ];

    for (const item of cases) {
      const driver = createDurableDriver({
        module: module(item.source),
        contract: item.contract,
        host: item.host,
        store: new InMemoryWorkflowStore(),
      });
      expect(await driver.start(item.name, [])).toMatchObject({
        status: "failed",
        failure: { code: item.code },
      });
    }

    const store = new InMemoryWorkflowStore();
    const external = createDurableDriver({
      module: module(`main: () => effects.wait(1)`),
      contract: contract({
        wait: { params: [integer], returns: integer },
      }),
      host: host({ wait: "suspending" }),
      store,
    });
    await external.start("external", []);
    expect(
      await external.deliverFailure("external", "external:0", {
        message: "worker died",
        payload: { attempt: 2 },
      }),
    ).toEqual({
      status: "failed",
      failure: {
        code: "external",
        message: "worker died",
        payload: { attempt: 2 },
      },
    });
    expect(await external.deliverFailure("external", "external:0", { message: "again" })).toEqual({
      status: "stale",
    });
  });

  test("claims invalid completion results into a terminal contract failure", async () => {
    const driver = createDurableDriver({
      module: module(`main: () => effects.wait(1)`),
      contract: contract({
        wait: { params: [integer], returns: integer },
      }),
      host: host({ wait: "suspending" }),
      store: new InMemoryWorkflowStore(),
    });
    await driver.start("bad-result", []);

    expect(await driver.deliverCompletion("bad-result", "bad-result:0", "bad")).toMatchObject({
      status: "failed",
      failure: { code: "contract" },
    });
    expect(await driver.deliverCompletion("bad-result", "bad-result:0", 1)).toEqual({
      status: "stale",
    });
  });

  test("checks deployment pins before modifying stored state", async () => {
    const store = new InMemoryWorkflowStore();
    const source = `main: () => effects.wait(1)`;
    const env = contract({
      wait: { params: [integer], returns: integer },
    });
    const original = createDurableDriver({
      module: module(source),
      contract: env,
      host: host({ wait: "suspending" }),
      store,
    });
    await original.start("pinned", []);
    const before = await store.read("pinned");

    const mismatched = createDurableDriver({
      module: module(source),
      contract: env,
      host: host({ wait: "suspending" }, {}, { deploymentId: "deployment-b" }),
      store,
    });
    await expect(mismatched.recover("pinned")).rejects.toBeInstanceOf(DeploymentMismatchError);
    await expect(mismatched.deliverCompletion("pinned", "pinned:0", 1)).rejects.toBeInstanceOf(
      DeploymentMismatchError,
    );
    await expect(
      mismatched.deliverFailure("pinned", "pinned:0", { message: "failed" }),
    ).rejects.toBeInstanceOf(DeploymentMismatchError);
    expect(await store.read("pinned")).toEqual(before);
  });

  test("accumulates fuel across suspension hops", async () => {
    const store = new InMemoryWorkflowStore();
    const driver = createDurableDriver({
      module: module(`
        main: () => do {
          first <- effects.wait(1),
          second <- effects.wait(first + 1),
          pure(second + 1)
        }
      `),
      contract: contract({
        wait: { params: [integer], returns: integer },
      }),
      host: host({ wait: "suspending" }),
      store,
    });

    await driver.start("fuel", []);
    const first = await store.read("fuel");
    if (first?.status !== "suspended") throw new Error("Expected first suspension");
    expect(first.fuelUsed).toBeGreaterThan(0);

    await driver.deliverCompletion("fuel", "fuel:0", 1);
    const second = await store.read("fuel");
    if (second?.status !== "suspended") throw new Error("Expected second suspension");
    expect(second.fuelUsed).toBeGreaterThan(first.fuelUsed);

    await driver.deliverCompletion("fuel", "fuel:1", 2);
    const completed = await store.read("fuel");
    if (completed?.status !== "completed") throw new Error("Expected completion");
    expect(completed.fuelUsed).toBeGreaterThan(second.fuelUsed);
    expect(completed.result).toBe(3);
  });

  test("applies portable limits freshly on every durable hop", async () => {
    const store = new InMemoryWorkflowStore();
    const driver = createDurableDriver({
      module: module(`
        go: (remaining) =>
          if remaining <= 0 then pure(0)
          else do {
            effects.wait(remaining),
            go(remaining - 1)
          }
        main: () => go(8)
      `),
      contract: contract({
        wait: { params: [integer], returns: integer },
      }),
      host: host({ wait: "suspending" }, {}, { limits: { maxFuel: 200 } }),
      store,
    });

    let outcome: DeliveryOutcome = await driver.start("fresh-limits", []);
    for (let sequence = 0; sequence < 8; sequence++) {
      expect(outcome.status).toBe("suspended");
      outcome = await driver.deliverCompletion(
        "fresh-limits",
        `fresh-limits:${sequence}`,
        sequence,
      );
    }
    expect(outcome).toEqual({ status: "completed", result: 0 });
    expect((await store.read("fresh-limits"))?.fuelUsed).toBeGreaterThan(200);
  });
});
