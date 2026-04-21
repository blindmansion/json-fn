import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("entries", () => {
  test("returns key-value pairs", () => {
    expect(run({ $return: { $fn: "entries", $args: [{ a: 1, b: 2, c: 3 }] } })).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  test("empty object returns empty array", () => {
    expect(run({ $return: { $fn: "entries", $args: [{}] } })).toEqual([]);
  });
});

describe("fromEntries", () => {
  test("builds object from pairs", () => {
    expect(
      run({
        $return: {
          $fn: "fromEntries",
          $args: [
            [
              ["x", 10],
              ["y", 20],
            ],
          ],
        },
      }),
    ).toEqual({ x: 10, y: 20 });
  });

  test("empty pairs returns empty object", () => {
    expect(run({ $return: { $fn: "fromEntries", $args: [[]] } })).toEqual({});
  });

  test("entries → fromEntries roundtrip", () => {
    const obj = { name: "alice", age: 30 };
    expect(
      run({
        pairs: { $fn: "entries", $args: [obj] },
        $return: { $fn: "fromEntries", $args: [{ $var: "pairs" }] },
      }),
    ).toEqual(obj);
  });
});

describe("merge", () => {
  test("merges two objects", () => {
    expect(run({ $return: { $fn: "merge", $args: [{ a: 1 }, { b: 2 }] } })).toEqual({ a: 1, b: 2 });
  });

  test("second object wins on key conflict", () => {
    expect(
      run({
        $return: {
          $fn: "merge",
          $args: [
            { a: 1, b: 2 },
            { b: 99, c: 3 },
          ],
        },
      }),
    ).toEqual({ a: 1, b: 99, c: 3 });
  });

  test("merging with empty object is identity", () => {
    expect(run({ $return: { $fn: "merge", $args: [{ a: 1 }, {}] } })).toEqual({ a: 1 });
  });
});

describe("hasKey", () => {
  test("returns true for existing key", () => {
    expect(run({ $return: { $fn: "hasKey", $args: [{ x: 1, y: 2 }, "x"] } })).toBe(true);
  });

  test("returns false for missing key", () => {
    expect(run({ $return: { $fn: "hasKey", $args: [{ x: 1 }, "z"] } })).toBe(false);
  });

  test("detects key with null value", () => {
    expect(run({ $return: { $fn: "hasKey", $args: [{ a: null }, "a"] } })).toBe(true);
  });
});

describe("isObject", () => {
  test("true for plain objects", () => {
    expect(run({ $return: { $fn: "isObject", $args: [{ a: 1 }] } })).toBe(true);
  });

  test("true for empty object", () => {
    expect(run({ $return: { $fn: "isObject", $args: [{}] } })).toBe(true);
  });

  test("false for arrays", () => {
    expect(run({ $return: { $fn: "isObject", $args: [[1, 2]] } })).toBe(false);
  });

  test("false for null", () => {
    expect(run({ $return: { $fn: "isObject", $args: [null] } })).toBe(false);
  });

  test("false for primitives", () => {
    expect(run({ $return: { $fn: "isObject", $args: [42] } })).toBe(false);
    expect(run({ $return: { $fn: "isObject", $args: ["hello"] } })).toBe(false);
    expect(run({ $return: { $fn: "isObject", $args: [true] } })).toBe(false);
  });
});

describe("pick", () => {
  test("selects specified keys", () => {
    expect(run({ $return: { $fn: "pick", $args: [{ a: 1, b: 2, c: 3 }, ["a", "c"]] } })).toEqual({
      a: 1,
      c: 3,
    });
  });

  test("ignores keys not present in the object", () => {
    expect(run({ $return: { $fn: "pick", $args: [{ a: 1 }, ["a", "z"]] } })).toEqual({ a: 1 });
  });

  test("empty key list returns empty object", () => {
    expect(run({ $return: { $fn: "pick", $args: [{ a: 1, b: 2 }, []] } })).toEqual({});
  });
});

describe("omit", () => {
  test("excludes specified keys", () => {
    expect(run({ $return: { $fn: "omit", $args: [{ a: 1, b: 2, c: 3 }, ["b"]] } })).toEqual({
      a: 1,
      c: 3,
    });
  });

  test("ignores keys not present in the object", () => {
    expect(run({ $return: { $fn: "omit", $args: [{ a: 1, b: 2 }, ["z"]] } })).toEqual({
      a: 1,
      b: 2,
    });
  });

  test("omitting all keys returns empty object", () => {
    expect(run({ $return: { $fn: "omit", $args: [{ a: 1, b: 2 }, ["a", "b"]] } })).toEqual({});
  });
});

describe("mapValues", () => {
  test("transforms values with inline function", () => {
    expect(
      run({
        $return: {
          $fn: "mapValues",
          $args: [
            { $params: ["v"], $return: { $fn: "mul", $args: [{ $var: "v" }, 2] } },
            { x: 1, y: 2, z: 3 },
          ],
        },
      }),
    ).toEqual({ x: 2, y: 4, z: 6 });
  });

  test("callback receives key as second argument", () => {
    expect(
      run({
        $return: {
          $fn: "mapValues",
          $args: [
            { $params: ["v", "k"], $return: { $var: "k" } },
            { a: 1, b: 2 },
          ],
        },
      }),
    ).toEqual({ a: "a", b: "b" });
  });

  test("works with named function", () => {
    const negate = {
      $params: ["n"],
      $return: { $fn: "neg", $args: [{ $var: "n" }] },
    };
    expect(
      run({ $return: { $fn: "mapValues", $args: [{ $fn: "negate" }, { a: 1, b: -2 }] } }, [], {
        negate,
      }),
    ).toEqual({ a: -1, b: 2 });
  });

  test("empty object returns empty object", () => {
    expect(
      run({
        $return: {
          $fn: "mapValues",
          $args: [{ $params: ["v"], $return: { $var: "v" } }, {}],
        },
      }),
    ).toEqual({});
  });
});

describe("object transformation pipelines", () => {
  test("entries → filter → fromEntries (filter object by value)", () => {
    expect(
      run({
        pairs: { $fn: "entries", $args: [{ a: 1, b: 5, c: 2, d: 8 }] },
        big: {
          $fn: "filter",
          $args: [
            {
              $params: ["pair"],
              value: { $get: 1, $from: { $var: "pair" } },
              $return: { $fn: "gt", $args: [{ $var: "value" }, 3] },
            },
            { $var: "pairs" },
          ],
        },
        $return: { $fn: "fromEntries", $args: [{ $var: "big" }] },
      }),
    ).toEqual({ b: 5, d: 8 });
  });

  test("entries → map → fromEntries (transform keys)", () => {
    expect(
      run({
        pairs: { $fn: "entries", $args: [{ hello: 1, world: 2 }] },
        uppered: {
          $fn: "map",
          $args: [
            {
              $params: ["pair"],
              k: { $fn: "upper", $args: [{ $get: 0, $from: { $var: "pair" } }] },
              v: { $get: 1, $from: { $var: "pair" } },
              $return: [{ $var: "k" }, { $var: "v" }],
            },
            { $var: "pairs" },
          ],
        },
        $return: { $fn: "fromEntries", $args: [{ $var: "uppered" }] },
      }),
    ).toEqual({ HELLO: 1, WORLD: 2 });
  });

  test("merge chain for state update", () => {
    expect(
      run({
        state: { score: 0, lives: 3, level: 1 },
        $return: {
          $fn: "merge",
          $args: [{ $var: "state" }, { score: 100, level: 2 }],
        },
      }),
    ).toEqual({ score: 100, lives: 3, level: 2 });
  });
});
