import { describe, expect, test } from "bun:test";
import {
  DeploymentMismatchError,
  InMemoryWorkflowStore,
  createDurableDriver,
  createStdlib,
  parseShorthand,
  type DurableHostConfiguration,
  type Environment,
  type JSONType,
  type WorkflowStore,
} from "../src";

const integer = { type: "integer" } as const;
const stdlib = createStdlib();

function module(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

function environment(
  effects: Environment["effects"] = {},
  returns: Environment["entry"]["returns"] = { task: integer },
): Environment {
  return {
    effects,
    entry: { name: "main", required: [], optional: [], returns },
  };
}

function host(
  effects: DurableHostConfiguration["effects"],
  capabilities: DurableHostConfiguration["capabilities"] = {},
  overrides: Partial<DurableHostConfiguration> = {},
): DurableHostConfiguration {
  return {
    registry: stdlib,
    effects,
    capabilities,
    deploymentId: "deployment-a",
    ...overrides,
  };
}

describe("durable driver", () => {
  test("completes an inline-only workflow in start", async () => {
    const store = new InMemoryWorkflowStore();
    const driver = createDurableDriver({
      module: module(`{
        main: () => do {
          value <- effects.double(20),
          pure(value + 2)
        }
      }`),
      environment: environment({
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

  test("resumes from serialized state in a new driver and rejects stale deliveries", async () => {
    const store = new InMemoryWorkflowStore();
    const source = `{
      main: () => do {
        value <- effects.wait(40),
        pure(value + 2)
      }
    }`;
    const env = environment({ wait: { params: [integer], returns: integer } });
    const first = createDurableDriver({
      module: module(source),
      environment: env,
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
      environment: structuredClone(env),
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
      module: module(`{
        main: () => do {
          value <- effects.inline(1),
          effects.wait(value)
        }
      }`),
      environment: environment({
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
      environment: Environment;
      host: DurableHostConfiguration;
      code: string;
    }[] = [
      {
        name: "raise",
        source: `{ main: () => raise("boom") }`,
        environment: environment(),
        host: host({}),
        code: "raise",
      },
      {
        name: "unknown",
        source: `{ main: () => perform("missing", []) }`,
        environment: environment(),
        host: host({}),
        code: "unknown-effect",
      },
      {
        name: "malformed",
        source: `{ main: () => 1 }`,
        environment: environment(),
        host: host({}),
        code: "malformed-task",
      },
      {
        name: "contract",
        source: `{ main: () => perform("inline", ["bad"]) }`,
        environment: environment({
          inline: { params: [integer], returns: integer },
        }),
        host: host({ inline: "inline" }, { inline: () => 1 }),
        code: "contract",
      },
      {
        name: "limit",
        source: `{ main: () => pure(1) }`,
        environment: environment(),
        host: host({}, {}, { limits: { maxFuel: 0 } }),
        code: "limit",
      },
      {
        name: "host",
        source: `{ main: () => effects.inline(1) }`,
        environment: environment({
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
        environment: item.environment,
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
      module: module(`{ main: () => effects.wait(1) }`),
      environment: environment({
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
      module: module(`{ main: () => effects.wait(1) }`),
      environment: environment({
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
    const source = `{ main: () => effects.wait(1) }`;
    const env = environment({
      wait: { params: [integer], returns: integer },
    });
    const original = createDurableDriver({
      module: module(source),
      environment: env,
      host: host({ wait: "suspending" }),
      store,
    });
    await original.start("pinned", []);
    const before = await store.read("pinned");

    const mismatched = createDurableDriver({
      module: module(source),
      environment: env,
      host: host({ wait: "suspending" }, {}, { deploymentId: "deployment-b" }),
      store,
    });
    await expect(mismatched.recover("pinned")).rejects.toBeInstanceOf(DeploymentMismatchError);
    await expect(mismatched.deliverCompletion("pinned", "pinned:0", 1)).rejects.toBeInstanceOf(
      DeploymentMismatchError,
    );
    expect(await store.read("pinned")).toEqual(before);
  });

  test("accumulates fuel across suspension hops", async () => {
    const store = new InMemoryWorkflowStore();
    const driver = createDurableDriver({
      module: module(`{
        main: () => do {
          first <- effects.wait(1),
          second <- effects.wait(first + 1),
          pure(second + 1)
        }
      }`),
      environment: environment({
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
});
