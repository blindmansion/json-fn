import { describe, expect, test } from "bun:test";
import {
  CallableTypeRuleContractError,
  CallableTypeRuleOwnershipError,
  DuplicateCallableTypeRuleError,
  checkExpr,
  checkModule,
  getArity,
  loadBuiltinTable,
  mergeCallableTypeRuleRegistries,
  type CallableTable,
  type CallableTypeRuleRegistry,
} from "../../src";
import { createStdlib } from "../../src/stdlib";
import type { JSONType } from "../../src/types";
import type { Schema } from "../../src/schema/schema";

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };
const B: Schema = { type: "boolean" };
const call = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
const body = (
  params: JSONType[],
  sig: { required: Schema[]; optional: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
): Record<string, JSONType> => ({ $params: params, $sig: sig, $return: ret });

describe("builtin checker implementation internals", () => {
  const BT = loadBuiltinTable();

  test("single signatures implement required-through-optional ranges", () => {
    const table: CallableTable = {
      builtins: {
        flexible: { signatures: [{ required: [I], optional: [S, B], returns: I }] },
      },
    };
    const run = (...args: JSONType[]) => checkExpr(call("flexible", ...args), {}, table);
    expect(run().diagnostics[0]?.message).toBe("Expected 1 to 3 arguments, got 0.");
    expect(run(1).diagnostics).toEqual([]);
    expect(run(1, "label", true).diagnostics).toEqual([]);
    expect(run(1, "label", true, false).diagnostics[0]?.message).toBe(
      "Expected 1 to 3 arguments, got 4.",
    );
    expect(run(1, false).diagnostics[0]).toEqual(
      expect.objectContaining({ path: ["$args[1]"], expected: S, actual: { const: false } }),
    );
  });

  test("multi-overload selection trials optional tails at the supplied count", () => {
    const table: CallableTable = {
      builtins: {
        choose: {
          signatures: [
            { required: [I], optional: [S], returns: I },
            { required: [I], optional: [B, B], returns: S },
          ],
        },
      },
    };
    const run = (...args: JSONType[]) => checkExpr(call("choose", ...args), {}, table);
    expect(run(1)).toEqual({ type: I, diagnostics: [] });
    expect(run(1, true)).toEqual({ type: S, diagnostics: [] });
    expect(run(1, true, false)).toEqual({ type: S, diagnostics: [] });
    expect(run().diagnostics).toHaveLength(1);
  });

  test("rest arguments start after every fixed optional position", () => {
    const table: CallableTable = {
      builtins: {
        variadic: {
          signatures: [{ required: [I], optional: [S], rest: B, returns: I }],
        },
      },
    };
    const run = (...args: JSONType[]) => checkExpr(call("variadic", ...args), {}, table);
    expect(run(1).diagnostics).toEqual([]);
    expect(run(1, "label", true, false).diagnostics).toEqual([]);
    expect(run(1, true).diagnostics[0]).toEqual(
      expect.objectContaining({ path: ["$args[1]"], expected: S, actual: { const: true } }),
    );
  });

  test("unavailable implementation rules preserve fallback and report coverage", () => {
    const table: CallableTable = {
      builtins: {
        mystery: {
          signatures: [{ required: [], optional: [], returns: true }],
          rule: "example.mystery",
        },
      },
    };
    expect(checkExpr(call("mystery"), {}, table, { typeRules: {} })).toEqual({
      type: true,
      diagnostics: [
        {
          path: [],
          message: 'type coverage degraded because callable rule "example.mystery" is unavailable.',
          severity: "info",
        },
      ],
    });
  });

  test("unavailable rule fallback still participates in return checking", () => {
    const table: CallableTable = {
      builtins: {
        dynamicItems: {
          signatures: [{ required: [], optional: [], returns: { type: "array", items: true } }],
          rule: "example.dynamicItems",
        },
      },
    };
    const diagnostics = checkModule(
      {
        f: body(
          [],
          {
            required: [],
            optional: [],
            returns: { type: "array", items: I },
          },
          call("dynamicItems"),
        ),
      },
      table,
      { typeRules: {} },
    );
    expect(diagnostics.map((d) => d.severity)).toEqual(["info", "error"]);
  });

  test("injected namespaced rules refine their portable fallback", () => {
    const table: CallableTable = {
      builtins: {
        answer: {
          signatures: [{ required: [], optional: [], returns: I }],
          rule: "example.answer",
        },
      },
    };
    const typeRules: CallableTypeRuleRegistry = {
      "example.answer": { apply: () => ({ const: 42 }) },
    };
    expect(checkExpr(call("answer"), {}, table, { typeRules })).toEqual({
      type: { const: 42 },
      diagnostics: [],
    });
  });

  test("rules own declared contextual arguments", () => {
    const table: CallableTable = {
      $defs: BT.$defs,
      builtins: {
        ...BT.builtins,
        refine: {
          signatures: [
            {
              required: [{ $fnType: { required: [S], optional: [], returns: true } }],
              optional: [],
              returns: true,
            },
          ],
          rule: "example.refine",
        },
      },
    };
    const typeRules: CallableTypeRuleRegistry = {
      "example.refine": {
        contextualArguments: [0],
        apply: (request, services) => {
          services.contextualTypeCallback(0, {
            $fnType: { required: [I], optional: [], returns: true },
          });
          return request.fallbackResult;
        },
      },
    };
    const callback = {
      $params: ["n"],
      $return: call("add", { $var: "n" }, 1),
    };
    expect(checkExpr(call("refine", callback), {}, table, { typeRules }).diagnostics).toEqual([]);
  });

  test("owned callbacks do not suppress diagnostics for other arguments", () => {
    const table: CallableTable = {
      $defs: BT.$defs,
      builtins: {
        ...BT.builtins,
        refine: {
          signatures: [
            {
              required: [{ $fnType: { required: [S], optional: [], returns: true } }, S],
              optional: [],
              returns: true,
            },
          ],
          rule: "example.refine",
        },
      },
    };
    const typeRules: CallableTypeRuleRegistry = {
      "example.refine": {
        contextualArguments: [0],
        apply: (request, services) => {
          services.contextualTypeCallback(0, {
            $fnType: { required: [I], optional: [], returns: true },
          });
          return request.fallbackResult;
        },
      },
    };
    const callback = {
      $params: ["n"],
      $return: call("add", { $var: "n" }, 1),
    };
    const result = checkExpr(call("refine", callback, false), {}, table, { typeRules });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.path).toEqual(["$args[1]"]);
  });

  test("rules cannot contextually type undeclared arguments", () => {
    const table: CallableTable = {
      builtins: {
        bad: {
          signatures: [
            {
              required: [{ $fnType: { required: [true], optional: [], returns: true } }],
              optional: [],
              returns: true,
            },
          ],
          rule: "example.bad",
        },
      },
    };
    const callback = { $params: ["value"], $return: { $var: "value" } };
    expect(() =>
      checkExpr(call("bad", callback), {}, table, {
        typeRules: {
          "example.bad": {
            apply: (request, services) => {
              services.contextualTypeCallback(0, {
                $fnType: { required: [true], optional: [], returns: true },
              });
              return request.fallbackResult;
            },
          },
        },
      }),
    ).toThrow(CallableTypeRuleOwnershipError);
  });

  test("rules must consume each owned contextual argument exactly once", () => {
    const table: CallableTable = {
      builtins: {
        bad: {
          signatures: [
            {
              required: [{ $fnType: { required: [true], optional: [], returns: true } }],
              optional: [],
              returns: true,
            },
          ],
          rule: "example.bad",
        },
      },
    };
    const callback = { $params: ["value"], $return: { $var: "value" } };
    const expected: Schema = {
      $fnType: { required: [true], optional: [], returns: true },
    };
    expect(() =>
      checkExpr(call("bad", callback), {}, table, {
        typeRules: {
          "example.bad": {
            contextualArguments: [0],
            apply: (request, services) => {
              services.contextualTypeCallback(0, expected);
              services.contextualTypeCallback(0, expected);
              return request.fallbackResult;
            },
          },
        },
      }),
    ).toThrow(CallableTypeRuleOwnershipError);
    expect(() =>
      checkExpr(call("bad", callback), {}, table, {
        typeRules: {
          "example.bad": {
            contextualArguments: [0],
            apply: (request) => request.fallbackResult,
          },
        },
      }),
    ).toThrow(CallableTypeRuleOwnershipError);
  });

  test("rule registry composition rejects duplicate identifiers", () => {
    const rule = { apply: () => true as Schema };
    expect(() =>
      mergeCallableTypeRuleRegistries({ "example.rule": rule }, { "example.rule": rule }),
    ).toThrow(DuplicateCallableTypeRuleError);
  });

  test("rule results must stay inside their portable fallback", () => {
    const table: CallableTable = {
      builtins: {
        bad: {
          signatures: [{ required: [], optional: [], returns: I }],
          rule: "example.bad",
        },
      },
    };
    expect(() =>
      checkExpr(call("bad"), {}, table, {
        typeRules: { "example.bad": { apply: () => S } },
      }),
    ).toThrow(CallableTypeRuleContractError);
  });

  test("standard runtime and signature registries have identical keys", () => {
    expect(Object.keys(createStdlib()).sort()).toEqual(Object.keys(BT.builtins).sort());
  });

  test("callback-friendly standard builtins retain runtime arities", () => {
    const stdlib = createStdlib();
    expect(getArity("range", stdlib)).toBe(1);
    expect(getArity("flatten", stdlib)).toBe(1);
  });

  test("standard precision rules expose their portable fallback when dispatch is absent", () => {
    const scalar = {
      $params: ["n"],
      $return: call("add", { $var: "n" }, 1),
    };
    const result = checkExpr(call("flatMap", scalar, [1, 2, 3]), {}, BT, { typeRules: {} });
    expect(result.type).toEqual({ type: "array" });
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: 'type coverage degraded because callable rule "core.flatMap" is unavailable.',
        severity: "info",
      },
    ]);
  });

  test("custom signatures bind type variables through structural tuple and object positions", () => {
    const T = (name: string): Schema => ({ $tvar: name }) as Schema;
    const table: CallableTable = {
      builtins: {
        pairSecond: {
          signatures: [
            {
              typeParams: ["V"],
              required: [
                {
                  type: "array",
                  items: {
                    type: "array",
                    prefixItems: [S, T("V")],
                    items: false,
                  },
                },
              ],
              optional: [],
              returns: T("V"),
            },
          ],
        },
        objectValues: {
          signatures: [
            {
              typeParams: ["V"],
              required: [{ type: "object", additionalProperties: T("V") }],
              optional: [],
              returns: { type: "array", items: T("V") },
            },
          ],
        },
      },
    };
    expect(
      checkExpr(
        call("pairSecond", [
          ["a", 1],
          ["b", "x"],
        ]),
        {},
        table,
      ),
    ).toEqual({
      type: { anyOf: [{ const: 1 }, { const: "x" }] },
      diagnostics: [],
    });
    expect(checkExpr(call("objectValues", { a: 1, b: "x" }), {}, table)).toEqual({
      type: { type: "array", items: { anyOf: [{ const: 1 }, { const: "x" }] } },
      diagnostics: [],
    });
  });

  test("callback-return binding rolls back partial structural bindings", () => {
    const T = (name: string): Schema => ({ $tvar: name }) as Schema;
    const table: CallableTable = {
      builtins: {
        testCallback: {
          signatures: [
            {
              typeParams: ["U"],
              required: [
                {
                  $fnType: {
                    required: [],
                    optional: [],
                    returns: {
                      type: "array",
                      prefixItems: [T("U"), S],
                      items: false,
                      minItems: 2,
                    },
                  },
                },
              ],
              optional: [],
              returns: T("U"),
            },
          ],
        },
      },
    };
    const result = checkExpr(call("testCallback", { $params: [], $return: [1, 2] }), {}, table);
    expect(result.type).toBe(true);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        path: ["$args[0]", "$return"],
        expected: {
          type: "array",
          prefixItems: [true, S],
          items: false,
          minItems: 2,
        },
        severity: "error",
      }),
    );
  });
});
