import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = []): JSONType {
  return callFunction(body as any, args, createStdlib());
}

describe("local variables with $var", () => {
  test("variables can reference each other", () => {
    expect(run({
      a: 5,
      b: 10,
      sum: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
      doubled: { $fn: "mul", $args: [{ $var: "sum" }, 2] },
      $return: { $var: "doubled" },
    })).toBe(30);
  });

  test("variables can reference arguments", () => {
    expect(run({
      x: { $arg: 0 },
      y: { $arg: 1 },
      product: { $fn: "mul", $args: [{ $var: "x" }, { $var: "y" }] },
      $return: { $var: "product" },
    }, [7, 8])).toBe(56);
  });
});
