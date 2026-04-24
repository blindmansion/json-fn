import { describe, expect, test } from "bun:test";
import { callFunction, createPerfStats, createStdlib } from "../src";
import type { FunctionRegistry } from "../src";

const functions: FunctionRegistry = createStdlib();

describe("evaluation state", () => {
  test("expression classification follows object shape changes", () => {
    const expression: Record<string, any> = { value: 1 };

    expect(callFunction({ $return: expression }, [], functions)).toEqual({ value: 1 });

    delete expression.value;
    expression.$fn = ["add", 1, 2];

    expect(callFunction({ $return: expression }, [], functions)).toBe(3);
  });

  test("perf counters are scoped to the call that receives them", () => {
    const unusedStats = createPerfStats();
    const stats = createPerfStats();

    expect(callFunction({ $return: { $fn: ["add", 1, 2] } }, [], functions, { perf: stats })).toBe(
      3,
    );

    expect(stats.evaluateExpression).toBeGreaterThan(0);
    expect(unusedStats.evaluateExpression).toBe(0);
  });
});

describe("stdlib log", () => {
  test("returns the value without logging by default", () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const result = callFunction(
        { $return: { $fn: ["log", { answer: 42, ok: true }, "debug"] } },
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
      { $return: { $fn: ["log", { answer: 42, ok: true }, "debug"] } },
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
