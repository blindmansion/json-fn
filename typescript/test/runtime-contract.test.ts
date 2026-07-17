import { describe, expect, test } from "bun:test";
import { RuntimeContractError, callFunction, callProgram, createStdlib } from "../src";
import type { JSONType } from "../src";

const stdlib = createStdlib();

function annotatedFunctionHandle(
  body: JSONType,
  parameter: JSONType = { type: "integer" },
  returns: JSONType = { type: "integer" },
): JSONType {
  return {
    $call: "handle",
    $args: [
      { $call: "pure", $args: [null] },
      { return: { $params: ["_"], $return: body } },
      { $raw: { $fnType: { required: [parameter], optional: [], returns } } },
    ],
  };
}

describe("annotated handle runtime contracts", () => {
  test("function contracts reject invalid eventual arguments", () => {
    const expression = {
      $return: {
        $call: annotatedFunctionHandle({
          $params: ["value"],
          $return: { $var: "value" },
        }),
        $args: ["wrong"],
      },
    };

    expect(() => callFunction(expression, [], stdlib)).toThrow(RuntimeContractError);
    expect(() => callFunction(expression, [], stdlib)).toThrow(
      "function arguments contract failed",
    );
  });

  test("function contracts reject invalid eventual return values", () => {
    const expression = {
      $return: {
        $call: annotatedFunctionHandle({
          $params: ["_value"],
          $return: "wrong",
        }),
        $args: [1],
      },
    };

    expect(() => callFunction(expression, [], stdlib)).toThrow("function return contract failed");
  });

  test("runtime contracts resolve active module types", () => {
    const module: Record<string, JSONType> = {
      $types: {
        Count: { type: "integer", minimum: 0 },
      },
      main: {
        $return: {
          $call: "handle",
          $args: [{ $call: "pure", $args: [3] }, {}, { $raw: { $ref: "#/$defs/Count" } }],
        },
      },
      bad: {
        $return: {
          $call: "handle",
          $args: [{ $call: "pure", $args: [-1] }, {}, { $raw: { $ref: "#/$defs/Count" } }],
        },
      },
    };

    expect(callProgram(module, "main", [], stdlib)).toBe(3);
    expect(() => callProgram(module, "bad", [], stdlib)).toThrow("handle result contract failed");
  });
});
