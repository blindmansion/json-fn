import { describe, expect, test } from "bun:test";
import { callFunction, createStdlib } from "../src";
import type { FunctionRegistry } from "../src";
import { parseExpression } from "../src/shorthand";

function evaluate(source: string, functions: FunctionRegistry): unknown {
  return callFunction({ $return: parseExpression(source) }, [], functions);
}

describe("chained comparison evaluation", () => {
  test("evaluates a nontrivial middle operand once", () => {
    let calls = 0;
    const functions: FunctionRegistry = {
      ...createStdlib(),
      tick: () => {
        calls++;
        return 5;
      },
    };

    expect(evaluate("0 < tick() < 10", functions)).toBe(true);
    expect(calls).toBe(1);
  });

  test("short-circuits before evaluating later operands", () => {
    let calls = 0;
    const functions: FunctionRegistry = {
      ...createStdlib(),
      tick: () => {
        calls++;
        return 10;
      },
    };

    expect(evaluate("2 < 1 < tick()", functions)).toBe(false);
    expect(calls).toBe(0);
  });
});
