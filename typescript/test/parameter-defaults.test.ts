import { describe, expect, test } from "bun:test";
import {
  callFunction,
  callProgram,
  createPerfStats,
  createStdlib,
  getArity,
  prepareProgram,
} from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType } from "../src";

const stdlib = createStdlib();
type JSONFunction = Exclude<FunctionDeclaration, string>;

function defaulted(name: string, expression: JSONType): JSONType {
  return { $param: name, $default: expression };
}

function fn(params: JSONType[], returnExpression: JSONType): JSONFunction {
  return { $params: params, $return: returnExpression };
}

describe("positional parameter defaults", () => {
  test("preserves required parameters and evaluates missing defaults", () => {
    expect(callFunction(fn(["required"], { $var: "required" }), [], stdlib)).toBeNull();
    expect(callFunction(fn([defaulted("value", 7)], { $var: "value" }), [], stdlib)).toBe(7);
  });

  test("evaluates computed defaults with builtins", () => {
    const body = fn([defaulted("value", { $call: "add", $args: [2, 3] })], { $var: "value" });
    expect(callFunction(body, [], stdlib)).toBe(5);
  });

  test("every supplied JSON value suppresses the default", () => {
    const body = fn([defaulted("value", "fallback")], { $var: "value" });
    for (const value of [null, false, 0, "", [], {}] satisfies JSONType[]) {
      expect(callFunction(body, [value], stdlib)).toEqual(value);
    }
  });

  test("supports an explicit null default", () => {
    expect(callFunction(fn([defaulted("value", null)], { $var: "value" }), [], stdlib)).toBeNull();
  });

  test("does not evaluate an unused default", () => {
    const body = {
      $params: [defaulted("unused", { $var: "doesNotExist" })],
      $return: "ok",
    } as FunctionDeclaration;
    expect(callFunction(body, [], stdlib)).toBe("ok");
  });

  test("memoizes a forced default once per call", () => {
    let calls = 0;
    const functions: FunctionRegistry = {
      ...stdlib,
      tick: () => {
        calls++;
        return 3;
      },
    };
    const body = fn([defaulted("value", { $call: "tick", $args: [] })], {
      $call: "add",
      $args: [{ $var: "value" }, { $var: "value" }],
    });

    expect(callFunction(body, [], functions)).toBe(6);
    expect(calls).toBe(1);
  });

  test("supports forward references between defaults", () => {
    const body = fn([defaulted("first", { $var: "second" }), defaulted("second", 2)], {
      $var: "first",
    });
    expect(callFunction(body, [], stdlib)).toBe(2);
  });

  test("defaults can reference body locals and local functions", () => {
    const fromLocal = {
      $params: [defaulted("value", { $var: "fallback" })],
      fallback: { $call: "add", $args: [3, 4] },
      $return: { $var: "value" },
    } as FunctionDeclaration;
    const fromFunction = {
      $params: [defaulted("value", { $call: "fallback", $args: [] })],
      fallback: { $return: 9 },
      $return: { $var: "value" },
    } as FunctionDeclaration;

    expect(callFunction(fromLocal, [], stdlib)).toBe(7);
    expect(callFunction(fromFunction, [], stdlib)).toBe(9);
  });

  test("reports cycles spanning defaults and locals", () => {
    const defaultsCycle = fn([defaulted("a", { $var: "b" }), defaulted("b", { $var: "a" })], {
      $var: "a",
    });
    const localCycle = {
      $params: [defaulted("a", { $var: "b" })],
      b: { $var: "a" },
      $return: { $var: "a" },
    } as FunctionDeclaration;

    expect(() => callFunction(defaultsCycle, [], stdlib)).toThrow(
      "Circular variable dependency detected: a -> b -> a",
    );
    expect(() => callFunction(localCycle, [], stdlib)).toThrow(
      "Circular variable dependency detected: a -> b -> a",
    );
  });

  test("keeps rest collection and ignored extra arguments unchanged", () => {
    const withRest = fn([defaulted("head", null), "...tail"], {
      head: { $var: "head" },
      tail: { $var: "tail" },
    });
    expect(callFunction(withRest, [], stdlib)).toEqual({ head: null, tail: [] });
    expect(callFunction(withRest, [1, 2, 3], stdlib)).toEqual({ head: 1, tail: [2, 3] });
    expect(callFunction(fn([defaulted("head", 0)], { $var: "head" }), [1, 2], stdlib)).toBe(1);
  });

  test("counts a descriptor as one fixed arity slot", () => {
    expect(getArity(fn([defaulted("value", 1), "required"], null))).toBe(2);
    expect(getArity(fn([defaulted("value", 1), "...rest"], null))).toBe(1);
  });
});

describe("defaults in escaping closures", () => {
  test("captures outer values referenced only by a default", () => {
    const outer = {
      fallback: 7,
      $return: fn([defaulted("value", { $var: "fallback" })], { $var: "value" }),
    } as FunctionDeclaration;
    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, [], stdlib)).toBe(7);
  });

  test("current parameters mask same-named outer bindings inside defaults", () => {
    const outer = {
      value: 99,
      $return: fn([defaulted("value", 1), defaulted("copy", { $var: "value" })], { $var: "copy" }),
    } as FunctionDeclaration;
    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, [], stdlib)).toBe(1);
  });

  test("attaches an enclosing local function referenced only by a default", () => {
    const outer = {
      fallback: { $return: 11 },
      $return: fn([defaulted("value", { $call: "fallback", $args: [] })], { $var: "value" }),
    } as FunctionDeclaration;
    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, [], stdlib)).toBe(11);
  });
});

describe("positional default validation", () => {
  test("rejects invalid descriptors, duplicates, and rest forms", () => {
    const invalidParams: JSONType[][] = [
      [{ $param: "x" }],
      [{ $param: "x", $default: 1, extra: true }],
      [{ $param: "...xs", $default: [] }],
      ["...xs", "later"],
      ["x", { $param: "x", $default: 1 }],
      [{ $fields: ["x"] }, { $param: "x", $default: 1 }],
    ];

    for (const params of invalidParams) {
      expect(() => callFunction(fn(params, null), [], stdlib)).toThrow("Invalid JSON expression");
    }
  });

  test("uses the same validation through registry, program, and prepared calls", () => {
    const invalid = fn([{ $param: "x" }], null);
    const registry: FunctionRegistry = { ...stdlib, invalid };
    const module: Record<string, JSONType> = { invalid: invalid as JSONType };

    expect(() => callFunction("invalid", [], registry)).toThrow("Invalid JSON expression");
    expect(() => callProgram(module, "invalid", [], stdlib)).toThrow("Invalid JSON expression");
    expect(() => prepareProgram(module, stdlib).invokeEntry("invalid", [])).toThrow(
      "Invalid JSON expression",
    );
  });

  test("charges fuel only when a default is forced", () => {
    const expression = { $call: "add", $args: [1, 2] };
    const unusedUsage = { fuel: 0 };
    const forcedUsage = { fuel: 0 };
    const unusedStats = createPerfStats();
    const forcedStats = createPerfStats();
    const unused = fn([defaulted("value", expression)], "ok");
    const forced = fn([defaulted("value", expression)], { $var: "value" });

    expect(callFunction(unused, [], stdlib, { usage: unusedUsage, perf: unusedStats })).toBe("ok");
    expect(callFunction(forced, [], stdlib, { usage: forcedUsage, perf: forcedStats })).toBe(3);
    expect(forcedUsage.fuel).toBeGreaterThan(unusedUsage.fuel);
    expect(forcedStats.evaluateExpression).toBeGreaterThan(unusedStats.evaluateExpression);
  });
});
