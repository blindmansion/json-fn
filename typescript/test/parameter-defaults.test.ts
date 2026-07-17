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

function defaultedField(name: string, expression: JSONType): JSONType {
  return { $field: name, $default: expression };
}

function optional(name: string): JSONType {
  return { $param: name, $optional: true };
}

function optionalField(name: string): JSONType {
  return { $field: name, $optional: true };
}

function fn(params: JSONType[], returnExpression: JSONType): JSONFunction {
  return { $params: params, $return: returnExpression };
}

describe("positional parameter defaults", () => {
  test("rejects omitted required parameters and evaluates missing defaults", () => {
    expect(() => callFunction(fn(["required"], { $var: "required" }), [], stdlib)).toThrow(
      "Missing required argument at parameter position 1",
    );
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

  test("keeps rest collection and rejects extra arguments without rest", () => {
    const withRest = fn([defaulted("head", null), "...tail"], {
      head: { $var: "head" },
      tail: { $var: "tail" },
    });
    expect(callFunction(withRest, [], stdlib)).toEqual({ head: null, tail: [] });
    expect(callFunction(withRest, [1, 2, 3], stdlib)).toEqual({ head: 1, tail: [2, 3] });
    expect(() =>
      callFunction(fn([defaulted("head", 0)], { $var: "head" }), [1, 2], stdlib),
    ).toThrow("Expected exactly 1 argument, received 2");
  });

  test("counts a descriptor as one fixed arity slot", () => {
    expect(getArity(fn(["required", defaulted("value", 1)], null))).toBe(2);
    expect(getArity(fn([defaulted("value", 1), "...rest"], null))).toBe(1);
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

  test("rejects supplied non-objects", () => {
    const body = fn(
      [{ $fields: ["required", defaultedField("withDefault", { $var: "doesNotExist" })] }],
      [{ $var: "required" }, { $var: "withDefault" }],
    );

    for (const value of [null, 0, "text", false, []] satisfies JSONType[]) {
      expect(() => callFunction(body, [value], stdlib)).toThrow(
        "expected a plain object, received",
      );
    }
  });

  test("field defaults can depend on positional parameters and other fields", () => {
    const body = fn(
      [
        "base",
        {
          $fields: [
            defaultedField("first", { $var: "base" }),
            defaultedField("second", 2),
            defaultedField("total", {
              $call: "add",
              $args: [{ $var: "first" }, { $var: "second" }],
            }),
          ],
        },
      ],
      { $var: "total" },
    );

    expect(callFunction(body, [3, {}], stdlib)).toBe(5);
    expect(callFunction(body, [3, { second: 4 }], stdlib)).toBe(7);
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

  test("captures local functions referenced only by a field default", () => {
    const outer = {
      fallback: { $return: 13 },
      $return: fn([{ $fields: [defaultedField("value", { $call: "fallback", $args: [] })] }], {
        $var: "value",
      }),
    } as FunctionDeclaration;
    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, [{}], stdlib)).toBe(13);
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

  test("every parameter kind shadows same-named outer bindings", () => {
    const outer = {
      required: "outer",
      fieldRequired: "outer",
      fieldOptional: "outer",
      fieldDefaulted: "outer",
      optional: "outer",
      defaulted: "outer",
      rest: "outer",
      $return: fn(
        [
          "required",
          {
            $fields: [
              "fieldRequired",
              optionalField("fieldOptional"),
              defaultedField("fieldDefaulted", "field default"),
            ],
          },
          optional("optional"),
          defaulted("defaulted", "parameter default"),
          "...rest",
        ],
        {
          required: { $var: "required" },
          fieldRequired: { $var: "fieldRequired" },
          fieldOptional: { $var: "fieldOptional" },
          fieldDefaulted: { $var: "fieldDefaulted" },
          optional: { $var: "optional" },
          defaulted: { $var: "defaulted" },
          rest: { $var: "rest" },
        },
      ),
    } as FunctionDeclaration;

    const inner = callFunction(outer, [], stdlib) as FunctionDeclaration;
    expect(callFunction(inner, ["required", { fieldRequired: "field" }], stdlib)).toEqual({
      required: "required",
      fieldRequired: "field",
      fieldOptional: null,
      fieldDefaulted: "field default",
      optional: null,
      defaulted: "parameter default",
      rest: [],
    });
  });

  test("rejects malformed nested parameters while creating a closure", () => {
    const outer = {
      $return: fn([{ $param: "value" }], null),
    } as FunctionDeclaration;

    expect(() => callFunction(outer, [], stdlib)).toThrow(
      "$params[0]: A defaulted parameter must contain exactly",
    );
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

  test("allows required and defaulted fields in either order", () => {
    for (const fields of [
      ["required", defaultedField("fallback", 2)],
      [defaultedField("fallback", 2), "required"],
    ]) {
      expect(
        callFunction(
          fn(
            [{ $fields: fields }, defaulted("suffix", 3)],
            [{ $var: "required" }, { $var: "fallback" }, { $var: "suffix" }],
          ),
          [{ required: 1 }],
          stdlib,
        ),
      ).toEqual([1, 2, 3]);
    }
  });

  test("rejects invalid descriptors, duplicates, and rest forms", () => {
    const invalidParams: JSONType[][] = [
      [{ $param: "x" }],
      [{ $param: "x", $default: 1, extra: true }],
      [{ $param: "...xs", $default: [] }],
      ["...xs", "later"],
      ["x", { $param: "x", $default: 1 }],
      [{ $fields: ["x"] }, { $param: "x", $default: 1 }],
      [{ $fields: [{ $field: "x" }] }],
      [{ $fields: [{ $field: "x", $default: 1, extra: true }] }],
      [{ $fields: [{ $param: "x", $default: 1 }] }],
      [{ $fields: ["x", { $field: "x", $default: 1 }] }],
    ];

    for (const params of invalidParams) {
      expect(() => callFunction(fn(params, null), [], stdlib)).toThrow("Invalid JSON expression");
    }
  });

  test("preserves specific validation errors after a defaulted slot", () => {
    expect(() =>
      callFunction(fn([defaulted("first", 1), { $param: "second" }], null), [], stdlib),
    ).toThrow("A defaulted parameter must contain exactly");
    expect(() => callFunction(fn([defaulted("same", 1), "same"], null), [1, 2], stdlib)).toThrow(
      'Duplicate parameter binding "same"',
    );
    expect(() =>
      callFunction(fn([defaulted("first", 1), "...rest", "later"], null), [], stdlib),
    ).toThrow("A rest parameter must have a name and be the final $params entry");
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
