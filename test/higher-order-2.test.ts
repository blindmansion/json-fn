import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("flatten", () => {
  test("flattens one level of nesting", () => {
    expect(run({ $return: { $fn: "flatten", $args: [[[1, 2], [3, 4], [5]]] } })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("does not flatten deeper than one level", () => {
    expect(run({ $return: { $fn: "flatten", $args: [[[1, [2, 3]], [4]]] } })).toEqual([
      1,
      [2, 3],
      4,
    ]);
  });

  test("non-array elements pass through", () => {
    expect(run({ $return: { $fn: "flatten", $args: [[1, [2, 3], 4, [5]]] } })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("empty array returns empty array", () => {
    expect(run({ $return: { $fn: "flatten", $args: [[]] } })).toEqual([]);
  });
});

describe("flatMap", () => {
  test("maps and flattens in one step", () => {
    expect(
      run({
        $return: {
          $fn: "flatMap",
          $args: [
            { $params: ["x"], $return: [{ $var: "x" }, { $fn: "neg", $args: [{ $var: "x" }] }] },
            [1, 2, 3],
          ],
        },
      }),
    ).toEqual([1, -1, 2, -2, 3, -3]);
  });

  test("non-array return values are kept as-is", () => {
    expect(
      run({
        $return: {
          $fn: "flatMap",
          $args: [
            { $params: ["x"], $return: { $fn: "mul", $args: [{ $var: "x" }, 10] } },
            [1, 2, 3],
          ],
        },
      }),
    ).toEqual([10, 20, 30]);
  });

  test("callback receives index as second argument", () => {
    expect(
      run({
        $return: {
          $fn: "flatMap",
          $args: [{ $params: ["x", "i"], $return: [{ $var: "i" }] }, ["a", "b", "c"]],
        },
      }),
    ).toEqual([0, 1, 2]);
  });

  test("empty arrays from callback are removed", () => {
    expect(
      run({
        $return: {
          $fn: "flatMap",
          $args: [
            {
              $params: ["x"],
              $return: {
                $if: { $fn: "gt", $args: [{ $var: "x" }, 2] },
                $then: [{ $var: "x" }],
                $else: [],
              },
            },
            [1, 2, 3, 4],
          ],
        },
      }),
    ).toEqual([3, 4]);
  });

  test("empty input returns empty array", () => {
    expect(
      run({
        $return: {
          $fn: "flatMap",
          $args: [{ $params: ["x"], $return: [{ $var: "x" }] }, []],
        },
      }),
    ).toEqual([]);
  });
});

describe("groupBy", () => {
  test("groups by string key", () => {
    const items = [
      { name: "alice", role: "admin" },
      { name: "bob", role: "user" },
      { name: "carol", role: "admin" },
      { name: "dave", role: "user" },
    ];
    expect(
      run({
        $return: {
          $fn: "groupBy",
          $args: [{ $params: ["item"], $return: { $get: "role", $from: { $var: "item" } } }, items],
        },
      }),
    ).toEqual({
      admin: [
        { name: "alice", role: "admin" },
        { name: "carol", role: "admin" },
      ],
      user: [
        { name: "bob", role: "user" },
        { name: "dave", role: "user" },
      ],
    });
  });

  test("groups by computed numeric key", () => {
    expect(
      run({
        $return: {
          $fn: "groupBy",
          $args: [
            {
              $params: ["n"],
              $return: { $fn: "mod", $args: [{ $var: "n" }, 2] },
            },
            [1, 2, 3, 4, 5, 6],
          ],
        },
      }),
    ).toEqual({ "1": [1, 3, 5], "0": [2, 4, 6] });
  });

  test("works with named function", () => {
    const parity = {
      $params: ["n"],
      $return: {
        $if: { $fn: "eq", $args: [{ $fn: "mod", $args: [{ $var: "n" }, 2] }, 0] },
        $then: "even",
        $else: "odd",
      },
    };
    expect(
      run({ $return: { $fn: "groupBy", $args: [{ $fn: "parity" }, [1, 2, 3, 4]] } }, [], {
        parity,
      }),
    ).toEqual({ odd: [1, 3], even: [2, 4] });
  });

  test("empty array returns empty object", () => {
    expect(
      run({
        $return: {
          $fn: "groupBy",
          $args: [{ $params: ["x"], $return: "a" }, []],
        },
      }),
    ).toEqual({});
  });
});

describe("sortBy", () => {
  test("sorts by numeric key function", () => {
    expect(
      run({
        $return: {
          $fn: "sortBy",
          $args: [
            { $params: ["s"], $return: { $fn: "length", $args: [{ $var: "s" }] } },
            ["bbb", "a", "cccc", "dd"],
          ],
        },
      }),
    ).toEqual(["a", "dd", "bbb", "cccc"]);
  });

  test("sorts by string key function", () => {
    const items = [
      { name: "charlie", age: 30 },
      { name: "alice", age: 25 },
      { name: "bob", age: 35 },
    ];
    expect(
      run({
        $return: {
          $fn: "sortBy",
          $args: [{ $params: ["item"], $return: { $get: "name", $from: { $var: "item" } } }, items],
        },
      }),
    ).toEqual([
      { name: "alice", age: 25 },
      { name: "bob", age: 35 },
      { name: "charlie", age: 30 },
    ]);
  });

  test("sorts by object field extraction", () => {
    const items = [
      { name: "alice", age: 30 },
      { name: "bob", age: 20 },
      { name: "carol", age: 25 },
    ];
    expect(
      run({
        $return: {
          $fn: "sortBy",
          $args: [{ $params: ["item"], $return: { $get: "age", $from: { $var: "item" } } }, items],
        },
      }),
    ).toEqual([
      { name: "bob", age: 20 },
      { name: "carol", age: 25 },
      { name: "alice", age: 30 },
    ]);
  });

  test("stable sort preserves order of equal keys", () => {
    const items = [
      { name: "alice", group: 1 },
      { name: "bob", group: 2 },
      { name: "carol", group: 1 },
    ];
    const result = run({
      $return: {
        $fn: "sortBy",
        $args: [{ $params: ["item"], $return: { $get: "group", $from: { $var: "item" } } }, items],
      },
    }) as any[];
    expect(result[0]).toEqual({ name: "alice", group: 1 });
    expect(result[1]).toEqual({ name: "carol", group: 1 });
    expect(result[2]).toEqual({ name: "bob", group: 2 });
  });

  test("empty array returns empty array", () => {
    expect(
      run({
        $return: {
          $fn: "sortBy",
          $args: [{ $params: ["x"], $return: { $var: "x" } }, []],
        },
      }),
    ).toEqual([]);
  });
});

describe("pipe", () => {
  test("threads value through a list of functions", () => {
    expect(
      run({
        $return: { $fn: "pipe", $args: [[{ $fn: "neg" }, { $fn: "abs" }], -5] },
      }),
    ).toBe(5);
  });

  test("single function in pipeline", () => {
    expect(
      run({
        $return: { $fn: "pipe", $args: [[{ $fn: "neg" }], 42] },
      }),
    ).toBe(-42);
  });

  test("empty pipeline returns initial value", () => {
    expect(
      run({
        $return: { $fn: "pipe", $args: [[], 99] },
      }),
    ).toBe(99);
  });

  test("works with inline functions", () => {
    expect(
      run({
        $return: {
          $fn: "pipe",
          $args: [
            [
              { $params: ["x"], $return: { $fn: "mul", $args: [{ $var: "x" }, 2] } },
              { $params: ["x"], $return: { $fn: "add", $args: [{ $var: "x" }, 1] } },
            ],
            5,
          ],
        },
      }),
    ).toBe(11);
  });

  test("works with named functions", () => {
    const double = {
      $params: ["x"],
      $return: { $fn: "mul", $args: [{ $var: "x" }, 2] },
    };
    const addTen = {
      $params: ["x"],
      $return: { $fn: "add", $args: [{ $var: "x" }, 10] },
    };
    expect(
      run(
        {
          $return: { $fn: "pipe", $args: [[{ $fn: "double" }, { $fn: "addTen" }], 3] },
        },
        [],
        { double, addTen },
      ),
    ).toBe(16);
  });

  test("mix of named and inline functions", () => {
    expect(
      run({
        $return: {
          $fn: "pipe",
          $args: [
            [
              { $fn: "neg" },
              { $params: ["x"], $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "x" }] } },
              { $fn: "str" },
            ],
            3,
          ],
        },
      }),
    ).toBe("9");
  });

  test("pipeline over a string: split → length", () => {
    expect(
      run({
        $return: {
          $fn: "pipe",
          $args: [
            [
              { $params: ["s"], $return: { $fn: "split", $args: [{ $var: "s" }, " "] } },
              { $fn: "length" },
            ],
            "hello world foo",
          ],
        },
      }),
    ).toBe(3);
  });
});
