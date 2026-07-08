import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib } from "../src";
import type { FunctionRegistry } from "../src";

const functions: FunctionRegistry = createStdlib();

const addBody = { $return: { $call: "add", $args: [1, 2] } } as any;

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
      $return: { $call: "fib", $args: [30] },
    } as any;
    const fib = {
      $params: ["n"],
      $return: {
        $if: { $call: "lte", $args: [{ $var: "n" }, 1] },
        $then: { $var: "n" },
        $else: {
          $call: "add",
          $args: [
            { $call: "fib", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
            { $call: "fib", $args: [{ $call: "sub", $args: [{ $var: "n" }, 2] }] },
          ],
        },
      },
    };
    expect(() =>
      callFunction(expensiveBody, [], { ...functions, fib }, { signal: controller.signal }),
    ).toThrow("Execution aborted");
  });
});

describe("timeoutMs (wall-clock backstop)", () => {
  test("zero timeout times out before completing", () => {
    // A deadline of "now" is already in the past by the time the first node is
    // visited, so any non-trivial program trips it.
    expect(() =>
      callFunction(
        { $return: { $call: "fib", $args: [30] } } as any,
        [],
        { ...functions, fib },
        {
          timeoutMs: 0,
        },
      ),
    ).toThrow("Execution timed out");
  });

  test("a generous timeout does not interfere", () => {
    const result = callFunction(addBody, [], functions, { timeoutMs: 60_000 });
    expect(result).toBe(3);
  });

  test("no timeout is fine", () => {
    const result = callFunction(addBody, [], functions, {});
    expect(result).toBe(3);
  });

  test("times out inside a native higher-order loop over a pure builtin", () => {
    // map("neg", range(N)) dispatches every callback through the invoke
    // chokepoint without re-entering evaluateExpression; checking there is what
    // lets the deadline interrupt this loop.
    const body = {
      $return: { $call: "map", $args: ["neg", { $call: "range", $args: [2_000_000] }] },
    } as any;
    expect(() => callFunction(body, [], functions, { timeoutMs: 0 })).toThrow(
      "Execution timed out",
    );
  });
});

const fib = {
  $params: ["n"],
  $return: {
    $if: { $call: "lte", $args: [{ $var: "n" }, 1] },
    $then: { $var: "n" },
    $else: {
      $call: "add",
      $args: [
        { $call: "fib", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
        { $call: "fib", $args: [{ $call: "sub", $args: [{ $var: "n" }, 2] }] },
      ],
    },
  },
};
