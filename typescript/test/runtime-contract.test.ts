import { describe, expect, test } from "bun:test";
import { RuntimeContractError, builtin, callFunction, callProgram, createStdlib } from "../src";
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

describe("checked ascription runtime contracts", () => {
  test("validates data without conversion", () => {
    expect(
      callFunction(
        {
          $return: {
            $as: { id: 3 },
            $type: {
              type: "object",
              properties: { id: { type: "integer", minimum: 0 } },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
        [],
        stdlib,
      ),
    ).toEqual({ id: 3 });

    expect(() =>
      callFunction({ $return: { $as: "1", $type: { type: "integer" } } }, [], stdlib),
    ).toThrow("checked ascription contract failed");
  });

  test("evaluates the operand exactly once", () => {
    let calls = 0;
    const functions = {
      ...stdlib,
      tick: builtin(() => {
        calls++;
        return 1;
      }, 0),
    };
    const result = callFunction(
      {
        $return: {
          $as: { $call: "tick", $args: [] },
          $type: { type: "integer" },
        },
      },
      [],
      functions,
    );
    expect(result).toBe(1);
    expect(calls).toBe(1);
  });

  test("resolves named contracts from active module definitions", () => {
    const module: Record<string, JSONType> = {
      $types: { Count: { type: "integer", minimum: 0 } },
      main: {
        $return: {
          $as: 3,
          $type: { $ref: "#/$defs/Count" },
        },
      },
      bad: {
        $return: {
          $as: -1,
          $type: { $ref: "#/$defs/Count" },
        },
      },
    };
    expect(callProgram(module, "main", [], stdlib)).toBe(3);
    expect(() => callProgram(module, "bad", [], stdlib)).toThrow(
      "checked ascription contract failed",
    );
  });

  test("wraps functions and enforces eventual arguments and returns", () => {
    const contract: JSONType = {
      $fnType: {
        required: [{ type: "integer" }],
        optional: [],
        returns: { type: "integer" },
      },
    };
    const identity: JSONType = {
      $as: {
        $params: ["value"],
        $return: { $var: "value" },
      },
      $type: contract,
    };
    expect(callFunction({ $return: { $call: identity, $args: [3] } }, [], stdlib)).toBe(3);
    expect(() =>
      callFunction({ $return: { $call: identity, $args: ["wrong"] } }, [], stdlib),
    ).toThrow(RuntimeContractError);

    const badReturn: JSONType = {
      $as: {
        $params: ["_value"],
        $return: "wrong",
      },
      $type: contract,
    };
    expect(() => callFunction({ $return: { $call: badReturn, $args: [3] } }, [], stdlib)).toThrow(
      "function return contract failed",
    );
  });

  test("rejects schemas outside the runtime-contract fragment", () => {
    expect(() =>
      callFunction({ $return: { $as: 1, $type: { $taskType: { type: "integer" } } } }, [], stdlib),
    ).toThrow("checked ascription contract failed: unsupported schema");
  });
});

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
