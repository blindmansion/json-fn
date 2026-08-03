import { describe, expect, test } from "bun:test";
import { callFunction, createPerfStats, createStdlib } from "../src";
import type { FunctionDeclaration, FunctionRegistry, JSONType } from "../src";
import { parseExpression as parse } from "../src/shorthand";

const stdlib = createStdlib();
type FunctionBody = Exclude<FunctionDeclaration, string>;

function evaluate(expression: JSONType, functions: FunctionRegistry = stdlib): JSONType {
  return callFunction({ $return: expression }, [], functions);
}

function letExpression(bindings: Record<string, JSONType>, body: JSONType): JSONType {
  return { $let: bindings, $in: body };
}

describe("$let validation", () => {
  test("does not classify an unused binding expression", () => {
    expect(evaluate(letExpression({ unused: { $let: {} } }, "ok"))).toBe("ok");
  });
});

describe("$let lazy frames", () => {
  test("is lazy and memoizes a forced binding", () => {
    let calls = 0;
    const functions: FunctionRegistry = {
      ...stdlib,
      tick: () => {
        calls++;
        return 4;
      },
    };
    const expression = letExpression(
      {
        unused: { $call: "missing", $args: [] },
        value: { $call: "tick", $args: [] },
      },
      { $call: "add", $args: [{ $var: "value" }, { $var: "value" }] },
    );

    expect(evaluate(expression, functions)).toBe(8);
    expect(calls).toBe(1);
  });

  test("sees parameters and applies lexical shadowing", () => {
    const fn: FunctionBody = {
      $params: ["outer"],
      $return: letExpression(
        { local: "outer local" },
        letExpression({ outer: "let parameter", local: "let local" }, [
          { $var: "outer" },
          { $var: "local" },
        ]),
      ),
    };
    expect(callFunction(fn, ["parameter"], stdlib)).toEqual(["let parameter", "let local"]);
  });

  test("nested lets shadow their parents", () => {
    expect(
      evaluate(
        letExpression({ value: 1 }, [
          { $var: "value" },
          letExpression({ value: 2 }, { $var: "value" }),
          { $var: "value" },
        ]),
      ),
    ).toEqual([1, 2, 1]);
  });

  test("reports direct and indirect value cycles", () => {
    expect(() => evaluate(letExpression({ value: { $var: "value" } }, { $var: "value" }))).toThrow(
      "Circular variable dependency detected: value -> value",
    );
    expect(() =>
      evaluate(
        letExpression({ first: { $var: "second" }, second: { $var: "first" } }, { $var: "first" }),
      ),
    ).toThrow("Circular variable dependency detected: first -> second -> first");
  });
});

describe("$let local functions", () => {
  const decrement = { $call: "sub", $args: [{ $var: "value" }, 1] };
  const even: FunctionBody = {
    $params: ["value"],
    $return: {
      $if: { $call: "eq", $args: [{ $var: "value" }, 0] },
      $then: true,
      $else: { $call: "odd", $args: [decrement] },
    },
  };
  const odd: FunctionBody = {
    $params: ["value"],
    $return: {
      $if: { $call: "eq", $args: [{ $var: "value" }, 0] },
      $then: false,
      $else: { $call: "even", $args: [decrement] },
    },
  };

  test("supports recursion and mutual recursion", () => {
    const recursive: FunctionBody = {
      $params: ["value"],
      $return: {
        $if: { $call: "eq", $args: [{ $var: "value" }, 0] },
        $then: 0,
        $else: { $call: "count", $args: [decrement] },
      },
    };
    expect(evaluate(letExpression({ count: recursive }, { $call: "count", $args: [5] }))).toBe(0);
    expect(
      evaluate(
        letExpression({ even, odd }, [
          { $call: "even", $args: [6] },
          { $call: "odd", $args: [6] },
        ]),
      ),
    ).toEqual([true, false]);
  });

  test("supports $var and $fn access", () => {
    const identity: FunctionBody = {
      $params: ["value"],
      $return: { $var: "value" },
    };
    expect(
      evaluate(
        letExpression({ identity }, [
          { $call: { $var: "identity" }, $args: [1] },
          { $call: { $fn: "identity" }, $args: [2] },
        ]),
      ),
    ).toEqual([1, 2]);
  });

  test("serializes escaping transitive mutually recursive captures without cycles", () => {
    const escaped = evaluate(
      letExpression(
        { even, odd },
        {
          $params: ["value"],
          $return: { $call: "even", $args: [{ $var: "value" }] },
        },
      ),
    ) as FunctionBody;

    expect(Object.keys(escaped.$captures ?? {}).sort()).toEqual(["even", "odd"]);
    expect(Object.prototype.hasOwnProperty.call(escaped, "even")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(escaped, "odd")).toBe(false);
    const serialized = JSON.stringify(escaped);
    const restored = JSON.parse(serialized) as FunctionDeclaration;
    expect(callFunction(restored, [8], stdlib)).toBe(true);
    expect(callFunction(restored, [7], stdlib)).toBe(false);
  });

  test("does not attach an enclosing function shadowed by a parameter", () => {
    const escaped = evaluate(
      letExpression(
        { selected: { $return: "outer" } },
        {
          $params: ["selected"],
          $return: { $call: "selected", $args: [] },
        },
      ),
    ) as FunctionBody;
    const selected: FunctionBody = { $return: "argument" };

    expect(escaped.$captures).toBeUndefined();
    expect(callFunction(escaped, [selected], stdlib)).toBe("argument");
  });

  test("masks an outer same-named function across a nested let", () => {
    const maker = evaluate(
      letExpression(
        { selected: { $return: "outer" } },
        {
          $return: letExpression(
            { selected: { $return: "inner" } },
            { $return: { $call: "selected", $args: [] } },
          ),
        },
      ),
    ) as FunctionBody;
    expect(maker.$captures).toBeUndefined();

    const nested = callFunction(maker, [], stdlib) as FunctionBody;
    expect(Object.keys(nested.$captures ?? {})).toEqual(["selected"]);
    expect(callFunction(JSON.parse(JSON.stringify(nested)), [], stdlib)).toBe("inner");
  });

  test("makes captures available to parameter defaults", () => {
    const escaped = evaluate(
      letExpression(
        { fallback: { $return: 13 } },
        {
          $params: [{ $param: "value", $default: { $call: "fallback", $args: [] } }],
          $return: { $var: "value" },
        },
      ),
    );
    const restored = JSON.parse(JSON.stringify(escaped)) as FunctionDeclaration;
    expect(callFunction(restored, [], stdlib)).toBe(13);
  });

  test("exposes serialized captures in call, $fn, and $var positions", () => {
    const captured: FunctionBody = {
      $params: ["value"],
      $return: { $var: "value" },
    };
    const fn: FunctionBody = {
      $captures: { captured },
      $return: [
        { $call: "captured", $args: [1] },
        { $call: { $fn: "captured" }, $args: [2] },
        { $call: { $var: "captured" }, $args: [3] },
      ],
    };

    expect(callFunction(JSON.parse(JSON.stringify(fn)), [], stdlib)).toEqual([1, 2, 3]);
  });
});

describe("$let execution accounting and registry ownership", () => {
  test("shorthand where uses native lazy $let execution", () => {
    const expression = parse(
      "go(5) where { unused: missing(), go: (n) => if n <= 0 then 0 else go(n - 1) }",
    );
    expect(expression).toHaveProperty("$let");
    expect(evaluate(expression)).toBe(0);
  });

  test("charges one expression node without adding a call frame", () => {
    const plainUsage = { fuel: 0 };
    const letUsage = { fuel: 0 };
    const plainPerf = createPerfStats();
    const letPerf = createPerfStats();

    expect(
      callFunction({ $return: "ok" }, [], stdlib, { usage: plainUsage, perf: plainPerf }),
    ).toBe("ok");
    expect(
      callFunction(
        { $return: letExpression({ unused: { $call: "missing", $args: [] } }, "ok") },
        [],
        stdlib,
        { usage: letUsage, perf: letPerf },
      ),
    ).toBe("ok");

    expect(letUsage.fuel).toBe(plainUsage.fuel + 1);
    expect(letPerf.callFunctionInternal).toBe(plainPerf.callFunctionInternal);
    expect(letPerf.maxCallDepth).toBe(plainPerf.maxCallDepth);
  });

  test("charges a binding expression only on its first force", () => {
    const onceUsage = { fuel: 0 };
    const twiceUsage = { fuel: 0 };
    const binding = { $call: "add", $args: [1, 2] };

    expect(
      callFunction(
        {
          $return: letExpression({ value: binding }, [{ $var: "value" }, 0]),
        },
        [],
        stdlib,
        { usage: onceUsage },
      ),
    ).toEqual([3, 0]);
    expect(
      callFunction(
        {
          $return: letExpression({ value: binding }, [{ $var: "value" }, { $var: "value" }]),
        },
        [],
        stdlib,
        { usage: twiceUsage },
      ),
    ).toEqual([3, 3]);

    // Replacing the scalar with a second variable lookup costs one expression
    // node either way; the binding's call subtree must not be charged again.
    expect(twiceUsage.fuel).toBe(onceUsage.fuel);
  });

  test("uses the current activation for a rebound function captured by a nested lambda", () => {
    const bad: FunctionBody = {
      $params: ["xs", "acc"],
      $return: {
        $if: { $call: "eq", $args: [{ $call: "length", $args: [{ $var: "xs" }] }, 0] },
        $then: { $var: "acc" },
        $else: letExpression(
          {
            cur: { $call: "head", $args: [{ $var: "xs" }] },
            f: { $params: ["ignored"], $return: { $var: "cur" } },
          },
          {
            $call: "bad",
            $args: [
              { $call: "tail", $args: [{ $var: "xs" }] },
              {
                $call: "concat",
                $args: [
                  { $var: "acc" },
                  [
                    {
                      $call: "map",
                      $args: [
                        {
                          $params: ["item"],
                          $return: { $call: "f", $args: [{ $var: "item" }] },
                        },
                        [0],
                      ],
                    },
                  ],
                ],
              },
            ],
          },
        ),
      },
    };
    const registry: FunctionRegistry = { ...stdlib, bad };

    expect(callFunction("bad", [[1, 2, 3], []], registry)).toEqual([[1], [2], [3]]);
  });

  test("uses each relaxation round's current distance inside a nested map lambda", () => {
    const roundField = (name: string): JSONType => ({
      $from: { $var: "round" },
      $get: name,
    });
    const edgeField = (name: string): JSONType => ({
      $from: { $var: "edge" },
      $get: name,
    });
    const relaxRounds: FunctionBody = {
      $params: ["rounds", "acc"],
      $return: {
        $if: { $call: "eq", $args: [{ $call: "length", $args: [{ $var: "rounds" }] }, 0] },
        $then: { $var: "acc" },
        $else: letExpression(
          {
            round: { $call: "head", $args: [{ $var: "rounds" }] },
            altOf: {
              $params: ["edge"],
              $return: {
                $call: "add",
                $args: [roundField("distance"), edgeField("weight")],
              },
            },
            updates: {
              $call: "fromEntries",
              $args: [
                {
                  $call: "map",
                  $args: [
                    {
                      $params: ["edge"],
                      $return: [edgeField("to"), { $call: "altOf", $args: [{ $var: "edge" }] }],
                    },
                    roundField("edges"),
                  ],
                },
              ],
            },
          },
          {
            $call: "relaxRounds",
            $args: [
              { $call: "tail", $args: [{ $var: "rounds" }] },
              {
                $call: "concat",
                $args: [{ $var: "acc" }, [{ $var: "updates" }]],
              },
            ],
          },
        ),
      },
    };
    const registry: FunctionRegistry = { ...stdlib, relaxRounds };
    const rounds = [
      { distance: 0, edges: [{ to: "B", weight: 2 }] },
      { distance: 2, edges: [{ to: "C", weight: 3 }] },
      { distance: 5, edges: [{ to: "E", weight: 2 }] },
    ];

    expect(callFunction("relaxRounds", [rounds, []], registry)).toEqual([
      { B: 2 },
      { C: 5 },
      { E: 7 },
    ]);
  });
});
