import { describe, expect, test } from "bun:test";
import { callFunction, callProgram, createStdlib, prepareProgram } from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType } from "../src";

const stdlib = createStdlib();

describe("strict runtime parameter semantics", () => {
  test("distinguishes omitted required arguments from explicit null", () => {
    const body = { $params: ["value"], $return: { $var: "value" } } as FunctionDeclaration;

    expect(() => callFunction(body, [], stdlib)).toThrow(
      "Missing required argument at parameter position 1",
    );
    expect(callFunction(body, [null], stdlib)).toBeNull();
  });

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

  test("requires plain objects and required own fields but ignores extra keys", () => {
    const body = {
      $params: [{ $fields: ["value"] }],
      $return: { $var: "value" },
    } as FunctionDeclaration;

    for (const [value, kind] of [
      [null, "null"],
      [0, "number"],
      ["text", "string"],
      [false, "boolean"],
      [[], "array"],
    ] satisfies [JSONType, string][]) {
      expect(() => callFunction(body, [value], stdlib)).toThrow(`received ${kind}`);
    }
    expect(() => callFunction(body, [{}], stdlib)).toThrow('Missing required field "value"');
    expect(callFunction(body, [{ value: 2, extra: 9 }], stdlib)).toBe(2);
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
