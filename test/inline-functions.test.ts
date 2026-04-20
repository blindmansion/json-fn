import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = []): JSONType {
  return callFunction(body as any, args, createStdlib());
}

describe("inline (anonymous) functions", () => {
  test("inline square(5)", () => {
    expect(
      run({
        $return: {
          $fn: {
            $params: ["x"],
            $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "x" }] },
          },
          $args: [5],
        },
      }),
    ).toBe(25);
  });

  test("nested inline: sumThenSquare(3, 4)", () => {
    expect(
      run({
        $return: {
          $fn: {
            $params: ["a", "b"],
            $return: {
              $fn: {
                $params: ["sum"],
                $return: { $fn: "mul", $args: [{ $var: "sum" }, { $var: "sum" }] },
              },
              $args: [{ $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] }],
            },
          },
          $args: [3, 4],
        },
      }),
    ).toBe(49);
  });
});
