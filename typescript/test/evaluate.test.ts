import { describe, expect, test } from "bun:test";
import { callFunction, createPerfStats, createStdlib } from "../src";
import type { FunctionRegistry, JSONType } from "../src";

const functions: FunctionRegistry = createStdlib();

describe("evaluation state", () => {
  test("expression classification follows object shape changes", () => {
    const expression: Record<string, any> = { value: 1 };

    expect(callFunction({ $return: expression }, [], functions)).toEqual({ value: 1 });

    delete expression.value;
    expression.$call = "add";
    expression.$args = [1, 2];

    expect(callFunction({ $return: expression }, [], functions)).toBe(3);
  });

  test("perf counters are scoped to the call that receives them", () => {
    const unusedStats = createPerfStats();
    const stats = createPerfStats();

    expect(
      callFunction({ $return: { $call: "add", $args: [1, 2] } }, [], functions, { perf: stats }),
    ).toBe(3);

    expect(stats.evaluateExpression).toBeGreaterThan(0);
    expect(unusedStats.evaluateExpression).toBe(0);
  });
});

describe("canonical assertion classification", () => {
  test("$nonnull rejects null and otherwise returns its operand", () => {
    expect(callFunction({ $return: { $nonnull: 3 } }, [], functions)).toBe(3);
    expect(() => callFunction({ $return: { $nonnull: null } }, [], functions)).toThrow(
      "Assertion failed: expected a non-null value.",
    );
  });
});

describe("stdlib mapValues", () => {
  test("passes each value and key while preserving the input keys", () => {
    const expression: JSONType = {
      $call: "mapValues",
      $args: [
        {
          $params: ["value", "key"],
          $return: {
            value: { $call: "add", $args: [{ $var: "value" }, 1] },
            key: { $var: "key" },
          },
        },
        { a: 1, b: 2 },
      ],
    };

    expect(callFunction({ $return: expression }, [], functions)).toEqual({
      a: { value: 2, key: "a" },
      b: { value: 3, key: "b" },
    });
  });
});

describe("stdlib tap", () => {
  test("returns the value without logging by default", () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const result = callFunction(
        { $return: { $call: "tap", $args: [{ answer: 42, ok: true }, "debug"] } },
        [],
        createStdlib(),
      );

      expect(result).toEqual({ answer: 42, ok: true });
      expect(calls).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  test("calls the configured logger", () => {
    const calls: unknown[][] = [];
    const result = callFunction(
      { $return: { $call: "tap", $args: [{ answer: 42, ok: true }, "debug"] } },
      [],
      createStdlib({
        logger: (value, label) => {
          calls.push([value, label]);
        },
      }),
    );

    expect(result).toEqual({ answer: 42, ok: true });
    expect(calls).toEqual([[{ answer: 42, ok: true }, "debug"]]);
  });
});
