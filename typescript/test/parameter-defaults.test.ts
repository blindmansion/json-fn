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
type Param = NonNullable<JSONFunction["$params"]>[number];
type FieldBinding = Extract<Param, { $fields: unknown }>["$fields"][number];

function defaulted(name: string, expression: JSONType): Param {
  return { $param: name, $default: expression };
}

function defaultedField(name: string, expression: JSONType): FieldBinding {
  return { $field: name, $default: expression };
}

function fn(params: Param[], returnExpression: JSONType): JSONFunction {
  return { $params: params, $return: returnExpression };
}

function malformedFn(params: JSONType[], returnExpression: JSONType): JSONFunction {
  return { $params: params, $return: returnExpression } as unknown as JSONFunction;
}

describe("positional parameter defaults", () => {
  test("rejects omitted required parameters and evaluates missing defaults", () => {
    expect(() => callFunction(fn(["required"], { $var: "required" }), [], stdlib)).toThrow(
      "Missing required argument at parameter position 1",
    );
    expect(callFunction(fn([defaulted("value", 7)], { $var: "value" }), [], stdlib)).toBe(7);
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

  test("keeps rest collection and rejects extra arguments without rest", () => {
    const withRest = fn([defaulted("head", null), "...tail"], {
      head: { $var: "head" },
      tail: { $var: "tail" },
    });
    expect(callFunction(withRest, [], stdlib)).toEqual({ head: null, tail: [] });
    expect(callFunction(withRest, [1, 2, 3], stdlib)).toEqual({ head: 1, tail: [2, 3] });
    expect(() =>
      callFunction(fn([defaulted("head", 0)], { $var: "head" }), [1, 2], stdlib),
    ).toThrow("Expected 0 to 1 arguments, received 2");
  });

  test("direct arity introspection rejects malformed parameters", () => {
    const malformed = malformedFn([{ $param: "value" }], null);

    expect(() => getArity(malformed)).toThrow("Invalid JSON expression");
    expect(() => getArity(malformed)).toThrow(
      "$params[0]: A defaulted parameter must contain exactly",
    );
  });
});

describe("destructured field defaults", () => {
  test("uses defaults for absent own properties", () => {
    const body = fn([{ $fields: ["name", defaultedField("punct", "!")] }], {
      name: { $var: "name" },
      punct: { $var: "punct" },
    });

    expect(callFunction(body, [{ name: "Ada" }], stdlib)).toEqual({
      name: "Ada",
      punct: "!",
    });
  });

  test("explicit null suppresses a field default", () => {
    const body = fn([{ $fields: [defaultedField("value", 5)] }], { $var: "value" });
    expect(callFunction(body, [{ value: null }], stdlib)).toBeNull();
  });

  test("rejects an omitted object argument even when fields have defaults", () => {
    const body = fn(
      [{ $fields: ["required", defaultedField("withDefault", 5)] }],
      [{ $var: "required" }, { $var: "withDefault" }],
    );
    expect(() => callFunction(body, [], stdlib)).toThrow(
      "Missing object-pattern argument at parameter position 1",
    );
  });

  test("treats inherited properties as absent", () => {
    const body = fn([{ $fields: [defaultedField("value", 5)] }], { $var: "value" });
    const argument = Object.create({ value: 99 }) as JSONType;
    expect(callFunction(body, [argument], stdlib)).toBe(5);
  });

  test("rejects an inherited required property", () => {
    const body = fn([{ $fields: ["value"] }], { $var: "value" });
    const argument = Object.create({ value: 99 }) as JSONType;
    expect(() => callFunction(body, [argument], stdlib)).toThrow('Missing required field "value"');
  });
});

describe("defaults in escaping closures", () => {
  test("attaches an enclosing local function referenced only by a default", () => {
    const outer = {
      $return: {
        $let: { fallback: { $return: 11 } },
        $in: fn([defaulted("value", { $call: "fallback", $args: [] })], { $var: "value" }),
      },
    } as FunctionDeclaration;
    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, [], stdlib)).toBe(11);
    expect(callFunction(JSON.parse(JSON.stringify(inner)), [], stdlib)).toBe(11);
  });
});

describe("positional default validation", () => {
  const orderingError = "Required positional parameters must precede defaulted parameters";

  test("accepts required slots before defaults and a final rest parameter", () => {
    expect(
      callFunction(
        fn(
          ["first", "second", defaulted("third", 3), defaulted("fourth", 4)],
          [{ $var: "first" }, { $var: "second" }, { $var: "third" }, { $var: "fourth" }],
        ),
        [1, 2],
        stdlib,
      ),
    ).toEqual([1, 2, 3, 4]);

    expect(
      callFunction(
        fn(["required", defaulted("fallback", 2), "...rest"], {
          fallback: { $var: "fallback" },
          rest: { $var: "rest" },
        }),
        [1],
        stdlib,
      ),
    ).toEqual({ fallback: 2, rest: [] });
    expect(
      callFunction(fn([defaulted("fallback", 2), "...rest"], { $var: "rest" }), [1, 2], stdlib),
    ).toEqual([2]);
  });

  test("rejects required named parameters after positional defaults", () => {
    expect(() =>
      callFunction(fn([defaulted("fallback", 1), "required"], null), [1, 2], stdlib),
    ).toThrow(`${orderingError}; named parameter "required" at position 2 is required`);
    expect(() =>
      callFunction(
        fn([defaulted("first", 1), defaulted("second", 2), "required"], null),
        [1, 2, 3],
        stdlib,
      ),
    ).toThrow(`${orderingError}; named parameter "required" at position 3 is required`);
  });

  test("treats object patterns as required positional slots", () => {
    const requiredPattern = { $fields: ["value"] };
    const allDefaultedPattern = { $fields: [defaultedField("value", 2)] };

    expect(() =>
      callFunction(
        fn([defaulted("fallback", 1), requiredPattern], null),
        [1, { value: 2 }],
        stdlib,
      ),
    ).toThrow(`${orderingError}; object pattern at position 2 is required`);
    expect(() =>
      callFunction(
        fn([defaulted("fallback", 1), allDefaultedPattern, "later"], null),
        [1, {}, 3],
        stdlib,
      ),
    ).toThrow(`${orderingError}; object pattern at position 2 is required`);

    expect(
      callFunction(
        fn([allDefaultedPattern, defaulted("fallback", 3)], {
          value: { $var: "value" },
          fallback: { $var: "fallback" },
        }),
        [{}],
        stdlib,
      ),
    ).toEqual({ value: 2, fallback: 3 });
  });

  test("uses the same validation through registry, program, and prepared calls", () => {
    const invalid = malformedFn([{ $param: "x" }], null);
    const registry: FunctionRegistry = { ...stdlib, invalid };
    const module: Record<string, JSONType> = { invalid: invalid as JSONType };

    expect(() => callFunction("invalid", [], registry)).toThrow("Invalid JSON expression");
    expect(() => callProgram(module, "invalid", [], stdlib)).toThrow("Invalid JSON expression");
    expect(() => prepareProgram(module, stdlib).invokeEntry("invalid", [])).toThrow(
      "Invalid JSON expression",
    );
  });

  test("enforces trailing omission through every call entry path", () => {
    const invalid = fn([defaulted("fallback", 1), "required"], null);
    const registry: FunctionRegistry = { ...stdlib, invalid };
    const module: Record<string, JSONType> = { invalid: invalid as JSONType };
    const inline = fn([], { $call: invalid as JSONType, $args: [1, 2] });

    expect(() => callFunction(invalid, [1, 2], stdlib)).toThrow(orderingError);
    expect(() => callFunction("invalid", [1, 2], registry)).toThrow(orderingError);
    expect(() => callProgram(module, "invalid", [1, 2], stdlib)).toThrow(orderingError);
    expect(() => prepareProgram(module, stdlib).invokeEntry("invalid", [1, 2])).toThrow(
      orderingError,
    );
    expect(() => callFunction(inline, [], stdlib)).toThrow(orderingError);
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

  test("checks interruption while evaluating a forced default", () => {
    const controller = new AbortController();
    const functions: FunctionRegistry = {
      ...stdlib,
      abort: () => {
        controller.abort();
        return 0;
      },
    };
    const body = fn(
      [
        defaulted("value", {
          $call: "add",
          $args: [{ $call: "abort", $args: [] }, 1],
        }),
      ],
      { $var: "value" },
    );

    expect(() => callFunction(body, [], functions, { signal: controller.signal })).toThrow(
      "Execution aborted",
    );
  });
});
