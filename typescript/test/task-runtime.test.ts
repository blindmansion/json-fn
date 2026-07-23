import { describe, expect, test } from "bun:test";
import {
  ModuleLinkError,
  RuntimeContractError,
  parseShorthand,
  prepareDeployment,
  type EnvironmentContract,
  type JSONType,
} from "../src";
import { TaskRaiseError, type HostLocalRunOptions } from "../src/host/task-runtime";

const integer = { type: "integer" } as const;

function module(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

describe("TaskSession", () => {
  test("prepared deployments own fresh task sessions and are frozen", () => {
    const contract: EnvironmentContract = {
      version: 1,
      entry: {
        name: "main",
        required: [],
        optional: [],
        returns: integer,
      },
    };
    const deployment = prepareDeployment({
      module: module(`{ main: () => 1 }`),
      contract,
      profile: { version: 1, mode: "live", effects: [] },
      adapter: { functions: {}, effects: {} },
    });

    expect(Object.isFrozen(deployment)).toBe(true);
    expect(deployment.createTaskSession()).not.toBe(deployment.createTaskSession());
  });

  test("validates and advances a task across a host effect", () => {
    const contract: EnvironmentContract = {
      version: 1,
      effects: {
        echo: { params: [integer], returns: integer },
      },
      entry: {
        name: "main",
        required: [integer],
        optional: [],
        returns: { task: integer },
      },
    };
    const usage = { fuel: 0 };
    const runtime = session(
      module(`{
        main: (start) => do {
          value <- effects.echo(start),
          pure(value + 1)
        }
      }`),
      contract,
      { usage },
    );

    expect(() => runtime.validateArgs(["bad"])).toThrow(RuntimeContractError);
    const task = runtime.invokeEntry(runtime.validateArgs([2]));
    const firstFuel = runtime.fuelUsed();
    expect(firstFuel).toBeGreaterThan(0);
    expect(usage.fuel).toBe(firstFuel);

    const stepped = runtime.step(task);
    if ("done" in stepped) throw new Error("Expected echo to suspend");
    expect({ name: stepped.pending.name, args: stepped.pending.args }).toEqual({
      name: "echo",
      args: [2],
    });
    expect(runtime.fuelUsed()).toBeGreaterThan(firstFuel);

    expect(() => runtime.applyResume(stepped.pending.resume, "echo", "bad")).toThrow(
      RuntimeContractError,
    );
    const resumed = runtime.applyResume(stepped.pending.resume, "echo", 3);
    const completed = runtime.step(resumed);
    if ("pending" in completed) throw new Error("Expected resumed task to complete");
    expect(runtime.validateCompletion(completed.done)).toBe(4);
    expect(() => runtime.validateCompletion("bad")).toThrow(RuntimeContractError);
  });

  test("resumes through a do-block discard continuation", () => {
    const contract: EnvironmentContract = {
      version: 1,
      effects: {
        echo: { params: [integer], returns: integer },
      },
      entry: {
        name: "main",
        required: [integer],
        optional: [],
        returns: { task: integer },
      },
    };
    const runtime = session(
      module(`{
        main: (start) => do {
          effects.echo(start),
          pure(start + 1)
        }
      }`),
      contract,
    );

    const first = runtime.step(runtime.invokeEntry([2]));
    if ("done" in first) throw new Error("Expected echo to suspend");
    const completed = runtime.step(runtime.applyResume(first.pending.resume, "echo", 99));

    expect(completed).toEqual({ done: 3 });
  });

  test("maps raise and unknown effects at the shared stepping boundary", () => {
    const contract: EnvironmentContract = {
      version: 1,
      effects: {},
      entry: {
        name: "main",
        required: [],
        optional: [],
        returns: { task: integer },
      },
    };

    const raising = session(module(`{ main: () => raise("boom") }`), contract);
    try {
      raising.step(raising.invokeEntry([]));
      throw new Error("Expected raise to escape");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRaiseError);
      expect((error as TaskRaiseError).payload).toBe("boom");
    }

    const unknown = session(module(`{ main: () => perform("missing", []) }`), contract);
    expect(() => unknown.step(unknown.invokeEntry([]))).toThrow('unknown effect "missing"');
  });

  test("rejects a module that shadows the generated effects namespace", () => {
    const contract: EnvironmentContract = {
      version: 1,
      effects: {},
      entry: {
        name: "main",
        required: [],
        optional: [],
        returns: { task: integer },
      },
    };

    expect(() =>
      session(
        {
          effects: null,
          main: { $params: [], $return: { $call: "pure", $args: [1] } },
        },
        contract,
      ),
    ).toThrow(ModuleLinkError);
  });
});

function session(
  source: Record<string, JSONType>,
  contract: EnvironmentContract,
  runOptions: HostLocalRunOptions = {},
) {
  const effects = Object.fromEntries(
    Object.keys(contract.effects ?? {}).map((name) => [name, () => null]),
  );
  const deployment = prepareDeployment({
    module: source,
    contract,
    profile: { version: 1, mode: "live", effects: Object.keys(effects) },
    adapter: { functions: {}, effects },
  });
  return deployment.createTaskSession(runOptions);
}
