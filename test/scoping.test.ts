import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  const functions = { ...createStdlib(), ...extraFns };
  return callFunction(body as any, args, functions);
}

describe("replaceVars respects scope boundaries", () => {
  test("inner variable shadows outer variable of the same name", () => {
    const result = run(
      {
        x: { $arg: 0 },
        $return: {
          $fn: {
            x: 999,
            $return: { $var: "x" },
          },
          $args: [],
        },
      },
      [10],
    );

    expect(result).toBe(999);
  });

  test("inner variable shadows outer in a nested function call", () => {
    const result = run(
      {
        x: { $arg: 0 },
        $return: {
          $fn: {
            x: { $arg: 0 },
            $return: { $fn: "add", $args: [{ $var: "x" }, 1] },
          },
          $args: [50],
        },
      },
      [10],
    );

    expect(result).toBe(51);
  });

  test("outer variable is still captured when not shadowed", () => {
    const result = run(
      {
        x: { $arg: 0 },
        $return: {
          $fn: {
            y: { $arg: 0 },
            $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "y" }] },
          },
          $args: [5],
        },
      },
      [10],
    );

    expect(result).toBe(15);
  });

  test("returned closure captures outer but preserves inner scope", () => {
    const makeAdder = {
      x: { $arg: 0 },
      $return: {
        x: { $arg: 0 },
        $return: { $fn: "add", $args: [{ $var: "x" }, 1000] },
      },
    };

    const closure = run({ $return: { $fn: "makeAdder", $args: [10] } }, [], {
      makeAdder,
    });

    expect(closure).toEqual({
      x: { $arg: 0 },
      $return: { $fn: "add", $args: [{ $var: "x" }, 1000] },
    });

    const result = run(
      {
        adder: { $fn: "makeAdder", $args: [10] },
        $return: { $fn: { $var: "adder" }, $args: [42] },
      },
      [],
      { makeAdder },
    );

    expect(result).toBe(1042);
  });

  test("multiple levels of shadowing", () => {
    const result = run({
      x: 1,
      $return: {
        $fn: {
          x: 2,
          $return: {
            $fn: {
              x: 3,
              $return: { $var: "x" },
            },
            $args: [],
          },
        },
        $args: [],
      },
    });

    expect(result).toBe(3);
  });

  test("shadowed name in closure is not prematurely substituted", () => {
    const outer = {
      n: { $arg: 0 },
      $return: {
        n: { $fn: "mul", $args: [{ $arg: 0 }, 10] },
        $return: { $var: "n" },
      },
    };

    const closure = run({ $return: { $fn: "outer", $args: [5] } }, [], { outer });

    expect(closure).toEqual({
      n: { $fn: "mul", $args: [{ $arg: 0 }, 10] },
      $return: { $var: "n" },
    });

    const result = run(
      {
        $return: { $fn: { $fn: "outer", $args: [5] }, $args: [7] },
      },
      [],
      { outer },
    );

    expect(result).toBe(70);
  });

  test("non-shadowed outer vars are baked into closure", () => {
    const outer = {
      a: { $arg: 0 },
      b: { $arg: 1 },
      $return: {
        c: { $arg: 0 },
        $return: {
          $fn: "add",
          $args: [{ $var: "a" }, { $fn: "add", $args: [{ $var: "b" }, { $var: "c" }] }],
        },
      },
    };

    const closure = run({ $return: { $fn: "outer", $args: [10, 20] } }, [], { outer });

    expect(closure).toEqual({
      c: { $arg: 0 },
      $return: { $fn: "add", $args: [10, { $fn: "add", $args: [20, { $var: "c" }] }] },
    });
  });

  test("partial shadowing — only the colliding name is masked", () => {
    const result = run({
      x: 100,
      y: 200,
      $return: {
        $fn: {
          x: { $arg: 0 },
          $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "y" }] },
        },
        $args: [1],
      },
    });

    expect(result).toBe(201);
  });
});
