import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = []): JSONType {
  return callFunction(body as any, args, createStdlib());
}

describe("property access with $get/$from", () => {
  test("single key access on an object", () => {
    expect(
      run({
        person: { name: "Ada", age: 36 },
        $return: { $get: "name", $from: { $var: "person" } },
      }),
    ).toBe("Ada");
  });

  test("numeric index access on an array", () => {
    expect(
      run({
        $return: { $get: 1, $from: [10, 20, 30] },
      }),
    ).toBe(20);
  });

  test("path access walks nested structure", () => {
    expect(
      run({
        person: { name: "Ada", address: { city: "London", zip: "SW1" } },
        $return: { $get: ["address", "city"], $from: { $var: "person" } },
      }),
    ).toBe("London");
  });

  test("dynamic key via variable", () => {
    expect(
      run({
        data: { x: 100, y: 200 },
        field: "y",
        $return: { $get: { $var: "field" }, $from: { $var: "data" } },
      }),
    ).toBe(200);
  });

  test("dynamic key from function result", () => {
    expect(
      run({
        data: { hello: "world" },
        $return: {
          $get: { $fn: "strcat", $args: ["hel", "lo"] },
          $from: { $var: "data" },
        },
      }),
    ).toBe("world");
  });

  test("path with array index", () => {
    expect(
      run({
        data: { items: ["a", "b", "c"] },
        $return: { $get: ["items", 2], $from: { $var: "data" } },
      }),
    ).toBe("c");
  });

  test("missing key returns null", () => {
    expect(
      run({
        obj: { a: 1 },
        $return: { $get: "z", $from: { $var: "obj" } },
      }),
    ).toBeNull();
  });

  test("missing path segment returns null", () => {
    expect(
      run({
        obj: { a: { b: 1 } },
        $return: { $get: ["a", "missing", "deep"], $from: { $var: "obj" } },
      }),
    ).toBeNull();
  });

  test("$get from function call result", () => {
    expect(
      run({
        $return: {
          $get: 0,
          $from: { $fn: "concat", $args: [[10], [20]] },
        },
      }),
    ).toBe(10);
  });

  test("get field then transform", () => {
    expect(
      run({
        person: { name: "ada", age: 36 },
        name: { $get: "name", $from: { $var: "person" } },
        $return: { $fn: "upper", $args: [{ $var: "name" }] },
      }),
    ).toBe("ADA");
  });
});
