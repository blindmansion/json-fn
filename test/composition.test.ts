import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("composing features together", () => {
  const fact: any = {
    $params: ["n"],
    $return: {
      $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
      $then: 1,
      $else: {
        $fn: "mul",
        $args: [{ $var: "n" }, { $fn: "fact", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] }],
      },
    },
  };

  const isEven = {
    $params: ["n"],
    remainder: { $fn: "mod", $args: [{ $var: "n" }, 2] },
    $return: { $fn: "eq", $args: [{ $var: "remainder" }, 0] },
  };

  test("isEven(fact(6)) — combines named functions, variables, conditionals", () => {
    expect(
      run(
        {
          result: { $fn: "fact", $args: [6] },
          check: { $fn: "isEven", $args: [{ $var: "result" }] },
          $return: {
            $if: { $var: "check" },
            $then: { $fn: "strcat", $args: ["720 is ", "even"] },
            $else: { $fn: "strcat", $args: ["720 is ", "odd"] },
          },
        },
        [],
        { fact, isEven },
      ),
    ).toBe("720 is even");
  });

  test("greeting from parts using variables and strcat", () => {
    expect(
      run(
        {
          $params: ["first", "last"],
          full: {
            $fn: "strcat",
            $args: [{ $var: "first" }, { $fn: "strcat", $args: [" ", { $var: "last" }] }],
          },
          $return: { $fn: "strcat", $args: ["Hello, ", { $var: "full" }] },
        },
        ["Ada", "Lovelace"],
      ),
    ).toBe("Hello, Ada Lovelace");
  });
});
