import { describe, expect, test } from "bun:test";
import { RuntimeContractError, builtin, callFunction, callProgram, createStdlib } from "../src";
import { enforceRuntimeContract } from "../src/runtime-contract";
import type { JSONType } from "../src";

const stdlib = createStdlib();

describe("runtime contract failure diagnostics", () => {
  test("reports a nested instance path through named definitions", () => {
    const defs = {
      PlayerState: {
        type: "object",
        required: ["at", "held"],
        properties: {
          at: { $ref: "#/$defs/Room" },
          held: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      Room: { enum: ["cell", "hall", "gate"] },
    };

    try {
      enforceRuntimeContract(
        [{ at: "attic", held: [] }],
        {
          type: "array",
          prefixItems: [{ $ref: "#/$defs/PlayerState" }],
          items: false,
          minItems: 1,
        },
        defs,
        'entry "play" arguments',
        "args",
      );
      throw new Error("expected the contract to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeContractError);
      expect(error).toMatchObject({
        code: "RUNTIME_CONTRACT_FAILED",
        path: "args[0].at",
        reason: '"attic" is not one of ["cell","hall","gate"]',
      });
      expect((error as Error).message).toBe(
        'entry "play" arguments contract failed at args[0].at: "attic" is not one of ["cell","hall","gate"]',
      );
    }
  });

  const pathCases: Array<[JSONType, JSONType, string, string]> = [
    [
      { profile: {} },
      {
        type: "object",
        properties: {
          profile: {
            type: "object",
            required: ["display-name"],
            properties: { "display-name": { type: "string" } },
          },
        },
      },
      'value.profile["display-name"]',
      "required property is missing",
    ],
    [
      [1, 2, 2],
      { type: "array", items: { type: "integer" }, uniqueItems: true },
      "value[2]",
      "duplicates item at index 1",
    ],
    [
      [1, 2],
      { type: "array", prefixItems: [{ type: "integer" }], items: false },
      "value[1]",
      "additional item is not allowed",
    ],
    [
      { score: -1 },
      {
        type: "object",
        properties: { score: { type: "integer", minimum: 0 } },
        additionalProperties: false,
      },
      "value.score",
      "-1 must be greater than or equal to 0",
    ],
  ];

  test.each(pathCases)("classifies paths and reasons for %#", (value, schema, path, reason) => {
    try {
      enforceRuntimeContract(value, schema, {}, "checked ascription");
      throw new Error("expected the contract to fail");
    } catch (error) {
      expect(error).toMatchObject({ path, reason });
    }
  });
});

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
