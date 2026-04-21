import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib } from "../src";
import type { FunctionRegistry } from "../src";

const functions: FunctionRegistry = createStdlib();

const addBody = { $return: { $fn: ["add", 1, 2] } } as any;

describe("AbortSignal", () => {
  test("pre-aborted signal throws immediately", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => callFunction(addBody, [], functions, { signal: controller.signal })).toThrow(
      "Execution aborted",
    );
  });

  test("non-aborted signal does not interfere", () => {
    const controller = new AbortController();
    const result = callFunction(addBody, [], functions, { signal: controller.signal });
    expect(result).toBe(3);
  });

  test("no signal is fine", () => {
    const result = callFunction(addBody, [], functions);
    expect(result).toBe(3);
  });

  test("pre-aborted signal prevents any evaluation", () => {
    const controller = new AbortController();
    controller.abort();
    const expensiveBody = {
      $return: { $fn: ["fib", 30] },
    } as any;
    const fib = {
      $params: ["n"],
      $return: {
        $if: { $fn: ["lte", { $var: "n" }, 1] },
        $then: { $var: "n" },
        $else: {
          $fn: [
            "add",
            { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 1] }] },
            { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 2] }] },
          ],
        },
      },
    };
    expect(() =>
      callFunction(expensiveBody, [], { ...functions, fib }, { signal: controller.signal }),
    ).toThrow("Execution aborted");
  });
});
