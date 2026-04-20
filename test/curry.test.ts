import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib, type JSONType } from "../src";

function run(body: JSONType, args: JSONType[] = [], extraFns: Record<string, any> = {}): JSONType {
  return callFunction(body as any, args, { ...createStdlib(), ...extraFns });
}

describe("returning function bodies as values (closures)", () => {
  test("makeAdder(10) returns a closure with x captured", () => {
    const result = run(
      {
        $params: ["x"],
        $return: {
          $params: ["y"],
          $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "y" }] },
        },
      },
      [10],
    );

    expect(result).toEqual({
      $params: ["y"],
      $return: { $fn: "add", $args: [10, { $var: "y" }] },
    });
  });
});

describe("calling returned function bodies", () => {
  test("makeAdder(10)(5) via nested inline call", () => {
    const result = run({
      adder: {
        $fn: {
          $params: ["x"],
          $return: {
            $params: ["y"],
            $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "y" }] },
          },
        },
        $args: [10],
      },
      $return: {
        $fn: { $var: "adder" },
        $args: [5],
      },
    });

    expect(result).toBe(15);
  });
});

describe("variadic arguments with ...rest params", () => {
  test("capture all args", () => {
    expect(
      run(
        {
          $params: ["...allArgs"],
          $return: { $var: "allArgs" },
        },
        [10, 20, 30],
      ),
    ).toEqual([10, 20, 30]);
  });
});

describe("dynamic function dispatch", () => {
  test("call a function by name from args (add)", () => {
    expect(
      run(
        {
          $params: ["fnName"],
          $return: {
            $fn: { $var: "fnName" },
            $args: [3, 4],
          },
        },
        ["add"],
      ),
    ).toBe(7);
  });

  test("call a function by name from args (mul)", () => {
    expect(
      run(
        {
          $params: ["fnName"],
          $return: {
            $fn: { $var: "fnName" },
            $args: [3, 4],
          },
        },
        ["mul"],
      ),
    ).toBe(12);
  });
});

describe("closure capture", () => {
  const partialAdd = {
    $params: ["a"],
    $return: {
      $params: ["b"],
      $return: { $fn: "add", $args: [{ $var: "a" }, { $var: "b" }] },
    },
  };

  test("partialAdd(10) returns a function", () => {
    const result = run({ $return: { $fn: "partialAdd", $args: [10] } }, [], { partialAdd });

    expect(result).toEqual({
      $params: ["b"],
      $return: { $fn: "add", $args: [10, { $var: "b" }] },
    });
  });

  test("partialAdd(10)(7) = 17", () => {
    expect(
      run(
        {
          partial: { $fn: "partialAdd", $args: [10] },
          $return: {
            $fn: { $var: "partial" },
            $args: [7],
          },
        },
        [],
        { partialAdd },
      ),
    ).toBe(17);
  });
});

describe("accumulating arguments across calls", () => {
  const accum = {
    $params: ["...initial"],
    $return: {
      $params: ["...more"],
      $return: {
        $fn: "concat",
        $args: [{ $var: "initial" }, { $var: "more" }],
      },
    },
  };

  test("accum(1,2)(3,4) concatenates args", () => {
    expect(
      run(
        {
          step1: { $fn: "accum", $args: [1, 2] },
          $return: {
            $fn: { $var: "step1" },
            $args: [3, 4],
          },
        },
        [],
        { accum },
      ),
    ).toEqual([1, 2, 3, 4]);
  });
});

describe("arity check", () => {
  test("length([1,2,3]) >= 3 is true", () => {
    expect(
      run({
        args: [1, 2, 3],
        numArgs: { $fn: "length", $args: [{ $var: "args" }] },
        enough: { $fn: "gte", $args: [{ $var: "numArgs" }, 3] },
        $return: { $var: "enough" },
      }),
    ).toBe(true);
  });

  test("length([1,2]) >= 3 is false", () => {
    expect(
      run({
        args: [1, 2],
        numArgs: { $fn: "length", $args: [{ $var: "args" }] },
        enough: { $fn: "gte", $args: [{ $var: "numArgs" }, 3] },
        $return: { $var: "enough" },
      }),
    ).toBe(false);
  });
});

describe("manual curry of add", () => {
  const curriedAdd = {
    $params: ["a"],
    $return: {
      $params: ["b"],
      $return: {
        $fn: "add",
        $args: [{ $var: "a" }, { $var: "b" }],
      },
    },
  };

  test("curriedAdd(10)(32) = 42", () => {
    expect(
      run(
        {
          step1: { $fn: "curriedAdd", $args: [10] },
          $return: {
            $fn: { $var: "step1" },
            $args: [32],
          },
        },
        [],
        { curriedAdd },
      ),
    ).toBe(42);
  });
});

describe("generic curry", () => {
  const curryApply: any = {
    $params: ["targetFn", "arity", "accumulated", "newArgs"],
    allArgs: { $fn: "concat", $args: [{ $var: "accumulated" }, { $var: "newArgs" }] },
    numArgs: { $fn: "length", $args: [{ $var: "allArgs" }] },
    enough: { $fn: "gte", $args: [{ $var: "numArgs" }, { $var: "arity" }] },
    $return: {
      $if: { $var: "enough" },
      $then: {
        $fn: { $var: "targetFn" },
        $args: { $var: "allArgs" },
      },
      $else: {
        $params: ["...nextArgs"],
        $return: {
          $fn: "curryApply",
          $args: [{ $var: "targetFn" }, { $var: "arity" }, { $var: "allArgs" }, { $var: "nextArgs" }],
        },
      },
    },
  };

  const curry = {
    $params: ["targetFn", "arity"],
    $return: {
      $params: ["...newArgs"],
      $return: {
        $fn: "curryApply",
        $args: [{ $var: "targetFn" }, { $var: "arity" }, [], { $var: "newArgs" }],
      },
    },
  };

  const fns = { curryApply, curry };

  test("curry('add', 2) returns a function", () => {
    const result = run({ $return: { $fn: "curry", $args: ["add", 2] } }, [], fns);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("$return");
  });

  test("curry('add', 2)(10) returns another function", () => {
    const result = run(
      {
        curriedAdd: { $fn: "curry", $args: ["add", 2] },
        $return: {
          $fn: { $var: "curriedAdd" },
          $args: [10],
        },
      },
      [],
      fns,
    );

    expect(result).toHaveProperty("$return");
  });

  test("curry('add', 2)(10)(32) = 42", () => {
    expect(
      run(
        {
          step1: { $fn: "curry", $args: ["add", 2] },
          step2: {
            $fn: { $var: "step1" },
            $args: [10],
          },
          $return: {
            $fn: { $var: "step2" },
            $args: [32],
          },
        },
        [],
        fns,
      ),
    ).toBe(42);
  });

  test("curry('add', 2)(10, 32) — all args at once", () => {
    expect(
      run(
        {
          curriedAdd: { $fn: "curry", $args: ["add", 2] },
          $return: {
            $fn: { $var: "curriedAdd" },
            $args: [10, 32],
          },
        },
        [],
        fns,
      ),
    ).toBe(42);
  });

  test("curry('add3', 3)(1)(2)(3) = 6", () => {
    const add3 = (a: number, b: number, c: number) => a + b + c;
    expect(
      run(
        {
          step1: { $fn: "curry", $args: ["add3", 3] },
          step2: { $fn: { $var: "step1" }, $args: [1] },
          step3: { $fn: { $var: "step2" }, $args: [2] },
          $return: { $fn: { $var: "step3" }, $args: [3] },
        },
        [],
        { ...fns, add3 },
      ),
    ).toBe(6);
  });

  test("curry('add3', 3)(1, 2)(3) = 6", () => {
    const add3 = (a: number, b: number, c: number) => a + b + c;
    expect(
      run(
        {
          step1: { $fn: "curry", $args: ["add3", 3] },
          step2: { $fn: { $var: "step1" }, $args: [1, 2] },
          $return: { $fn: { $var: "step2" }, $args: [3] },
        },
        [],
        { ...fns, add3 },
      ),
    ).toBe(6);
  });
});
