import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("arity introspection", () => {
  test("arity of external JS function (by name)", () => {
    expect(run({ $return: { $fn: "arity", $args: ["add"] } })).toBe(2);
  });

  test("arity of single-param external function", () => {
    expect(run({ $return: { $fn: "arity", $args: ["abs"] } })).toBe(1);
  });

  test("arity of a builtin (map)", () => {
    expect(run({ $return: { $fn: "arity", $args: ["map"] } })).toBe(2);
  });

  test("arity of a builtin (reduce)", () => {
    expect(run({ $return: { $fn: "arity", $args: ["reduce"] } })).toBe(3);
  });

  test("arity of a JSON function (by name)", () => {
    const myFn = {
      $params: ["a", "b", "c"],
      $return: { $var: "a" },
    };
    expect(
      run({ $return: { $fn: "arity", $args: ["myFn"] } }, [], { myFn }),
    ).toBe(3);
  });

  test("arity of a JSON function body (inline)", () => {
    expect(
      run({
        body: {
          $params: ["x", "y"],
          $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "y" }] },
        },
        $return: { $fn: "arity", $args: [{ $var: "body" }] },
      }),
    ).toBe(2);
  });

  test("arity of a zero-param JSON function", () => {
    const noArgs = { $return: 42 };
    expect(
      run({ $return: { $fn: "arity", $args: ["noArgs"] } }, [], { noArgs }),
    ).toBe(0);
  });

  test("arity of a JSON function with rest params excludes the rest", () => {
    const varFn = {
      $params: ["first", "second", "...rest"],
      $return: { $var: "first" },
    };
    expect(
      run({ $return: { $fn: "arity", $args: ["varFn"] } }, [], { varFn }),
    ).toBe(2);
  });

  test("arity of unknown function returns null", () => {
    expect(
      run({ $return: { $fn: "arity", $args: ["nonexistent"] } }),
    ).toBeNull();
  });

  test("arity of arity is 1", () => {
    expect(run({ $return: { $fn: "arity", $args: ["arity"] } })).toBe(1);
  });
});
