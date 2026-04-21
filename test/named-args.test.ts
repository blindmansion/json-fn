import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType, type FunctionRegistry } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: FunctionRegistry = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("named args (object $args)", () => {
  test("basic named args on a JSON function", () => {
    const fns: FunctionRegistry = {
      greet: {
        $params: ["greeting", "name"],
        $return: { $fn: "strcat", $args: [{ $var: "greeting" }, { $var: "name" }] },
      },
    };
    expect(
      run({ $return: { $fn: "greet", $args: { greeting: "Hello, ", name: "world" } } }, [], fns),
    ).toBe("Hello, world");
  });

  test("named args produce correct positional order", () => {
    const fns: FunctionRegistry = {
      subtract: {
        $params: ["a", "b"],
        $return: { $fn: "sub", $args: [{ $var: "a" }, { $var: "b" }] },
      },
    };
    expect(run({ $return: { $fn: "subtract", $args: { b: 3, a: 10 } } }, [], fns)).toBe(7);
  });

  test("missing named arg defaults to null", () => {
    const fns: FunctionRegistry = {
      maybeAdd: {
        $params: ["a", "b"],
        $return: { $fn: "isNull", $args: [{ $var: "b" }] },
      },
    };
    expect(run({ $return: { $fn: "maybeAdd", $args: { a: 5 } } }, [], fns)).toBe(true);
  });

  test("named args on inline function body", () => {
    expect(
      run({
        $return: {
          $fn: {
            $params: ["x", "y"],
            $return: { $fn: "mul", $args: [{ $var: "x" }, { $var: "y" }] },
          },
          $args: { y: 7, x: 3 },
        },
      }),
    ).toBe(21);
  });

  test("named args with expressions as values", () => {
    const fns: FunctionRegistry = {
      addThree: {
        $params: ["a", "b", "c"],
        $return: {
          $fn: "add",
          $args: [{ $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] }, { $var: "c" }],
        },
      },
    };
    expect(
      run(
        {
          $return: {
            $fn: "addThree",
            $args: {
              a: { $fn: "add", $args: [1, 2] },
              b: 10,
              c: 100,
            },
          },
        },
        [],
        fns,
      ),
    ).toBe(113);
  });

  test("positional args still work", () => {
    const fns: FunctionRegistry = {
      myAdd: {
        $params: ["a", "b"],
        $return: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
      },
    };
    expect(run({ $return: { $fn: "myAdd", $args: [3, 4] } }, [], fns)).toBe(7);
  });
});

describe("named args error cases", () => {
  test("errors on unknown named arg", () => {
    const fns: FunctionRegistry = {
      myAdd: {
        $params: ["a", "b"],
        $return: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
      },
    };
    expect(() => run({ $return: { $fn: "myAdd", $args: { a: 1, c: 2 } } }, [], fns)).toThrow(
      /Unknown named argument "c"/,
    );
  });

  test("errors on named args for external functions", () => {
    expect(() => run({ $return: { $fn: "add", $args: { a: 1, b: 2 } } })).toThrow(
      /Named arguments are not supported for external functions/,
    );
  });

  test("errors on named args for functions without $params", () => {
    const fns: FunctionRegistry = {
      noParams: { $return: 42 },
    };
    expect(() => run({ $return: { $fn: "noParams", $args: { a: 1 } } }, [], fns)).toThrow(
      /Named arguments require the target function to declare \$params/,
    );
  });

  test("errors on named args for functions with rest params", () => {
    const fns: FunctionRegistry = {
      restFn: {
        $params: ["a", "...rest"],
        $return: { $var: "a" },
      },
    };
    expect(() => run({ $return: { $fn: "restFn", $args: { a: 1 } } }, [], fns)).toThrow(
      /Named arguments are not supported for functions with rest parameters/,
    );
  });
});
