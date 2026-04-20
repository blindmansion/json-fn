import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("$if/$then/$else conditionals", () => {
  test("truthy condition returns $then", () => {
    expect(
      run({
        $return: {
          $if: { $fn: "gt", $args: [10, 5] },
          $then: "ten is greater",
          $else: "five is greater",
        },
      }),
    ).toBe("ten is greater");
  });

  test("falsy condition returns $else", () => {
    expect(
      run({
        $return: {
          $if: { $fn: "gt", $args: [3, 5] },
          $then: "three is greater",
          $else: "five is greater",
        },
      }),
    ).toBe("five is greater");
  });
});

describe("$cond multi-branch conditionals", () => {
  const classify = {
    $params: ["n"],
    $return: {
      $cond: [
        [{ $fn: "lt", $args: [{ $var: "n" }, 0] }, "negative"],
        [{ $fn: "eq", $args: [{ $var: "n" }, 0] }, "zero"],
        [true, "positive"],
      ],
    },
  };

  test("classify negative", () => {
    expect(run({ $return: { $fn: "classify", $args: [-5] } }, [], { classify })).toBe("negative");
  });

  test("classify zero", () => {
    expect(run({ $return: { $fn: "classify", $args: [0] } }, [], { classify })).toBe("zero");
  });

  test("classify positive", () => {
    expect(run({ $return: { $fn: "classify", $args: [42] } }, [], { classify })).toBe("positive");
  });

  const fizzbuzz = {
    $params: ["n"],
    divBy3: { $fn: "eq", $args: [{ $fn: "mod", $args: [{ $var: "n" }, 3] }, 0] },
    divBy5: { $fn: "eq", $args: [{ $fn: "mod", $args: [{ $var: "n" }, 5] }, 0] },
    divBy15: { $fn: "and", $args: [{ $var: "divBy3" }, { $var: "divBy5" }] },
    $return: {
      $cond: [
        [{ $var: "divBy15" }, "FizzBuzz"],
        [{ $var: "divBy3" }, "Fizz"],
        [{ $var: "divBy5" }, "Buzz"],
        [true, { $var: "n" }],
      ],
    },
  };

  test("fizzbuzz(15) → FizzBuzz", () => {
    expect(run({ $return: { $fn: "fizzbuzz", $args: [15] } }, [], { fizzbuzz })).toBe("FizzBuzz");
  });

  test("fizzbuzz(9) → Fizz", () => {
    expect(run({ $return: { $fn: "fizzbuzz", $args: [9] } }, [], { fizzbuzz })).toBe("Fizz");
  });

  test("fizzbuzz(10) → Buzz", () => {
    expect(run({ $return: { $fn: "fizzbuzz", $args: [10] } }, [], { fizzbuzz })).toBe("Buzz");
  });

  test("fizzbuzz(7) → 7 (number passthrough)", () => {
    expect(run({ $return: { $fn: "fizzbuzz", $args: [7] } }, [], { fizzbuzz })).toBe(7);
  });

  test("inline letter grade", () => {
    expect(
      run(
        {
          $params: ["score"],
          $return: {
            $cond: [
              [{ $fn: "gte", $args: [{ $var: "score" }, 90] }, "A"],
              [{ $fn: "gte", $args: [{ $var: "score" }, 80] }, "B"],
              [{ $fn: "gte", $args: [{ $var: "score" }, 70] }, "C"],
              [{ $fn: "gte", $args: [{ $var: "score" }, 60] }, "D"],
              [true, "F"],
            ],
          },
        },
        [85],
      ),
    ).toBe("B");
  });

  test("short-circuits: only first matching branch evaluates", () => {
    expect(
      run({
        $return: {
          $cond: [
            [false, { $fn: "add", $args: [1, 2] }],
            [true, "matched second"],
            [true, "never reached"],
          ],
        },
      }),
    ).toBe("matched second");
  });

  test("single pair works as a guard", () => {
    expect(
      run({
        $return: {
          $cond: [[true, "always this"]],
        },
      }),
    ).toBe("always this");
  });
});
