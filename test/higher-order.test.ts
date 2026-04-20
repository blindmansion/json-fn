import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

const double = {
  $params: ["x"],
  $return: { $fn: "mul", $args: [{ $var: "x" }, 2] },
};

const isEven = {
  $params: ["n"],
  remainder: { $fn: "mod", $args: [{ $var: "n" }, 2] },
  $return: { $fn: "eq", $args: [{ $var: "remainder" }, 0] },
};

describe("map", () => {
  test("map with a named function (double)", () => {
    expect(
      run({ $return: { $fn: "map", $args: [{ $fn: "double" }, [1, 2, 3, 4]] } }, [], { double }),
    ).toEqual([2, 4, 6, 8]);
  });

  test("map with an inline square function", () => {
    expect(
      run({
        $return: {
          $fn: "map",
          $args: [
            { $params: ["x"], $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "x" }] } },
            [1, 2, 3, 4, 5],
          ],
        },
      }),
    ).toEqual([1, 4, 9, 16, 25]);
  });

  test("map with a named JSON function (isEven)", () => {
    expect(
      run({ $return: { $fn: "map", $args: [{ $fn: "isEven" }, [1, 2, 3, 4]] } }, [], { isEven }),
    ).toEqual([false, true, false, true]);
  });

  test("map using index argument (element + index)", () => {
    expect(
      run({
        $return: {
          $fn: "map",
          $args: [
            {
              $params: ["item", "idx"],
              $return: { $fn: "add", $args: [{ $var: "item" }, { $var: "idx" }] },
            },
            [10, 20, 30],
          ],
        },
      }),
    ).toEqual([10, 21, 32]);
  });
});

describe("filter", () => {
  test("filter with a named JSON function (isEven)", () => {
    expect(
      run({ $return: { $fn: "filter", $args: [{ $fn: "isEven" }, [1, 2, 3, 4, 5, 6]] } }, [], {
        isEven,
      }),
    ).toEqual([2, 4, 6]);
  });

  test("filter with inline function (values > 3)", () => {
    expect(
      run({
        $return: {
          $fn: "filter",
          $args: [
            { $params: ["x"], $return: { $fn: "gt", $args: [{ $var: "x" }, 3] } },
            [1, 2, 3, 4, 5, 6],
          ],
        },
      }),
    ).toEqual([4, 5, 6]);
  });
});

describe("reduce", () => {
  test("reduce with a named external function (add)", () => {
    expect(
      run({
        $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, [1, 2, 3, 4]] },
      }),
    ).toBe(10);
  });

  test("reduce with inline function (sum of squares)", () => {
    expect(
      run({
        $return: {
          $fn: "reduce",
          $args: [
            {
              $params: ["acc", "item"],
              $return: {
                $fn: "add",
                $args: [
                  { $var: "acc" },
                  { $fn: "mul", $args: [{ $var: "item" }, { $var: "item" }] },
                ],
              },
            },
            0,
            [1, 2, 3, 4],
          ],
        },
      }),
    ).toBe(30);
  });
});

describe("chained higher-order operations", () => {
  test("filter evens then double them", () => {
    expect(
      run(
        {
          evens: { $fn: "filter", $args: [{ $fn: "isEven" }, [1, 2, 3, 4, 5, 6]] },
          $return: { $fn: "map", $args: [{ $fn: "double" }, { $var: "evens" }] },
        },
        [],
        { double, isEven },
      ),
    ).toEqual([4, 8, 12]);
  });

  test("square all then sum", () => {
    expect(
      run({
        squares: {
          $fn: "map",
          $args: [
            { $params: ["x"], $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "x" }] } },
            [1, 2, 3],
          ],
        },
        $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, { $var: "squares" }] },
      }),
    ).toBe(14);
  });

  test("full pipeline: filter → map → reduce", () => {
    expect(
      run(
        {
          nums: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          evens: { $fn: "filter", $args: [{ $fn: "isEven" }, { $var: "nums" }] },
          doubled: { $fn: "map", $args: [{ $fn: "double" }, { $var: "evens" }] },
          $return: { $fn: "reduce", $args: [{ $fn: "add" }, 0, { $var: "doubled" }] },
        },
        [],
        { double, isEven },
      ),
    ).toBe(60);
  });
});
