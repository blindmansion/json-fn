import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = []): JSONType {
  return callFunction(body as any, args, createStdlib());
}

describe("primitives (literals evaluate to themselves)", () => {
  test("string", () => {
    expect(run({ $return: "hello" })).toBe("hello");
  });

  test("number", () => {
    expect(run({ $return: 42 })).toBe(42);
  });

  test("boolean", () => {
    expect(run({ $return: true })).toBe(true);
  });

  test("null", () => {
    expect(run({ $return: null })).toBeNull();
  });

  test("array", () => {
    expect(run({ $return: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  test("object", () => {
    expect(run({ $return: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 });
  });
});
