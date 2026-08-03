import { describe, expect, test } from "bun:test";
import { callFunction, callProgram, createPerfStats, createStdlib } from "../src";
import { markRuntimeValue } from "../src/runtime-values";
import type { FunctionDeclaration, JSONType } from "../src";

const stdlib = createStdlib();

const countdown: Record<string, JSONType> = {
  go: {
    $params: ["n", "acc"],
    $return: {
      $if: { $call: "lte", $args: [{ $var: "n" }, 0] },
      $then: { $var: "acc" },
      $else: {
        $call: "go",
        $args: [
          { $call: "sub", $args: [{ $var: "n" }, 1] },
          { $call: "add", $args: [{ $var: "acc" }, { $var: "n" }] },
        ],
      },
    },
  },
};

describe("flat function-body dispatch", () => {
  test("module recursion keeps call depth linear", () => {
    const perf = createPerfStats();
    expect(
      callProgram(countdown, "go", [1000, 0], stdlib, {
        maxCallDepth: 1 << 16,
        perf,
      }),
    ).toBe(500500);
    expect(perf.maxCallDepth).toBeLessThan(1200);
  });

  test("preserves escaping local-function attachment metadata", () => {
    const module: Record<string, JSONType> = {
      makeCountdown: {
        $params: ["base"],
        $return: {
          $let: {
            go: {
              $params: ["n"],
              $return: {
                $if: { $call: "lte", $args: [{ $var: "n" }, 0] },
                $then: { $var: "base" },
                $else: {
                  $call: "go",
                  $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }],
                },
              },
            },
          },
          $in: { $var: "go" },
        },
      },
      run: {
        $params: ["base", "start"],
        $return: {
          $call: { $call: "makeCountdown", $args: [{ $var: "base" }] },
          $args: [{ $var: "start" }],
        },
      },
    };
    expect(callProgram(module, "run", [42, 3], stdlib)).toBe(42);
  });
});

describe("captured data values", () => {
  const capture: FunctionDeclaration = {
    $params: ["value"],
    $return: { $params: [], $return: { $var: "value" } },
  };
  test("keeps explicitly raw function-shaped host data inert", () => {
    const payload = markRuntimeValue({ $return: "data", metadata: true });
    const closure = callFunction(capture, [payload], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(payload);
  });
});

describe("constant-subtree fuel accounting", () => {
  function program(): FunctionDeclaration {
    return {
      $return: [
        { id: 1, nested: [1, 2, 3] },
        { id: 2, nested: [4, 5, 6] },
      ],
    };
  }

  test("is stable across repeated evaluation of the same object", () => {
    const fn = program();
    const first = { fuel: 0 };
    const second = { fuel: 0 };

    callFunction(fn, [], stdlib, { usage: first });
    callFunction(fn, [], stdlib, { usage: second });

    expect(second.fuel).toBe(first.fuel);
  });

  test("is stable after a fuel-limited partial evaluation", () => {
    const baseline = { fuel: 0 };
    callFunction(program(), [], stdlib, { usage: baseline });

    const retried = program();
    expect(() => callFunction(retried, [], stdlib, { maxFuel: baseline.fuel - 1 })).toThrow(
      "Maximum fuel",
    );

    const retryUsage = { fuel: 0 };
    callFunction(retried, [], stdlib, { usage: retryUsage });
    expect(retryUsage.fuel).toBe(baseline.fuel);
  });
});
