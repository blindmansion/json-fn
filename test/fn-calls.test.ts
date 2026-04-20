import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = []): JSONType {
  return callFunction(body as any, args, createStdlib());
}

describe("calling external (JS) functions with $fn/$args", () => {
  test("add(3, 4)", () => {
    expect(run({ $return: { $fn: "add", $args: [3, 4] } })).toBe(7);
  });

  test("upper('hello')", () => {
    expect(run({ $return: { $fn: "upper", $args: ["hello"] } })).toBe("HELLO");
  });

  test("nested calls: mul(add(2,3), sub(10,4))", () => {
    expect(
      run({
        $return: {
          $fn: "mul",
          $args: [
            { $fn: "add", $args: [2, 3] },
            { $fn: "sub", $args: [10, 4] },
          ],
        },
      }),
    ).toBe(30);
  });
});

describe("named parameters with $params", () => {
  test("$params binds arguments by name", () => {
    expect(
      run(
        {
          $params: ["a", "b"],
          $return: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
        },
        [10, 20],
      ),
    ).toBe(30);
  });
});
