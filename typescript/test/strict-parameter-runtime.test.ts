import { describe, expect, test } from "bun:test";
import { callFunction, callProgram, createStdlib, prepareProgram } from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType } from "../src";

const stdlib = createStdlib();

describe("strict runtime parameter semantics", () => {
  test("validates fixed slots before a rest parameter", () => {
    const body = {
      $params: ["first", "...rest"],
      $return: { first: { $var: "first" }, rest: { $var: "rest" } },
    } as FunctionDeclaration;

    expect(() => callFunction(body, [], stdlib)).toThrow(
      "Missing required argument at parameter position 1",
    );
    expect(callFunction(body, [1], stdlib)).toEqual({ first: 1, rest: [] });
    expect(callFunction(body, [1, 2, 3], stdlib)).toEqual({ first: 1, rest: [2, 3] });
  });

  test("requires every object-pattern slot even when all fields are defaulted", () => {
    const body = {
      $params: [{ $fields: [{ $field: "value", $default: 3 }] }],
      $return: { $var: "value" },
    } as FunctionDeclaration;

    expect(() => callFunction(body, [], stdlib)).toThrow(
      "Missing object-pattern argument at parameter position 1",
    );
    expect(callFunction(body, [{}], stdlib)).toBe(3);
    expect(callFunction(body, [{ value: null }], stdlib)).toBeNull();
  });

  test.each([
    {
      name: "required-only",
      params: ["value"],
      rejected: [
        [
          [],
          "Missing required argument at parameter position 1. Expected exactly 1 argument, received 0.",
        ],
        [[1, 2], "Expected exactly 1 argument, received 2."],
      ],
    },
    {
      name: "optional-only",
      params: [
        { $param: "first", $optional: true },
        { $param: "second", $optional: true },
      ],
      rejected: [[[1, 2, 3], "Expected 0 to 2 arguments, received 3."]],
    },
    {
      name: "required-plus-optional",
      params: ["required", { $param: "optional", $optional: true }],
      rejected: [
        [
          [],
          "Missing required argument at parameter position 1. Expected 1 to 2 arguments, received 0.",
        ],
        [[1, 2, 3], "Expected 1 to 2 arguments, received 3."],
      ],
    },
    {
      name: "required-plus-defaulted",
      params: ["required", { $param: "defaulted", $default: 2 }],
      rejected: [
        [
          [],
          "Missing required argument at parameter position 1. Expected 1 to 2 arguments, received 0.",
        ],
        [[1, 2, 3], "Expected 1 to 2 arguments, received 3."],
      ],
    },
    {
      name: "mixed-optional-defaulted",
      params: [
        "required",
        { $param: "optional", $optional: true },
        { $param: "defaulted", $default: 3 },
      ],
      rejected: [
        [
          [],
          "Missing required argument at parameter position 1. Expected 1 to 3 arguments, received 0.",
        ],
        [[1, 2, 3, 4], "Expected 1 to 3 arguments, received 4."],
      ],
    },
    {
      name: "rest",
      params: ["required", "...rest"],
      rejected: [
        [
          [],
          "Missing required argument at parameter position 1. Expected at least 1 argument, received 0.",
        ],
      ],
    },
  ] satisfies {
    name: string;
    params: JSONType[];
    rejected: [JSONType[], string][];
  }[])("keeps the exact accepted-range diagnostic for $name layouts", ({ params, rejected }) => {
    const body = { $params: params, $return: null } as FunctionDeclaration;

    for (const [args, expected] of rejected) {
      let thrown: unknown;
      try {
        callFunction(body, args, stdlib);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(expected);
    }
  });

  test("uses the same validation for direct, registry, inline, and program calls", () => {
    const unary = { $params: ["value"], $return: { $var: "value" } };
    const registry: FunctionRegistry = { ...stdlib, unary };
    const inline = {
      $return: { $call: unary as JSONType, $args: [] },
    } as FunctionDeclaration;
    const module = { unary: unary as JSONType };

    expect(() => callFunction(unary, [], stdlib)).toThrow("Missing required argument");
    expect(() => callFunction("unary", [], registry)).toThrow("Missing required argument");
    expect(() => callFunction(inline, [], stdlib)).toThrow("Missing required argument");
    expect(() => callProgram(module, "unary", [], stdlib)).toThrow("Missing required argument");
    expect(() => prepareProgram(module, stdlib).invokeEntry("unary", [])).toThrow(
      "Missing required argument",
    );
  });
});
