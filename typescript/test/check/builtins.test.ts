import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../../src/builtins";
import type { JSONType } from "../../src/types";
import type { CallableTable, CallableTypeRuleRegistry } from "../../src";
import {
  CallableTypeRuleContractError,
  CallableTypeRuleOwnershipError,
  DuplicateCallableTypeRuleError,
  mergeCallableTypeRuleRegistries,
} from "../../src";
import { classifySchema, SchemaKind, type Schema } from "../../src/schema/schema.ts";
import { isSubschema } from "../../src/check/subsumption";
import { checkExpr, checkModule } from "../../src/check/module";
import { createStdlib } from "../../src/stdlib";

// Convenience: a `$sig`-annotated function body.
const body = (
  params: JSONType[],
  sig: { required: Schema[]; optional: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
  locals: Record<string, JSONType> = {},
): Record<string, JSONType> => ({ $sig: sig, $params: params, ...locals, $return: ret });

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };
const B: Schema = { type: "boolean" };

// ---------------------------------------------------------------------------
// Section F — builtin signatures (the spec/builtins.json dialect, end to end)
// ---------------------------------------------------------------------------

describe("Section F — builtin signatures", () => {
  const BT = loadBuiltinTable();
  const call = (name: JSONType, ...args: JSONType[]): JSONType => ({ $call: name, $args: args });
  const arrOfInt: Schema = { type: "array", items: { type: "integer" } };
  const synthB = (expr: JSONType) => checkExpr(expr, {}, BT);

  test("builtins are opt-in: no table means degrade to any", () => {
    const result = checkExpr(call("add", 1, 2));
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: "expression degraded to `any` because the callee has no known function type.",
        severity: "info",
      },
    ]);
  });

  test("overloads: add preserves integer, widens to number", () => {
    expect(synthB(call("add", 1, 2)).type).toEqual({ type: "integer" });
    expect(synthB(call("add", 1.5, 2)).type).toEqual({ type: "number" });
  });

  test("overloads: length accepts arrays and strings", () => {
    expect(synthB(call("length", [1, 2, 3])).type).toEqual({ type: "integer" });
    expect(synthB(call("length", "hello")).type).toEqual({ type: "integer" });
  });

  test("a single builtin accepts its required-through-optional range", () => {
    const table: CallableTable = {
      builtins: {
        flexible: {
          signatures: [{ required: [I], optional: [S, B], returns: I }],
        },
      },
    };
    const run = (...args: JSONType[]) => checkExpr(call("flexible", ...args), {}, table);

    expect(run().diagnostics.map(({ message }) => message)).toEqual([
      "Expected 1 to 3 arguments, got 0.",
    ]);
    for (const args of [[1], [1, "label"], [1, "label", true]]) {
      expect(run(...args).diagnostics).toEqual([]);
    }
    expect(run(1, "label", true, false).diagnostics.map(({ message }) => message)).toEqual([
      "Expected 1 to 3 arguments, got 4.",
    ]);
    expect(run(1, false).diagnostics).toContainEqual(
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

    const { diagnostics } = run();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe(
      'No overload of "choose" matches arguments (); expected ({"type":"integer"}, {"type":"string"}?) or ({"type":"integer"}, {"type":"boolean"}?, {"type":"boolean"}?).',
    );
  });

  test("builtin rest starts after every fixed optional position", () => {
    const table: CallableTable = {
      builtins: {
        variadic: {
          signatures: [{ required: [I], optional: [S], rest: B, returns: I }],
        },
      },
    };
    const run = (...args: JSONType[]) => checkExpr(call("variadic", ...args), {}, table);

    expect(run().diagnostics.map(({ message }) => message)).toEqual([
      "Expected at least 1 argument, got 0.",
    ]);
    expect(run(1).diagnostics).toEqual([]);
    expect(run(1, "label", true, false).diagnostics).toEqual([]);
    expect(run(1, true).diagnostics).toContainEqual(
      expect.objectContaining({ path: ["$args[1]"], expected: S, actual: { const: true } }),
    );
  });

  test("a no-overload-fits call reports a diagnostic", () => {
    // gt : (number, number) -> boolean; strings fit neither overload.
    expect(synthB(call("gt", "a", "b")).diagnostics.length).toBeGreaterThan(0);
  });

  test("a multi-overload no-match reports every arm, not just the first", () => {
    // length : (array) | (string) -> integer; 123 fits neither. The diagnostic
    // must mention the string arm too, not only the leading array arm.
    const { diagnostics } = synthB(call("length", 123));
    expect(diagnostics).toHaveLength(1);
    const [d] = diagnostics;
    expect(d!.severity).toBe("error");
    expect(d!.path).toEqual([]);
    expect(d!.message).toContain('"array"');
    expect(d!.message).toContain('"string"');
    // Structured, machine-readable fields: expected is the anyOf of the arms,
    // actual is the call's own argument shape.
    expect(d!.expected).toEqual({
      anyOf: [
        { $fnType: { required: [{ type: "array" }], optional: [], returns: I } },
        { $fnType: { required: [{ type: "string" }], optional: [], returns: I } },
      ],
    });
    expect(d!.actual).toEqual({
      $fnType: { required: [{ const: 123 }], optional: [], returns: true },
    });
  });

  test("no-match keeps a single call-level diagnostic and surfaces nested errors once", () => {
    // add : (integer, integer) | (number, number); a boolean + string fits
    // neither. The inner gt errors surface once each, plus one overload-set
    // error at the call — no duplication from the silent bind trials.
    const { diagnostics } = synthB(call("add", call("gt", "a", "b"), "x"));
    const overloadErrors = diagnostics.filter((d) => d.message.startsWith("No overload"));
    expect(overloadErrors).toHaveLength(1);
    const nested = diagnostics.filter((d) => d.path.length > 0);
    expect(nested).toHaveLength(2);
  });

  test("type variables: head widens tuple elements and flattens T | null", () => {
    expect(synthB(call("head", [1, 2, 3])).type).toEqual({
      anyOf: [{ type: "integer" }, { type: "null" }],
    });
  });

  test("type variables: head of an empty tuple simplifies to null", () => {
    expect(synthB(call("head", [])).type).toEqual({ type: "null" });
  });

  test("type variables: concat and setAt preserve the element type", () => {
    expect(isSubschema(synthB(call("concat", [1, 2], [3, 4])).type, arrOfInt)).toBe(true);
    expect(isSubschema(synthB(call("setAt", [1, 2, 3], 0, 9)).type, arrOfInt)).toBe(true);
  });

  test("named $defs type + union return: reMatch", () => {
    expect(synthB(call("reMatch", "a", "b")).type).toEqual({
      anyOf: [{ $ref: "#/$defs/Match" }, { type: "null" }],
    });
  });

  test("escape hatch: a rule builtin yields any", () => {
    const result = synthB(call("pipe", [], 1));
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message:
          'expression degraded to `any` because callable rule "pipe" has no precise return type.',
        severity: "info",
      },
    ]);
  });

  test("an unavailable builtin rule keeps its fallback and reports a coverage gap", () => {
    const result = checkExpr(
      call("mystery"),
      {},
      {
        builtins: {
          mystery: {
            signatures: [{ required: [], optional: [], returns: true }],
            rule: "example.mystery",
          },
        },
      },
      { typeRules: {} },
    );
    expect(result.type).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        path: [],
        message: 'type coverage degraded because callable rule "example.mystery" is unavailable.',
        severity: "info",
      },
    ]);
  });

  test("an injected namespaced rule refines its portable fallback", () => {
    const table: CallableTable = {
      builtins: {
        answer: {
          signatures: [{ required: [], optional: [], returns: { type: "integer" } }],
          rule: "example.answer",
        },
      },
    };
    const typeRules: CallableTypeRuleRegistry = {
      "example.answer": { apply: () => ({ const: 42 }) },
    };
    const result = checkExpr(call("answer"), {}, table, { typeRules });
    expect(result.type).toEqual({ const: 42 });
    expect(result.diagnostics).toEqual([]);
  });

  test("a rule owns declared contextual arguments instead of retaining fallback diagnostics", () => {
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

  test("a rule contextual service requires an exact callback shape", () => {
    const table: CallableTable = {
      builtins: {
        refine: {
          signatures: [
            {
              required: [{ $fnType: { required: [I], optional: [], returns: true } }],
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
            $fnType: { required: [], optional: [I], returns: true },
          });
          return request.fallbackResult;
        },
      },
    };
    const callback = {
      $params: ["value"],
      $return: { $var: "missing" },
    };

    expect(checkExpr(call("refine", callback), {}, table, { typeRules }).diagnostics).toEqual([
      expect.objectContaining({
        path: ["$args[0]", "$params"],
        message:
          "Contextual signature expects 0 required parameter(s), 1 optional parameter(s), and no rest parameter; body declares 1 required parameter(s), 0 optional parameter(s), and no rest parameter.",
      }),
    ]);
  });

  test("owned callbacks do not suppress fallback diagnostics for other arguments", () => {
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

  test("a rule cannot contextually type an undeclared argument", () => {
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

  test("a rule cannot contextually type an owned argument more than once", () => {
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
    const expected: Schema = { $fnType: { required: [true], optional: [], returns: true } };

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
  });

  test("a rule must consume each applicable declared contextual argument", () => {
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

  test("a rule result must remain inside its portable fallback", () => {
    const table: CallableTable = {
      builtins: {
        bad: {
          signatures: [{ required: [], optional: [], returns: { type: "integer" } }],
          rule: "example.bad",
        },
      },
    };
    expect(() =>
      checkExpr(call("bad"), {}, table, {
        typeRules: { "example.bad": { apply: () => ({ type: "string" }) } },
      }),
    ).toThrow(CallableTypeRuleContractError);
  });

  test("coverage: stdlib and signature-table keys are exactly equal", () => {
    expect(Object.keys(createStdlib()).sort()).toEqual(Object.keys(BT.builtins).sort());
  });

  describe("tier 1 — monomorphic & concrete overloads", () => {
    test("max/min/sum preserve integer and widen to number", () => {
      expect(synthB(call("max", [1, 2, 3])).type).toEqual({ type: "integer" });
      expect(synthB(call("min", [1.5, 2])).type).toEqual({ type: "number" });
      expect(synthB(call("sum", [1, 2, 3])).type).toEqual({ type: "integer" });
      expect(synthB(call("sum", [1.5, 2])).type).toEqual({ type: "number" });
    });

    test("math functions return numbers", () => {
      for (const expression of [
        call("sqrt", 9),
        call("pow", 2, 10),
        call("exp", 1),
        call("log", 1),
        call("log10", 10),
        call("sin", 0),
        call("cos", 0),
        call("tan", 0),
        call("atan2", 1, 0),
      ]) {
        expect(synthB(expression).type).toEqual({ type: "number" });
      }
      expect(synthB(call("sqrt", "9")).diagnostics.length).toBeGreaterThan(0);
    });

    test("num/isTask/arity have concrete returns", () => {
      expect(synthB(call("num", "5")).type).toEqual({ type: "number" });
      expect(synthB(call("isTask", 1)).type).toEqual({ type: "boolean" });
      expect(isSubschema(synthB(call("arity", 1)).type, { type: ["integer", "null"] })).toBe(true);
    });

    test("range/split/join/strcat", () => {
      expect(isSubschema(synthB(call("range", 5)).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("split", "a,b", ",")).type, { type: "array", items: S })).toBe(
        true,
      );
      expect(synthB(call("join", ["a", "b"], ",")).type).toEqual(S);
      expect(synthB(call("strcat", "a", "b", "c")).type).toEqual(S);
    });

    test("strcat rejects a non-string arg", () => {
      expect(synthB(call("strcat", "a", 1)).diagnostics.length).toBeGreaterThan(0);
    });

    test("startsWith/endsWith return boolean and require strings", () => {
      expect(synthB(call("startsWith", "hello", "he")).type).toEqual({ type: "boolean" });
      expect(synthB(call("endsWith", "hello", "lo")).type).toEqual({ type: "boolean" });
      expect(synthB(call("startsWith", "hello", 1)).diagnostics.length).toBeGreaterThan(0);
    });

    test("replace returns a string and requires string arguments", () => {
      expect(synthB(call("replace", "banana", "an", "X")).type).toEqual(S);
      expect(synthB(call("replace", "banana", 1, "X")).diagnostics.length).toBeGreaterThan(0);
    });

    test("padStart accepts its optional fill and returns a string", () => {
      expect(synthB(call("padStart", "7", 3)).type).toEqual(S);
      expect(synthB(call("padStart", "7", 3, "0")).type).toEqual(S);
      expect(synthB(call("padStart", "7", 3.5)).diagnostics.length).toBeGreaterThan(0);
    });

    test("regex families: reTest/reMatchAll/reReplace/reSplit", () => {
      expect(synthB(call("reTest", "a", "b")).type).toEqual({ type: "boolean" });
      expect(synthB(call("reMatchAll", "a", "b")).type).toEqual({
        type: "array",
        items: { $ref: "#/$defs/Match" },
      });
      expect(synthB(call("reReplace", "a", "b", "c")).type).toEqual(S);
      expect(isSubschema(synthB(call("reSplit", "a", "b")).type, { type: "array", items: S })).toBe(
        true,
      );
    });

    test("tap is identity on its value (both overloads)", () => {
      expect(synthB(call("tap", "hi")).type).toEqual({ const: "hi" });
      expect(synthB(call("tap", "hi", "label")).type).toEqual({ const: "hi" });
    });
  });

  describe("tier 2 — array generics", () => {
    test("last is T | null; tail/reverse are T[]", () => {
      expect(isSubschema(synthB(call("last", [1, 2, 3])).type, { type: ["integer", "null"] })).toBe(
        true,
      );
      expect(isSubschema(synthB(call("tail", [1, 2, 3])).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("reverse", [1, 2, 3])).type, arrOfInt)).toBe(true);
    });

    test("flatten unwraps one array level", () => {
      // A literal `[[1,2],[3]]` synthesizes to a *tuple of tuples*, which the
      // engine can't destructure; build a real `integer[][]` via map/range.
      const nested = call(
        "map",
        { $params: ["n"], $return: call("range", { $var: "n" }) },
        [1, 2, 3],
      );
      expect(isSubschema(synthB(call("flatten", nested)).type, arrOfInt)).toBe(true);
    });

    test("slice: array arm stays generic, string arm returns string", () => {
      expect(isSubschema(synthB(call("slice", [1, 2, 3], 1)).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("slice", [1, 2, 3], 1, 2)).type, arrOfInt)).toBe(true);
      expect(synthB(call("slice", "hello", 1)).type).toEqual(S);
      expect(synthB(call("slice", "hello", 1, 3)).type).toEqual(S);
    });

    test("take/drop preserve the array element type", () => {
      expect(isSubschema(synthB(call("take", [1, 2, 3], 2)).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("drop", [1, 2, 3], 2)).type, arrOfInt)).toBe(true);
      expect(synthB(call("take", [1, 2, 3], 1.5)).diagnostics.length).toBeGreaterThan(0);
    });

    test("zip preserves both element types in pair tuples", () => {
      const pairs: Schema = {
        type: "array",
        items: {
          type: "array",
          prefixItems: [I, S],
          items: false,
          minItems: 2,
        },
      };
      expect(isSubschema(synthB(call("zip", [1, 2], ["a", "b"])).type, pairs)).toBe(true);
      expect(synthB(call("zip", [1, 2], "ab")).diagnostics.length).toBeGreaterThan(0);
    });

    test("unique and array repeat preserve the element type", () => {
      expect(isSubschema(synthB(call("unique", [1, 2, 1])).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("repeat", [1, 2], 2)).type, arrOfInt)).toBe(true);
    });

    test("repeat selects its string overload", () => {
      expect(synthB(call("repeat", "ab", 2)).type).toEqual(S);
      expect(synthB(call("repeat", 1, 2)).diagnostics.length).toBeGreaterThan(0);
    });

    test("includes/indexOf pick the right arm", () => {
      const intOrNull = { type: ["integer", "null"] };
      expect(synthB(call("includes", [1, 2, 3], 2)).type).toEqual({ type: "boolean" });
      expect(synthB(call("includes", "hi", "h")).type).toEqual({ type: "boolean" });
      expect(isSubschema(synthB(call("indexOf", [1, 2, 3], 2)).type, intOrNull)).toBe(true);
      expect(isSubschema(synthB(call("indexOf", "hi", "h")).type, intOrNull)).toBe(true);
    });
  });

  describe("tier 3 — higher-order builtins", () => {
    const callbackResult = (name: string): JSONType => {
      if (name.startsWith("reduce")) return { $var: "acc" };
      if (/^(filter|find|findIndex|some|every|count)/.test(name)) {
        return true;
      }
      return { $var: "n" };
    };
    const callbackFor = (name: string, indexed: boolean): JSONType => ({
      $params: name.startsWith("reduce")
        ? indexed
          ? ["acc", "n", "i"]
          : ["acc", "n"]
        : indexed
          ? ["n", "i"]
          : ["n"],
      $return: callbackResult(name),
    });
    const hofCall = (name: string, callback: JSONType): JSONType =>
      name.startsWith("reduce")
        ? call(name, callback, 0, [1, 2, 3])
        : call(name, callback, [1, 2, 3]);

    test("ordinary and indexed families infer the same return families", () => {
      const expectedByBase: Record<string, Schema> = {
        map: arrOfInt,
        filter: arrOfInt,
        reduce: I,
        find: { type: ["integer", "null"] },
        findIndex: { type: ["integer", "null"] },
        some: B,
        every: B,
        count: I,
        flatMap: arrOfInt,
        groupBy: { type: "object", additionalProperties: arrOfInt },
        sortBy: arrOfInt,
      };

      for (const [base, expected] of Object.entries(expectedByBase)) {
        for (const [name, indexed] of [
          [base, false],
          [`${base}Indexed`, true],
        ] as const) {
          const result = synthB(hofCall(name, callbackFor(name, indexed)));
          expect(result.diagnostics, name).toEqual([]);
          expect(isSubschema(result.type, expected), name).toBe(true);
        }
      }
    });

    test("ordinary and indexed families require their exact callback shapes", () => {
      const bases = [
        "map",
        "filter",
        "reduce",
        "find",
        "findIndex",
        "some",
        "every",
        "count",
        "flatMap",
        "groupBy",
        "sortBy",
      ];

      for (const base of bases) {
        const ordinary = synthB(hofCall(base, callbackFor(base, true)));
        expect(
          ordinary.diagnostics.some((d) => d.path.join(".") === "$args[0].$params"),
          `${base} rejects an indexed callback`,
        ).toBe(true);

        const indexedName = `${base}Indexed`;
        const indexed = synthB(hofCall(indexedName, callbackFor(indexedName, false)));
        expect(
          indexed.diagnostics.some((d) => d.path.join(".") === "$args[0].$params"),
          `${indexedName} rejects an ordinary callback`,
        ).toBe(true);
      }
    });

    test("reduce infers U from init and threads the accumulator", () => {
      const sum = {
        $params: ["acc", "n"],
        $return: call("add", { $var: "acc" }, { $var: "n" }),
      };
      const r = synthB(call("reduce", sum, 0, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      // U joins the literal init `0` with the integer accumulator return; union
      // normalization drops the redundant literal arm.
      expect(r.type).toEqual(I);
    });

    test("reduce accepts a callback valid for its widened accumulator", () => {
      const finish = {
        $params: ["acc", "n"],
        $return: {
          $if: call("eq", { $var: "n" }, 0),
          $then: "done",
          $else: { $var: "acc" },
        },
      };
      const r = synthB(call("reduce", finish, 0, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, { type: ["integer", "string"] })).toBe(true);
    });

    test("reduce rejects a callback unsafe for its widened accumulator", () => {
      const finishOrMultiply = {
        $params: ["acc", "n"],
        $return: {
          $if: call("eq", { $var: "n" }, 0),
          $then: "done",
          $else: call("mul", { $var: "acc" }, { $var: "n" }),
        },
      };
      const r = synthB(call("reduce", finishOrMultiply, 0, [1, 2, 3]));
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]", "$return", "$else"],
          severity: "error",
        }),
      );
    });

    test("find/findIndex are T|null / integer|null; some/every are boolean", () => {
      const gtOne = { $params: ["n"], $return: call("gt", { $var: "n" }, 1) };
      expect(
        isSubschema(synthB(call("find", gtOne, [1, 2, 3])).type, { type: ["integer", "null"] }),
      ).toBe(true);
      const idx = synthB(call("findIndex", gtOne, [1, 2, 3])).type;
      expect(isSubschema(idx, { type: ["integer", "null"] })).toBe(true);
      expect(isSubschema({ type: "integer" }, idx) && isSubschema({ type: "null" }, idx)).toBe(
        true,
      );
      expect(synthB(call("some", gtOne, [1, 2, 3])).type).toEqual({ type: "boolean" });
      expect(synthB(call("every", gtOne, [1, 2, 3])).type).toEqual({ type: "boolean" });
    });

    test("count contextually types its predicate and returns integer", () => {
      const gtOne = { $params: ["n"], $return: call("gt", { $var: "n" }, 1) };
      const result = synthB(call("count", gtOne, [1, 2, 3]));
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual(I);

      const nonBoolean = { $params: ["n"], $return: { $var: "n" } };
      expect(
        synthB(call("count", nonBoolean, [1, 2, 3])).diagnostics.some(
          (d) => d.path.join(".") === "$args[0].$return",
        ),
      ).toBe(true);
    });

    test("sort/sortBy preserve the element type", () => {
      const cmp = { $params: ["a", "b"], $return: call("sub", { $var: "a" }, { $var: "b" }) };
      expect(isSubschema(synthB(call("sort", cmp, [3, 1, 2])).type, arrOfInt)).toBe(true);
      expect(isSubschema(synthB(call("sort", [3, 1, 2])).type, arrOfInt)).toBe(true);
      expect(
        isSubschema(synthB(call("sort", ["b", "a"])).type, {
          type: "array",
          items: S,
        }),
      ).toBe(true);
      expect(synthB(call("sort", [1, "2"])).diagnostics.length).toBeGreaterThan(0);
      expect(synthB(call("sort", [true, false])).diagnostics.length).toBeGreaterThan(0);
      const keyFn = { $params: ["n"], $return: { $var: "n" } };
      expect(isSubschema(synthB(call("sortBy", keyFn, [3, 1, 2])).type, arrOfInt)).toBe(true);
    });

    test("groupBy accepts string and numeric keys and returns a map of T[]", () => {
      const stringKey = { $params: ["n"], $return: call("str", { $var: "n" }) };
      const numericKey = {
        $params: ["n"],
        $return: call("mod", { $var: "n" }, 2),
      };
      const expected: Schema = { type: "object", additionalProperties: arrOfInt };

      for (const keyFn of [stringKey, numericKey]) {
        const r = synthB(call("groupBy", keyFn, [1, 2, 3]));
        expect(r.diagnostics).toEqual([]);
        expect(isSubschema(r.type, expected)).toBe(true);
      }
    });

    test("flatMap infers its element type from an array callback return", () => {
      const dup = {
        $params: ["n"],
        $return: call("concat", [{ $var: "n" }], [{ $var: "n" }]),
      };
      const r = synthB(call("flatMap", dup, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("flatMap retains and infers scalar callback returns", () => {
      const scalar = {
        $params: ["n"],
        $return: call("add", { $var: "n" }, 1),
      };
      const r = synthB(call("flatMap", scalar, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(arrOfInt);
    });

    test("flatMapIndexed precisely infers from its index-aware callback", () => {
      const scalar = {
        $params: ["n", "i"],
        $return: call("add", { $var: "n" }, { $var: "i" }),
      };
      const r = synthB(call("flatMapIndexed", scalar, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(arrOfInt);
    });

    test("flatMap infers from an annotated callback return", () => {
      const callback = body(["n"], { required: [I], optional: [], returns: I }, { $var: "n" });
      const r = synthB(call("flatMap", callback, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(arrOfInt);
    });

    test("flatMap distributes one-level flattening across scalar-or-array unions", () => {
      const mixed = {
        $params: ["n"],
        $return: {
          $if: call("gt", { $var: "n" }, 1),
          $then: [call("str", { $var: "n" })],
          $else: { $var: "n" },
        },
      };
      const r = synthB(call("flatMap", mixed, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual({
        type: "array",
        items: { anyOf: [S, I] },
      });
    });

    test("flatMap flattens nested callback arrays by exactly one level", () => {
      const nested = {
        $params: ["n"],
        $return: [[{ $var: "n" }]],
      };
      const r = synthB(call("flatMap", nested, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, { type: "array", items: arrOfInt })).toBe(true);
      expect(isSubschema(r.type, arrOfInt)).toBe(false);
    });

    test("flatMap keeps its portable fallback when the precision rule is unavailable", () => {
      const scalar = {
        $params: ["n"],
        $return: call("add", { $var: "n" }, 1),
      };
      const r = checkExpr(call("flatMap", scalar, [1, 2, 3]), {}, BT, { typeRules: {} });
      expect(r.type).toEqual({ type: "array" });
      expect(r.diagnostics).toEqual([
        {
          path: [],
          message: 'type coverage degraded because callable rule "core.flatMap" is unavailable.',
          severity: "info",
        },
      ]);
    });

    test("flatMapIndexed uses its separate portable fallback rule", () => {
      const scalar = {
        $params: ["n", "i"],
        $return: call("add", { $var: "n" }, { $var: "i" }),
      };
      const r = checkExpr(call("flatMapIndexed", scalar, [1, 2, 3]), {}, BT, {
        typeRules: {},
      });
      expect(r.type).toEqual({ type: "array" });
      expect(r.diagnostics).toEqual([
        {
          path: [],
          message:
            'type coverage degraded because callable rule "core.flatMapIndexed" is unavailable.',
          severity: "info",
        },
      ]);
    });

    test("flatMap keeps fallback callback diagnostics when its rule is unavailable", () => {
      const invalid = {
        $params: ["n"],
        $return: call("add", "x", true),
      };
      const result = checkExpr(call("flatMap", invalid, [1, 2, 3]), {}, BT, {
        typeRules: {},
      });

      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]", "$return"],
          severity: "error",
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: "info",
        }),
      );
    });

    test("flatMap does not duplicate callback diagnostics during rule refinement", () => {
      const invalid = {
        $params: ["n"],
        $return: call("add", "x", true),
      };
      const r = synthB(call("flatMap", invalid, [1, 2, 3]));
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]).toEqual(
        expect.objectContaining({
          path: ["$args[0]", "$return"],
          severity: "error",
        }),
      );
    });

    test("reReplaceWith types its Match callback", () => {
      const cb = { $params: ["m"], $return: { $get: "match", $from: { $var: "m" } } };
      const r = synthB(call("reReplaceWith", "a", cb, "banana"));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(S);
    });
  });

  describe("tier 4 — object utilities & effect rules", () => {
    test("keys returns string[]; values/entries return arrays", () => {
      const obj = { a: 1, b: 2 };
      expect(isSubschema(synthB(call("keys", obj)).type, { type: "array", items: S })).toBe(true);
      expect(classifySchema(synthB(call("values", obj)).type)).toBe(SchemaKind.Array);
      expect(classifySchema(synthB(call("entries", obj)).type)).toBe(SchemaKind.Array);
    });

    test("merge/pick/omit return objects; hasKey a boolean", () => {
      const obj = { a: 1, b: 2 };
      expect(classifySchema(synthB(call("merge", obj, { c: 3 })).type)).toBe(SchemaKind.Object);
      expect(classifySchema(synthB(call("pick", obj, ["a"])).type)).toBe(SchemaKind.Object);
      expect(classifySchema(synthB(call("omit", obj, ["a"])).type)).toBe(SchemaKind.Object);
      expect(synthB(call("hasKey", obj, "a")).type).toEqual({ type: "boolean" });
    });

    test("effect constructors carry checker-only completion types", () => {
      const TASK = { $ref: "#/$defs/Task" };
      expect(synthB(call("perform", "read", [])).type).toEqual(TASK);
      expect(synthB(call("pure", 1)).type).toEqual({ $taskType: { const: 1 } });
      expect(synthB(call("raise", "boom")).type).toEqual({ $taskType: false });
      const cont = { $params: ["x"], $return: call("pure", { $var: "x" }) };
      expect(synthB(call("bind", call("pure", 1), cont)).type).toEqual({
        $taskType: { const: 1 },
      });
      expect(synthB(call("apply", { $params: ["n"], $return: { $var: "n" } }, [1])).type).toBe(
        true,
      );
      expect(synthB(call("pipe", [], 1)).type).toBe(true);
    });

    test("bind diagnoses its owned continuation only once under the precise context", () => {
      const invalid = {
        $params: ["value"],
        bad: call("add", "x", true),
        $return: call("pure", { $var: "bad" }),
      };
      const result = synthB(call("bind", call("pure", 1), invalid));

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toEqual(
        expect.objectContaining({
          path: ["bad"],
          severity: "error",
        }),
      );
    });

    test("bind accepts a continuation checked from its precise completion type", () => {
      const callback = {
        $params: ["value"],
        $return: call("pure", call("add", { $var: "value" }, 1)),
      };
      const result = synthB(call("bind", call("pure", 1), callback));

      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({ $taskType: I });
    });

    test("bind retains only its fallback arity or non-owned argument error", () => {
      const callback = {
        $params: ["value"],
        $return: call("pure", { $var: "value" }),
      };
      const wrongArity = synthB(call("bind", call("pure", 1), callback, null));
      expect(wrongArity.diagnostics).toHaveLength(1);
      expect(wrongArity.diagnostics[0]?.path).toEqual([]);

      const wrongTask = synthB(call("bind", 1, callback));
      expect(wrongTask.diagnostics).toHaveLength(1);
      expect(wrongTask.diagnostics[0]?.path).toEqual(["$args[0]"]);
    });

    test("perform leaves a malformed argument list to its fallback", () => {
      const result = synthB(call("perform", "read", 5));

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toEqual(
        expect.objectContaining({
          path: ["$args[1]"],
          severity: "error",
        }),
      );
    });

    test("annotated handle returns its declared immediate result type", () => {
      const stateToReport: Schema = {
        $fnType: { required: [{ type: "object" }], optional: [], returns: { type: "string" } },
      };
      const result = synthB(call("handle", call("pure", 1), {}, { $raw: stateToReport }));
      expect(result.type).toEqual(stateToReport);
      expect(result.diagnostics).toEqual([]);

      const applied = synthB(
        call(call("handle", call("pure", 1), {}, { $raw: stateToReport }), {}),
      );
      expect(applied.type).toEqual({ type: "string" });
      expect(applied.diagnostics).toEqual([]);
    });

    test("annotated handle accepts runtime-contract result schemas", () => {
      const schemas: Schema[] = [
        true,
        false,
        { const: "ok" },
        { enum: ["ok", null, 1] },
        { anyOf: [{ type: "string" }, { type: "null" }] },
        { type: "integer", minimum: 0 },
        { type: "array", items: { type: "string" } },
        {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "integer" },
        },
        {
          type: "object",
          properties: { id: { type: "integer" } },
          additionalProperties: false,
        },
        { type: "object", additionalProperties: { type: "string" } },
        {
          $fnType: {
            required: [{ type: "integer" }],
            optional: [{ type: "string" }],
            rest: { type: "boolean" },
            returns: { type: "number" },
          },
        },
      ];

      for (const schema of schemas) {
        const result = synthB(call("handle", call("pure", 1), {}, { $raw: schema }));
        expect(result.type).toEqual(schema);
        expect(result.diagnostics).toEqual([]);
      }

      const reference: Schema = { $ref: "#/$defs/Result" };
      const referenced = checkExpr(
        call("handle", call("pure", 1), {}, { $raw: reference }),
        { Result: S },
        BT,
      );
      expect(referenced.type).toEqual(reference);
      expect(referenced.diagnostics).toEqual([]);
    });

    test("annotated handle rejects schemas outside the runtime-contract fragment", () => {
      const schemas: Schema[] = [
        { unknown: true },
        { type: "array", items: { unknown: true } },
        { $taskType: { type: "string" } },
        {
          $fnType: {
            required: [],
            optional: [],
            returns: { $taskType: { type: "string" } },
          },
        },
      ];

      for (const schema of schemas) {
        const result = synthB(call("handle", call("pure", 1), {}, { $raw: schema }));
        expect(result.type).toBe(true);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            path: ["$args[2]", "$raw"],
            message: "handle result annotation is outside the tractable type fragment",
            severity: "error",
          }),
        );
      }
    });

    test("annotated handle requires a raw result schema", () => {
      const missingRaw = synthB(call("handle", call("pure", 1), {}, { type: "string" }));
      expect(missingRaw.type).toBe(true);
      expect(missingRaw.diagnostics.some((d) => d.path.join(".") === "$args[2]")).toBe(true);
    });

    test("annotated handle reports an undefined named result type", () => {
      const result = synthB(
        call("handle", call("pure", 1), {}, { $raw: { $ref: "#/$defs/Missing" } }),
      );
      expect(result.type).toEqual({ $ref: "#/$defs/Missing" });
      expect(result.diagnostics).toEqual([
        {
          path: ["$args[2]", "$raw"],
          message: 'reference to undefined type "Missing"',
          severity: "error",
        },
      ]);
    });
  });

  describe("A1 — structural type-variable binding", () => {
    const T = (name: string): Schema => ({ $tvar: name }) as Schema;
    const structural: CallableTable = {
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
        tupleRestValues: {
          signatures: [
            {
              typeParams: ["T"],
              required: [{ type: "array", prefixItems: [S], items: T("T") }],
              optional: [],
              returns: { type: "array", items: T("T") },
            },
          ],
        },
        propertyValue: {
          signatures: [
            {
              typeParams: ["T"],
              required: [{ type: "object", properties: { payload: T("T") } }],
              optional: [],
              returns: T("T"),
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
    const synth = (expr: JSONType) => checkExpr(expr, {}, structural);
    const errors = (mod: JSONType) =>
      checkModule(mod as Record<string, JSONType>, structural).filter(
        (d) => d.severity === "error",
      );

    test("binds tuple prefixItems positionally through array items", () => {
      const result = synth(call("pairSecond", [["a", 1]]));
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({ const: 1 });
    });

    test("joins a repeated tuple slot variable across concrete union arms", () => {
      const result = synth(
        call("pairSecond", [
          ["a", 1],
          ["b", "x"],
        ]),
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({ anyOf: [{ const: 1 }, { const: "x" }] });
    });

    test("binds tuple rest from every trailing position", () => {
      const result = synth(call("tupleRestValues", ["head", 1, "x"]));
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({
        type: "array",
        items: { anyOf: [{ const: 1 }, { const: "x" }] },
      });
    });

    test("binds a named object property", () => {
      const result = synth(call("propertyValue", { payload: 42 }));
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({ const: 42 });
    });

    test("binds additionalProperties from every closed-record field", () => {
      const result = synth(call("objectValues", { a: 1, b: "x" }));
      expect(result.diagnostics).toEqual([]);
      expect(result.type).toEqual({
        type: "array",
        items: { anyOf: [{ const: 1 }, { const: "x" }] },
      });
    });

    test("binds additionalProperties through a referenced map and a union", () => {
      const mapI: Schema = { type: "object", additionalProperties: I };
      const mapS: Schema = { type: "object", additionalProperties: S };
      const maps: Schema = { anyOf: [{ $ref: "#/$defs/MI" }, { $ref: "#/$defs/MS" }] };
      const vals: Schema = { type: "array", items: { anyOf: [I, S] } };
      expect(
        errors({
          $types: { MI: mapI, MS: mapS, Maps: maps },
          f: body(
            ["m"],
            { required: [{ $ref: "#/$defs/Maps" }], optional: [], returns: vals },
            call("objectValues", { $var: "m" }),
          ),
        }),
      ).toEqual([]);
    });

    test("accepts an open object by degrading its value variable to any", () => {
      expect(
        errors({
          f: body(
            ["o"],
            { required: [{ type: "object" }], optional: [], returns: { type: "array" } },
            call("objectValues", { $var: "o" }),
          ),
        }),
      ).toEqual([]);
    });

    test("rejects a concrete element that cannot match a tuple template", () => {
      const result = synth(call("pairSecond", [1, 2]));
      expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    });

    test("does not make any compatible with monomorphic primitive overloads", () => {
      const result = synthB(call("add", { $var: "unknown" }, 1));
      expect(result.diagnostics.some((d) => d.message.startsWith("No overload"))).toBe(true);
    });
  });

  describe("transactional callback-return binding", () => {
    const T = (name: string): Schema => ({ $tvar: name }) as Schema;
    const callbackReturn = (returns: Schema): CallableTable => ({
      builtins: {
        testCallback: {
          signatures: [
            {
              typeParams: ["U"],
              required: [{ $fnType: { required: [], optional: [], returns } }],
              optional: [],
              returns: T("U"),
            },
          ],
        },
      },
    });
    const run = (returns: Schema, value: JSONType) =>
      checkExpr(call("testCallback", { $params: [], $return: value }), {}, callbackReturn(returns));
    const returnError = (result: ReturnType<typeof run>) =>
      result.diagnostics.find((d) => d.path.join(".") === "$args[0].$return");

    test("rejects a scalar against an array return template", () => {
      const result = run({ type: "array", items: T("U") }, 1);
      expect(result.type).toBe(true);
      expect(returnError(result)).toEqual(
        expect.objectContaining({
          actual: { const: 1 },
          expected: { type: "array", items: true },
          severity: "error",
        }),
      );
    });

    test("rolls back an early tuple binding when a later slot fails", () => {
      const returns: Schema = {
        type: "array",
        prefixItems: [T("U"), S],
        items: false,
        minItems: 2,
      };
      const result = run(returns, [1, 2]);
      expect(result.type).toBe(true);
      expect(returnError(result)).toEqual(
        expect.objectContaining({
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

    test("rolls back an early object binding when a later property fails", () => {
      const returns: Schema = {
        type: "object",
        properties: { value: T("U"), label: S },
        required: ["value", "label"],
        additionalProperties: false,
      };
      const result = run(returns, { value: 1, label: 2 });
      expect(result.type).toBe(true);
      expect(returnError(result)).toEqual(
        expect.objectContaining({
          expected: {
            type: "object",
            properties: { value: true, label: S },
            required: ["value", "label"],
            additionalProperties: false,
          },
          severity: "error",
        }),
      );
    });

    test("does not infer from a callback with a different required/optional split", () => {
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
                      optional: [I],
                      returns: T("U"),
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
      const callback = body(["value"], { required: [I], optional: [], returns: S }, "result");
      const result = checkExpr(call("testCallback", callback), {}, table);

      expect(result.type).toBe(true);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]"],
          actual: { $fnType: { required: [I], optional: [], returns: S } },
          expected: { $fnType: { required: [], optional: [I], returns: true } },
          severity: "error",
        }),
      ]);
    });
  });

  describe("structural merge (merge's arg-dependent return)", () => {
    const closed = (props: Record<string, Schema>, required: string[]): Schema => ({
      type: "object",
      properties: props,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    });
    const errs = (mod: JSONType) =>
      checkModule(mod as Record<string, JSONType>, BT).filter((d) => d.severity === "error");
    const refA = { $ref: "#/$defs/A" };
    const updBody = (rhs: JSONType) =>
      body(
        ["a"],
        { required: [refA], optional: [], returns: refA },
        call("merge", { $var: "a" }, rhs),
      );

    test("the copy-with-one-field-changed idiom satisfies a declared record type", () => {
      const A = closed({ id: S, n: I }, ["id", "n"]);
      const inc = { n: call("add", { $get: "n", $from: { $var: "a" } }, 1) };
      expect(errs({ $types: { A }, upd: updBody(inc) })).toEqual([]);
    });

    test("merging an extra field onto a closed record is rejected", () => {
      const A = closed({ id: S, n: I }, ["id", "n"]);
      expect(errs({ $types: { A }, upd: updBody({ extra: 1 }) }).length).toBeGreaterThan(0);
    });

    test("RHS wins on a shared key: a bad override type is caught", () => {
      const A = closed({ id: S, n: I }, ["id", "n"]);
      // Overriding n with a string violates the declared integer field.
      expect(errs({ $types: { A }, upd: updBody({ n: "oops" }) }).length).toBeGreaterThan(0);
    });

    test("a map LHS keeps its value type through the merge", () => {
      const M: Schema = { type: "object", additionalProperties: I };
      const refM = { $ref: "#/$defs/M" };
      const fBody = (rhs: JSONType) =>
        body(
          ["m"],
          { required: [refM], optional: [], returns: refM },
          call("merge", { $var: "m" }, rhs),
        );
      expect(errs({ $types: { M }, f: fBody({ a: 1 }) })).toEqual([]);
      expect(errs({ $types: { M }, f: fBody({ a: "s" }) }).length).toBeGreaterThan(0);
    });
  });

  describe("structural fromEntries (arg-dependent return)", () => {
    const errs = (mod: JSONType) =>
      checkModule(mod as Record<string, JSONType>, BT).filter((d) => d.severity === "error");
    // An array of `[string, v]` entry pairs (a closed 2-tuple element).
    const entryArr = (v: Schema): Schema => ({
      type: "array",
      items: { type: "array", prefixItems: [S, v], items: false, minItems: 2 },
    });
    const mapOf = (v: Schema): Schema => ({ type: "object", additionalProperties: v });
    const fe = (param: Schema, returns: Schema) =>
      body(
        ["es"],
        { required: [param], optional: [], returns },
        call("fromEntries", { $var: "es" }),
      );

    test("projects the pair value type into additionalProperties", () => {
      expect(errs({ f: fe(entryArr(I), mapOf(I)) })).toEqual([]);
    });

    test("a wrong declared value type is caught", () => {
      expect(errs({ f: fe(entryArr(I), mapOf(S)) }).length).toBeGreaterThan(0);
    });

    test("a union of pair value types joins into the map value", () => {
      // Entries whose values are `integer | string` produce `{ [string]: integer | string }`.
      const mixed: Schema = { anyOf: [I, S] };
      expect(errs({ f: fe(entryArr(mixed), mapOf(mixed)) })).toEqual([]);
      expect(errs({ f: fe(entryArr(mixed), mapOf(I)) }).length).toBeGreaterThan(0);
    });

    test("accepts the exact pair tuples returned by entries", () => {
      const r = synthB(call("fromEntries", call("entries", { a: 1 })));
      expect(classifySchema(r.type)).toBe(SchemaKind.Object);
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });
  });

  describe("structural values/entries (arg-dependent return)", () => {
    const errs = (mod: JSONType) =>
      checkModule(mod as Record<string, JSONType>, BT).filter((d) => d.severity === "error");
    const arrOf = (v: Schema): Schema => ({ type: "array", items: v });
    const entryArr = (v: Schema): Schema => ({
      type: "array",
      items: { type: "array", prefixItems: [S, v], items: false, minItems: 2 },
    });
    const mapOf = (v: Schema): Schema => ({ type: "object", additionalProperties: v });
    const vBody = (param: Schema, returns: Schema) =>
      body(["o"], { required: [param], optional: [], returns }, call("values", { $var: "o" }));
    const eBody = (param: Schema, returns: Schema) =>
      body(["o"], { required: [param], optional: [], returns }, call("entries", { $var: "o" }));

    test("values projects a map's value type into the array items", () => {
      expect(errs({ f: vBody(mapOf(I), arrOf(I)) })).toEqual([]);
      expect(errs({ f: vBody(mapOf(I), arrOf(S)) }).length).toBeGreaterThan(0);
    });

    test("values of a closed record is the union of its field types", () => {
      const rec: Schema = {
        type: "object",
        properties: { a: I, b: S },
        required: ["a", "b"],
        additionalProperties: false,
      };
      expect(errs({ f: vBody(rec, arrOf({ anyOf: [I, S] })) })).toEqual([]);
      expect(errs({ f: vBody(rec, arrOf(I)) }).length).toBeGreaterThan(0);
    });

    test("entries pairs the value type as [string, V]", () => {
      expect(errs({ f: eBody(mapOf(I), entryArr(I)) })).toEqual([]);
      expect(errs({ f: eBody(mapOf(I), entryArr(S)) }).length).toBeGreaterThan(0);
    });

    test("values/entries round-trips through fromEntries", () => {
      // fromEntries(entries(map)) recovers the same map value type.
      const r = synthB(call("fromEntries", call("entries", { a: 1, b: 2 })));
      expect(isSubschema(r.type, mapOf(I))).toBe(true);
    });

    test("an open object degrades values/entries to their bare floor", () => {
      const open: Schema = { type: "object" };
      // No precise value type: the declared bare `array` still satisfies.
      expect(errs({ f: vBody(open, { type: "array" }) })).toEqual([]);
      expect(errs({ f: eBody(open, { type: "array", items: { type: "array" } }) })).toEqual([]);
    });
  });

  describe("escape-hatch rule floors", () => {
    const errs = (expr: JSONType) => synthB(expr).diagnostics.filter((d) => d.severity === "error");

    test("wrong arity is reported", () => {
      expect(errs(call("pipe", [])).length).toBeGreaterThan(0);
      expect(errs(call("perform", "e")).length).toBeGreaterThan(0);
      expect(errs(call("pure", 1, 2)).length).toBeGreaterThan(0);
    });

    test("a disjoint arg shape is a hard error", () => {
      // `pipe`'s first arg must be an array of functions; `5` cannot be.
      expect(errs(call("pipe", 5, 1)).some((d) => d.path.join(".") === "$args[0]")).toBe(true);
      // `apply`'s second arg must be an array.
      expect(errs(call("apply", { $params: ["n"], $return: { $var: "n" } }, 5))).not.toEqual([]);
      // `perform`'s effect name must be a string.
      expect(errs(call("perform", 5, []))).not.toEqual([]);
    });

    test("an any-typed arg is exempt from shape checks", () => {
      // A bare unknown var synthesizes to `any`; the floor must not flag it.
      const diagnostics = synthB(call("pipe", { $var: "unknown" }, 1)).diagnostics;
      expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
      expect(diagnostics).toEqual([
        {
          path: ["$args[0]"],
          message: 'expression degraded to `any` because variable "unknown" is unresolved.',
          severity: "info",
        },
        {
          path: [],
          message:
            'expression degraded to `any` because callable rule "pipe" has no precise return type.',
          severity: "info",
        },
      ]);
    });

    test("effectful functions can carry a Task / any return", () => {
      const perform = call("perform", "e", []);
      const fn = (returns: Schema): JSONType => ({
        $params: [],
        $sig: { required: [], optional: [], returns },
        $return: perform,
      });
      const noErr = (mod: JSONType) =>
        checkModule(mod as Record<string, JSONType>, BT).filter((d) => d.severity === "error");
      // `-> any`
      expect(noErr({ f: fn(true) })).toEqual([]);
      // Parsed bare `Task` is the erased `Task<unknown>` checker node.
      expect(noErr({ f: fn({ $taskType: true }) })).toEqual([]);
      // Portable contracts may still use the structural builtin Task floor.
      expect(noErr({ f: fn({ $ref: "#/$defs/Task" }) })).toEqual([]);
    });
  });

  describe("polymorphic mapValues", () => {
    const mapOf = (items: Schema): Schema => ({ type: "object", additionalProperties: items });

    test("types a closed record's values and callback result", () => {
      const inc = { $params: ["v", "k"], $return: call("add", { $var: "v" }, 1) };
      const r = synthB(call("mapValues", inc, { a: 1, b: 2 }));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(mapOf(I));
    });

    test("joins mixed closed-record values through an identity callback", () => {
      const identity = { $params: ["v", "k"], $return: { $var: "v" } };
      const r = synthB(call("mapValues", identity, { a: 1, b: "x" }));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(mapOf({ anyOf: [{ const: 1 }, { const: "x" }] }));
    });

    test("types the callback key as string", () => {
      const key = { $params: ["v", "k"], $return: { $var: "k" } };
      const r = synthB(call("mapValues", key, { a: 1 }));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(mapOf(S));
    });

    test("flows a typed map value through the module checker", () => {
      const mapOfInt = mapOf(I);
      const inc = { $params: ["v", "k"], $return: call("add", { $var: "v" }, 1) };
      const mod = {
        transform: body(
          ["obj"],
          { required: [mapOfInt], optional: [], returns: mapOfInt },
          call("mapValues", inc, { $var: "obj" }),
        ),
      };
      expect(checkModule(mod, BT).filter((d) => d.severity === "error")).toEqual([]);
    });

    test("keeps a precise callback result for an open input object", () => {
      const constant = { $params: ["v", "k"], $return: "ok" };
      const mod = {
        transform: body(
          ["obj"],
          { required: [{ type: "object" }], optional: [], returns: mapOf({ const: "ok" }) },
          call("mapValues", constant, { $var: "obj" }),
        ),
      };
      expect(checkModule(mod, BT).filter((d) => d.severity === "error")).toEqual([]);
    });

    test("reports an annotated callback whose body violates its declared return", () => {
      const bad = body(["v", "k"], { required: [I, S], optional: [], returns: S }, { $var: "v" });
      const r = synthB(call("mapValues", bad, { a: 1 }));
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]", "$return"],
          severity: "error",
        }),
      );
    });

    test("an empty closed record gives the callback a never value", () => {
      const inc = { $params: ["v", "k"], $return: call("add", { $var: "v" }, 1) };
      const r = synthB(call("mapValues", inc, {}));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(mapOf(I));
    });
  });

  describe("contextual lambda typing", () => {
    test("a malformed callback reports its parameter issue and skips its body", () => {
      const callback = {
        $params: [{ $param: "value" }],
        $return: { $var: "missing" },
      };
      const r = synthB(call("map", callback, [1, 2, 3]));

      expect(r.diagnostics).toEqual([
        {
          path: ["$args[0]", "$params[0]"],
          message: expect.stringContaining(
            "$params[0]: A defaulted parameter must contain exactly",
          ),
          severity: "error",
        },
      ]);
    });

    test("map infers T from the array and U from the callback return", () => {
      const identity = { $params: ["n"], $return: { $var: "n" } };
      const r = synthB(call("map", identity, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("map callback bodies resolve nested builtins under the pushed param type", () => {
      const addOne = { $params: ["n"], $return: call("add", { $var: "n" }, 1) };
      const r = synthB(call("map", addOne, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("filter accepts a boolean-returning callback", () => {
      const gtOne = { $params: ["n"], $return: call("gt", { $var: "n" }, 1) };
      const r = synthB(call("filter", gtOne, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("filter reports a non-boolean callback return", () => {
      const bad = { $params: ["n"], $return: { $var: "n" } };
      const r = synthB(call("filter", bad, [1, 2, 3]));
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics.some((d) => d.path.join(".") === "$args[0].$return")).toBe(true);
    });

    test("an annotated callback keeps its declared parameter types", () => {
      const callback = body(["n"], { required: [S], optional: [], returns: I }, 1);
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]"],
          actual: { $fnType: { required: [S], optional: [], returns: I } },
          expected: { $fnType: { required: [I], optional: [], returns: I } },
          severity: "error",
        }),
      );
    });

    test("a compatibly annotated callback remains valid and precise", () => {
      const callback = body(["n"], { required: [I], optional: [], returns: I }, { $var: "n" });
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("a bare callback must declare every supplied parameter", () => {
      const callback = { $params: [], $return: 1 };
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params"],
          message:
            "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 0 required parameter(s), 0 optional parameter(s), and no rest parameter.",
          severity: "error",
        }),
      ]);
    });

    test("a defaulted callback slot cannot replace a required supplied parameter", () => {
      const callback = {
        $params: ["n", { $param: "i", $default: "bad default" }],
        $return: { $var: "n" },
      };
      const r = synthB(call("map", callback, [10, 20]));

      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params"],
          message:
            "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 1 required parameter(s), 1 optional parameter(s), and no rest parameter.",
        }),
      ]);
    });

    test("an optional callback slot cannot replace a required supplied parameter", () => {
      const callback = {
        $params: ["n", { $param: "i", $optional: true }],
        $return: { $var: "n" },
      };
      const r = synthB(call("map", callback, [10, 20]));

      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params"],
          message:
            "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 1 required parameter(s), 1 optional parameter(s), and no rest parameter.",
        }),
      ]);
    });

    test("a bare callback rejects extra fixed parameters", () => {
      const callback = {
        $params: ["n", "i", "extra"],
        $return: call("add", { $var: "extra" }, 1),
      };
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params"],
          message: expect.stringContaining("body declares 3 required parameter(s)"),
          severity: "error",
        }),
      ]);
    });

    test("a bare callback rest does not absorb fixed supplied parameters", () => {
      const callback = { $params: ["n", "...rest"], $return: { $var: "rest" } };
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params"],
          message:
            "Contextual signature expects 1 required parameter(s), 0 optional parameter(s), and no rest parameter; body declares 1 required parameter(s), 0 optional parameter(s), and a rest parameter.",
          severity: "error",
        }),
      ]);
    });

    test("an exact required, optional, and rest callback checks its default", () => {
      const table: CallableTable = {
        builtins: {
          inspect: {
            signatures: [
              {
                required: [
                  {
                    $fnType: {
                      required: [I],
                      optional: [S],
                      rest: B,
                      returns: I,
                    },
                  },
                ],
                optional: [],
                returns: I,
              },
            ],
          },
        },
      };
      const callback = {
        $params: ["n", { $param: "label", $default: false }, "...flags"],
        $return: { $var: "n" },
      };
      const r = checkExpr(call("inspect", callback), {}, table);

      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]", "$params[1]", "$default"],
          expected: S,
          actual: { const: false },
        }),
      ]);
    });

    test("a lambda at a non-function param position reports, not throws", () => {
      // Swapped args: the lambda lands on `map`'s array param. Previously this
      // destructured an absent `$fnType` and threw; it must be a diagnostic.
      const lambda = { $params: ["n"], $return: call("add", { $var: "n" }, 1) };
      const r = synthB(call("map", [1, 2, 3], lambda));
      expect(r.diagnostics.some((d) => d.path.join(".") === "$args[1]")).toBe(true);
      expect(r.diagnostics.some((d) => d.severity === "error")).toBe(true);
    });

    test("a wrong-arity call reports only the arity error, no lambda cascade", () => {
      // `map` with the array argument missing: `T` never binds, so the lambda
      // param would degrade to `any` and its body re-report. Only the arity
      // error should surface — the body/return check is suppressed.
      const addOne = { $params: ["n"], $return: call("add", { $var: "n" }, 1) };
      const r = synthB(call("map", addOne));
      expect(r.diagnostics.length).toBe(1);
      expect(/Expected exactly 2 arguments/.test(r.diagnostics[0]!.message)).toBe(true);
      expect(r.diagnostics.some((d) => d.path.join(".").includes("$return"))).toBe(false);
    });

    test("wrong arity suppresses callback checking but still traverses ordinary arguments", () => {
      const callback = {
        $params: ["n"],
        $return: { $var: "missingFromCallback" },
      };
      const r = synthB(
        call(
          "map",
          callback,
          { $var: "independentlyMissingArray" },
          { $var: "independentlyMissingExtra" },
        ),
      );

      expect(r.diagnostics.map(({ path, message }) => ({ path, message }))).toEqual([
        {
          path: [],
          message: "Expected exactly 2 arguments, got 3.",
        },
        {
          path: ["$args[1]"],
          message:
            'expression degraded to `any` because variable "independentlyMissingArray" is unresolved.',
        },
        {
          path: ["$args[2]"],
          message:
            'expression degraded to `any` because variable "independentlyMissingExtra" is unresolved.',
        },
      ]);
      expect(r.diagnostics.some((d) => d.path.includes("$return"))).toBe(false);
    });
  });

  describe("through the module checker", () => {
    const namedMapModule = (
      callbackParams: Schema[],
      callbackReturn: Schema,
      mainReturn: Schema,
    ): Record<string, JSONType> => ({
      callback: body(
        ["value"],
        { required: callbackParams, optional: [], returns: callbackReturn },
        { $var: "value" },
      ),
      main: body(
        [],
        { required: [], optional: [], returns: mainReturn },
        call("map", { $var: "callback" }, [1, 2]),
      ),
    });

    test("map/add flow an integer[] cleanly to a declared integer[] return", () => {
      const mod = {
        doubleAll: body(
          ["xs"],
          { required: [arrOfInt], optional: [], returns: arrOfInt },
          call(
            "map",
            { $params: ["n"], $return: call("add", { $var: "n" }, { $var: "n" }) },
            {
              $var: "xs",
            },
          ),
        ),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });

    test("a builtin result that mismatches the declared return is reported", () => {
      const strArr: Schema = { type: "array", items: S };
      const mod = {
        wrong: body(
          ["xs"],
          { required: [arrOfInt], optional: [], returns: strArr },
          call("map", { $params: ["n"], $return: { $var: "n" } }, { $var: "xs" }),
        ),
      };
      const diags = checkModule(mod, BT);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags[0]!.path).toEqual(["wrong", "$return"]);
    });

    test("accepts a named callback matching the final instantiated type", () => {
      expect(checkModule(namedMapModule([I], I, arrOfInt), BT)).toEqual([]);
    });

    test("accepts a contravariantly broader named callback", () => {
      const N: Schema = { type: "number" };
      const mod = {
        callback: body(
          ["value"],
          { required: [N], optional: [], returns: { type: "boolean" } },
          true,
        ),
        main: body(
          [],
          { required: [], optional: [], returns: arrOfInt },
          call("filter", { $var: "callback" }, [1, 2]),
        ),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });

    test("rejects a named callback narrower than the final data type", () => {
      const result = checkModule(namedMapModule([S], S, { type: "array", items: S }), BT);
      expect(result).toContainEqual(
        expect.objectContaining({
          path: ["main", "$return", "$args[0]"],
          actual: { $fnType: { required: [S], optional: [], returns: S } },
          expected: { $fnType: { required: [I], optional: [], returns: S } },
          severity: "error",
        }),
      );
    });

    test("infers a named callback's return into the map result", () => {
      const strArr: Schema = { type: "array", items: S };
      const mod = {
        callback: body(["value"], { required: [I], optional: [], returns: S }, "value"),
        main: body(
          [],
          { required: [], optional: [], returns: strArr },
          call("map", { $var: "callback" }, [1, 2]),
        ),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });
  });
});
