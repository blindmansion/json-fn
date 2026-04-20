import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("JSON-defined named functions", () => {
  const double = {
    $return: { $fn: "mul", $args: [{ $arg: 0 }, 2] },
  };

  const isEven = {
    n: { $arg: 0 },
    remainder: { $fn: "mod", $args: [{ $var: "n" }, 2] },
    $return: { $fn: "eq", $args: [{ $var: "remainder" }, 0] },
  };

  test("double(21)", () => {
    expect(run(
      { $return: { $fn: "double", $args: [21] } },
      [],
      { double },
    )).toBe(42);
  });

  test("isEven(4)", () => {
    expect(run(
      { $return: { $fn: "isEven", $args: [4] } },
      [],
      { isEven },
    )).toBe(true);
  });

  test("isEven(7)", () => {
    expect(run(
      { $return: { $fn: "isEven", $args: [7] } },
      [],
      { isEven },
    )).toBe(false);
  });
});

describe("recursion", () => {
  const fact: any = {
    n: { $arg: 0 },
    $return: {
      $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
      $then: 1,
      $else: {
        $fn: "mul",
        $args: [
          { $var: "n" },
          { $fn: "fact", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] },
        ],
      },
    },
  };

  const fib: any = {
    n: { $arg: 0 },
    $return: {
      $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
      $then: { $var: "n" },
      $else: {
        $fn: "add",
        $args: [
          { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] },
          { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 2] }] },
        ],
      },
    },
  };

  test("fact(0)", () => {
    expect(run({ $return: { $fn: "fact", $args: [0] } }, [], { fact })).toBe(1);
  });

  test("fact(1)", () => {
    expect(run({ $return: { $fn: "fact", $args: [1] } }, [], { fact })).toBe(1);
  });

  test("fact(5)", () => {
    expect(run({ $return: { $fn: "fact", $args: [5] } }, [], { fact })).toBe(120);
  });

  test("fact(10)", () => {
    expect(run({ $return: { $fn: "fact", $args: [10] } }, [], { fact })).toBe(3628800);
  });

  test("fib(0)", () => {
    expect(run({ $return: { $fn: "fib", $args: [0] } }, [], { fib })).toBe(0);
  });

  test("fib(1)", () => {
    expect(run({ $return: { $fn: "fib", $args: [1] } }, [], { fib })).toBe(1);
  });

  test("fib(10)", () => {
    expect(run({ $return: { $fn: "fib", $args: [10] } }, [], { fib })).toBe(55);
  });
});
