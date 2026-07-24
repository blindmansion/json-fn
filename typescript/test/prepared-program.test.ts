import { describe, expect, test } from "bun:test";
import { callFunction, createStdlib, hydrateTask, prepareProgram, serializeTask } from "../src";
import type { JSONType } from "../src";

const stdlib = createStdlib();

describe("prepareProgram", () => {
  test("invokeEntry evaluates an entry in the prepared module scope", () => {
    const module: Record<string, JSONType> = {
      offset: 10,
      addOffset: {
        $params: ["value"],
        $return: {
          $call: "add",
          $args: [{ $var: "value" }, { $var: "offset" }],
        },
      },
    };
    const prepared = prepareProgram(module, stdlib);

    expect(prepared.invokeEntry("addOffset", [5])).toBe(15);
    expect(() => prepared.invokeEntry("missing", [])).toThrow(
      'Program entry "missing" is not a function defined by the module',
    );
  });

  test("call applies an escaping closure captured in module scope", () => {
    const module: Record<string, JSONType> = {
      makeAdder: {
        $params: ["amount"],
        $return: {
          $let: {
            addAmount: {
              $params: ["value"],
              $return: {
                $call: "add",
                $args: [{ $var: "value" }, { $var: "amount" }],
              },
            },
          },
          $in: { $var: "addAmount" },
        },
      },
    };
    const prepared = prepareProgram(module, stdlib);
    const addTwo = prepared.invokeEntry("makeAdder", [2]);

    expect(prepared.call(addTwo, [5])).toBe(7);
  });

  test("does not attach persistent module functions to escaping values", () => {
    const module: Record<string, JSONType> = {
      helper: {
        $params: ["value"],
        $return: { $var: "value" },
      },
      getHelper: {
        $return: { $var: "helper" },
      },
    };
    const prepared = prepareProgram(module, stdlib);
    const helper = prepared.invokeEntry("getHelper", []);

    expect(prepared.call(helper, [5])).toBe(5);
    expect(Object.prototype.hasOwnProperty.call(helper, "helper")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(helper, "$captures")).toBe(false);
  });

  test("attaches mutually recursive local functions transitively and cycle-safely", () => {
    const decrement = { $call: "sub", $args: [{ $var: "value" }, 1] };
    const module: Record<string, JSONType> = {
      makeEven: {
        $return: {
          $let: {
            even: {
              $params: ["value"],
              $return: {
                $if: { $call: "eq", $args: [{ $var: "value" }, 0] },
                $then: true,
                $else: { $call: "odd", $args: [decrement] },
              },
            },
            odd: {
              $params: ["value"],
              $return: {
                $if: { $call: "eq", $args: [{ $var: "value" }, 0] },
                $then: false,
                $else: { $call: "even", $args: [decrement] },
              },
            },
          },
          $in: { $var: "even" },
        },
      },
    };
    const prepared = prepareProgram(module, stdlib);
    const even = prepared.invokeEntry("makeEven", []);

    expect(Object.keys((even as Record<string, JSONType>).$captures as object).sort()).toEqual([
      "even",
      "odd",
    ]);
    expect(Object.prototype.hasOwnProperty.call(even, "even")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(even, "odd")).toBe(false);
    expect(prepared.call(even, [6])).toBe(true);
    expect(prepared.call(even, [5])).toBe(false);
    expect(callFunction(JSON.parse(JSON.stringify(even)), [8], stdlib)).toBe(true);
  });

  test("shares one fuel budget across prepared calls", () => {
    const module: Record<string, JSONType> = {
      identity: {
        $params: ["value"],
        $return: { $var: "value" },
      },
    };
    const baselineUsage = { fuel: 0 };
    prepareProgram(module, stdlib, { usage: baselineUsage }).invokeEntry("identity", [1]);
    expect(baselineUsage.fuel).toBeGreaterThan(0);

    const usage = { fuel: 0 };
    const prepared = prepareProgram(module, stdlib, {
      maxFuel: baselineUsage.fuel,
      usage,
    });

    expect(prepared.invokeEntry("identity", [1])).toBe(1);
    expect(usage.fuel).toBe(baselineUsage.fuel);
    expect(() => prepared.invokeEntry("identity", [2])).toThrow(
      `Maximum fuel limit of ${baselineUsage.fuel} exceeded`,
    );
  });

  test("refreshDeadline excludes time between host hops", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const module: Record<string, JSONType> = {
        identity: {
          $params: ["value"],
          $return: { $var: "value" },
        },
      };
      const prepared = prepareProgram(module, stdlib, { timeoutMs: 10 });

      now = 1_011;
      expect(() => prepared.invokeEntry("identity", [1])).toThrow("Execution timed out");

      prepared.refreshDeadline();
      expect(prepared.invokeEntry("identity", [2])).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("task persistence", () => {
  test("serializeTask and hydrateTask preserve task JSON and restore task inertness", () => {
    const expression = { $call: "add", $args: [1, 2] };
    const task: JSONType = {
      "@task": "bind",
      task: {
        "@task": "effect",
        name: "read",
        args: [expression],
      },
      // eslint-disable-next-line no-thenable -- `then` is the task field name, not a Promise method
      then: {
        $params: ["value"],
        $return: {
          "@task": "pure",
          value: { $var: "value" },
        },
      },
    };

    const serialized = serializeTask(task);
    const hydrated = hydrateTask(serialized);

    expect(hydrated).toEqual(task);
    expect(JSON.parse(serialized)).toEqual(task);

    const nestedEffect = (hydrated as Record<string, JSONType>).task!;
    expect(callFunction({ $return: nestedEffect }, [], stdlib)).toEqual({
      "@task": "effect",
      name: "read",
      args: [expression],
    });
  });

  test("rejects non-task serialization and hydration inputs", () => {
    expect(() => serializeTask({ value: 1 })).toThrow("serializeTask: value is not a task");
    expect(() => hydrateTask('{"value":1}')).toThrow("hydrateTask: value is not a task");
  });
});
