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
