import { describe, expect, test } from "bun:test";
import { loadBuiltinTable } from "../../src/builtins";
import type { JSONType } from "../../src/types";
import type { BuiltinTable, BuiltinTypeRuleRegistry } from "../../src";
import {
  BuiltinTypeRuleContractError,
  DuplicateBuiltinTypeRuleError,
  mergeBuiltinTypeRuleRegistries,
} from "../../src";
import { classifySchema, SchemaKind, type Schema } from "../../src/check/schema";
import { isSubschema } from "../../src/check/subsumption";
import { checkExpr, checkModule } from "../../src/check/module";
import { createStdlib } from "../../src/stdlib";

// Convenience: a `$sig`-annotated function body.
const body = (
  params: JSONType[],
  sig: { params: Schema[]; returns: Schema; rest?: Schema },
  ret: JSONType,
  locals: Record<string, JSONType> = {},
): Record<string, JSONType> => ({ $sig: sig, $params: params, ...locals, $return: ret });

const I: Schema = { type: "integer" };
const S: Schema = { type: "string" };

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
        { $fnType: { params: [{ type: "array" }], returns: I } },
        { $fnType: { params: [{ type: "string" }], returns: I } },
      ],
    });
    expect(d!.actual).toEqual({ $fnType: { params: [{ const: 123 }], returns: true } });
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
          'expression degraded to `any` because builtin rule "pipe" has no precise return type.',
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
            signatures: [{ params: [], returns: true }],
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
    const table: BuiltinTable = {
      builtins: {
        answer: {
          signatures: [{ params: [], returns: { type: "integer" } }],
          rule: "example.answer",
        },
      },
    };
    const typeRules: BuiltinTypeRuleRegistry = {
      "example.answer": () => ({ const: 42 }),
    };
    const result = checkExpr(call("answer"), {}, table, { typeRules });
    expect(result.type).toEqual({ const: 42 });
    expect(result.diagnostics).toEqual([]);
  });

  test("rule registry composition rejects duplicate identifiers", () => {
    const rule = () => true as Schema;
    expect(() =>
      mergeBuiltinTypeRuleRegistries({ "example.rule": rule }, { "example.rule": rule }),
    ).toThrow(DuplicateBuiltinTypeRuleError);
  });

  test("a rule result must remain inside its portable fallback", () => {
    const table: BuiltinTable = {
      builtins: {
        bad: {
          signatures: [{ params: [], returns: { type: "integer" } }],
          rule: "example.bad",
        },
      },
    };
    expect(() =>
      checkExpr(call("bad"), {}, table, {
        typeRules: { "example.bad": () => ({ type: "string" }) },
      }),
    ).toThrow(BuiltinTypeRuleContractError);
  });

  test("coverage: every stdlib builtin has a table entry", () => {
    const missing = Object.keys(createStdlib()).filter((name) => !(name in BT.builtins));
    expect(missing).toEqual([]);
  });

  describe("tier 1 — monomorphic & concrete overloads", () => {
    test("max/min preserve integer and widen to number", () => {
      expect(synthB(call("max", [1, 2, 3])).type).toEqual({ type: "integer" });
      expect(synthB(call("min", [1.5, 2])).type).toEqual({ type: "number" });
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

    test("log is identity on its value (both overloads)", () => {
      expect(synthB(call("log", "hi")).type).toEqual({ const: "hi" });
      expect(synthB(call("log", "hi", "label")).type).toEqual({ const: "hi" });
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
        { $params: ["n", "i"], $return: call("range", { $var: "n" }) },
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

    test("includes/indexOf pick the right arm", () => {
      const intOrNull = { type: ["integer", "null"] };
      expect(synthB(call("includes", [1, 2, 3], 2)).type).toEqual({ type: "boolean" });
      expect(synthB(call("includes", "hi", "h")).type).toEqual({ type: "boolean" });
      expect(isSubschema(synthB(call("indexOf", [1, 2, 3], 2)).type, intOrNull)).toBe(true);
      expect(isSubschema(synthB(call("indexOf", "hi", "h")).type, intOrNull)).toBe(true);
    });
  });

  describe("tier 3 — higher-order builtins", () => {
    test("reduce infers U from init and threads the accumulator", () => {
      const sum = {
        $params: ["acc", "n", "i"],
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
      const gtOne = { $params: ["n", "i"], $return: call("gt", { $var: "n" }, 1) };
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

    test("sort/sortBy preserve the element type", () => {
      const cmp = { $params: ["a", "b"], $return: call("sub", { $var: "a" }, { $var: "b" }) };
      expect(isSubschema(synthB(call("sort", cmp, [3, 1, 2])).type, arrOfInt)).toBe(true);
      const keyFn = { $params: ["n", "i"], $return: { $var: "n" } };
      expect(isSubschema(synthB(call("sortBy", keyFn, [3, 1, 2])).type, arrOfInt)).toBe(true);
    });

    test("groupBy accepts string and numeric keys and returns a map of T[]", () => {
      const stringKey = { $params: ["n", "i"], $return: call("str", { $var: "n" }) };
      const numericKey = {
        $params: ["n", "i"],
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
        $params: ["n", "i"],
        $return: call("concat", [{ $var: "n" }], [{ $var: "n" }]),
      };
      const r = synthB(call("flatMap", dup, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("flatMap retains and infers scalar callback returns", () => {
      const scalar = {
        $params: ["n", "i"],
        $return: call("add", { $var: "n" }, 1),
      };
      const r = synthB(call("flatMap", scalar, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(arrOfInt);
    });

    test("flatMap infers from an annotated callback return", () => {
      const callback = body(["n", "i"], { params: [I, I], returns: I }, { $var: "n" });
      const r = synthB(call("flatMap", callback, [1, 2, 3]));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(arrOfInt);
    });

    test("flatMap distributes one-level flattening across scalar-or-array unions", () => {
      const mixed = {
        $params: ["n", "i"],
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
        $params: ["n", "i"],
        $return: call("add", { $var: "n" }, { $var: "i" }),
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

    test("effect constructors return a Task ref; apply/handle/pipe yield any", () => {
      const TASK = { $ref: "#/$defs/Task" };
      expect(synthB(call("perform", "read", [])).type).toEqual(TASK);
      expect(synthB(call("pure", 1)).type).toEqual(TASK);
      expect(synthB(call("raise", "boom")).type).toEqual(TASK);
      const cont = { $params: ["x"], $return: call("pure", { $var: "x" }) };
      expect(synthB(call("bind", call("pure", 1), cont)).type).toEqual(TASK);
      expect(synthB(call("apply", { $params: ["n"], $return: { $var: "n" } }, [1])).type).toBe(
        true,
      );
      expect(synthB(call("pipe", [], 1)).type).toBe(true);
    });

    test("annotated handle returns its declared immediate result type", () => {
      const stateToReport: Schema = {
        $fnType: { params: [{ type: "object" }], returns: { type: "string" } },
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

    test("annotated handle requires a raw tractable schema", () => {
      const missingRaw = synthB(call("handle", call("pure", 1), {}, { type: "string" }));
      expect(missingRaw.type).toBe(true);
      expect(missingRaw.diagnostics.some((d) => d.path.join(".") === "$args[2]")).toBe(true);

      const opaque = synthB(call("handle", call("pure", 1), {}, { $raw: { unknown: true } }));
      expect(opaque.type).toBe(true);
      expect(opaque.diagnostics.some((d) => d.path.join(".") === "$args[2].$raw")).toBe(true);

      const nestedOpaque = synthB(
        call("handle", call("pure", 1), {}, { $raw: { type: "array", items: { unknown: true } } }),
      );
      expect(nestedOpaque.type).toBe(true);
      expect(nestedOpaque.diagnostics.some((d) => d.path.join(".") === "$args[2].$raw")).toBe(true);
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
    const structural: BuiltinTable = {
      builtins: {
        pairSecond: {
          signatures: [
            {
              typeParams: ["V"],
              params: [
                {
                  type: "array",
                  items: {
                    type: "array",
                    prefixItems: [S, T("V")],
                    items: false,
                  },
                },
              ],
              returns: T("V"),
            },
          ],
        },
        tupleRestValues: {
          signatures: [
            {
              typeParams: ["T"],
              params: [{ type: "array", prefixItems: [S], items: T("T") }],
              returns: { type: "array", items: T("T") },
            },
          ],
        },
        propertyValue: {
          signatures: [
            {
              typeParams: ["T"],
              params: [{ type: "object", properties: { payload: T("T") } }],
              returns: T("T"),
            },
          ],
        },
        objectValues: {
          signatures: [
            {
              typeParams: ["V"],
              params: [{ type: "object", additionalProperties: T("V") }],
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
            { params: [{ $ref: "#/$defs/Maps" }], returns: vals },
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
            { params: [{ type: "object" }], returns: { type: "array" } },
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
    const callbackReturn = (returns: Schema): BuiltinTable => ({
      builtins: {
        testCallback: {
          signatures: [
            {
              typeParams: ["U"],
              params: [{ $fnType: { params: [], returns } }],
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
      body(["a"], { params: [refA], returns: refA }, call("merge", { $var: "a" }, rhs));

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
        body(["m"], { params: [refM], returns: refM }, call("merge", { $var: "m" }, rhs));
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
      body(["es"], { params: [param], returns }, call("fromEntries", { $var: "es" }));

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
      body(["o"], { params: [param], returns }, call("values", { $var: "o" }));
    const eBody = (param: Schema, returns: Schema) =>
      body(["o"], { params: [param], returns }, call("entries", { $var: "o" }));

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
            'expression degraded to `any` because builtin rule "pipe" has no precise return type.',
          severity: "info",
        },
      ]);
    });

    test("effectful functions can carry a Task / any return", () => {
      const perform = call("perform", "e", []);
      const fn = (returns: Schema): JSONType => ({
        $params: [],
        $sig: { params: [], returns },
        $return: perform,
      });
      const noErr = (mod: JSONType) =>
        checkModule(mod as Record<string, JSONType>, BT).filter((d) => d.severity === "error");
      // `-> any`
      expect(noErr({ f: fn(true) })).toEqual([]);
      // `-> Task` aliased to any
      expect(noErr({ $types: { Task: true }, f: fn({ $ref: "#/$defs/Task" }) })).toEqual([]);
      // `-> Task` aliased to the structural task record
      const structural = {
        type: "object",
        properties: { "@task": { type: "string" } },
        required: ["@task"],
      };
      expect(noErr({ $types: { Task: structural }, f: fn({ $ref: "#/$defs/Task" }) })).toEqual([]);
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
      const identity = { $params: ["v"], $return: { $var: "v" } };
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
      const inc = { $params: ["v"], $return: call("add", { $var: "v" }, 1) };
      const mod = {
        transform: body(
          ["obj"],
          { params: [mapOfInt], returns: mapOfInt },
          call("mapValues", inc, { $var: "obj" }),
        ),
      };
      expect(checkModule(mod, BT).filter((d) => d.severity === "error")).toEqual([]);
    });

    test("keeps a precise callback result for an open input object", () => {
      const constant = { $params: ["v"], $return: "ok" };
      const mod = {
        transform: body(
          ["obj"],
          { params: [{ type: "object" }], returns: mapOf({ const: "ok" }) },
          call("mapValues", constant, { $var: "obj" }),
        ),
      };
      expect(checkModule(mod, BT).filter((d) => d.severity === "error")).toEqual([]);
    });

    test("reports an annotated callback whose body violates its declared return", () => {
      const bad = body(["v", "k"], { params: [I, S], returns: S }, { $var: "v" });
      const r = synthB(call("mapValues", bad, { a: 1 }));
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]", "$return"],
          severity: "error",
        }),
      );
    });

    test("an empty closed record gives the callback a never value", () => {
      const inc = { $params: ["v"], $return: call("add", { $var: "v" }, 1) };
      const r = synthB(call("mapValues", inc, {}));
      expect(r.diagnostics).toEqual([]);
      expect(r.type).toEqual(mapOf(I));
    });
  });

  describe("contextual lambda typing", () => {
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
      const callback = body(["n", "i"], { params: [S, I], returns: I }, 1);
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({
          path: ["$args[0]"],
          actual: { $fnType: { params: [S, I], returns: I } },
          expected: { $fnType: { params: [I, I], returns: I } },
          severity: "error",
        }),
      );
    });

    test("a compatibly annotated callback remains valid and precise", () => {
      const callback = body(["n", "i"], { params: [I, I], returns: I }, { $var: "n" });
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("a bare callback may omit trailing supplied parameters", () => {
      const callback = { $params: ["n"], $return: { $var: "n" } };
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrOfInt)).toBe(true);
    });

    test("a bare callback rejects more fixed parameters than the builtin supplies", () => {
      const callback = {
        $params: ["n", "i", "extra"],
        $return: call("add", { $var: "extra" }, 1),
      };
      const r = synthB(call("map", callback, [10, 20]));
      expect(r.diagnostics).toEqual([
        expect.objectContaining({
          path: ["$args[0]"],
          message: expect.stringContaining("declares 3 fixed parameter(s)"),
          severity: "error",
        }),
      ]);
    });

    test("a bare callback rest parameter collects remaining supplied types", () => {
      const callback = { $params: ["n", "...rest"], $return: { $var: "rest" } };
      const r = synthB(call("map", callback, [10, 20]));
      const arrayOfArraysOfInt: Schema = {
        type: "array",
        items: { type: "array", items: I },
      };
      expect(r.diagnostics).toEqual([]);
      expect(isSubschema(r.type, arrayOfArraysOfInt)).toBe(true);
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
      expect(/Expected 2 argument/.test(r.diagnostics[0]!.message)).toBe(true);
      expect(r.diagnostics.some((d) => d.path.join(".").includes("$return"))).toBe(false);
    });
  });

  describe("through the module checker", () => {
    const namedMapModule = (
      callbackParams: Schema[],
      callbackReturn: Schema,
      mainReturn: Schema,
    ): Record<string, JSONType> => ({
      callback: body(
        ["value", "index"],
        { params: callbackParams, returns: callbackReturn },
        { $var: "value" },
      ),
      main: body(
        [],
        { params: [], returns: mainReturn },
        call("map", { $var: "callback" }, [1, 2]),
      ),
    });

    test("map/add flow an integer[] cleanly to a declared integer[] return", () => {
      const mod = {
        doubleAll: body(
          ["xs"],
          { params: [arrOfInt], returns: arrOfInt },
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
          { params: [arrOfInt], returns: strArr },
          call("map", { $params: ["n"], $return: { $var: "n" } }, { $var: "xs" }),
        ),
      };
      const diags = checkModule(mod, BT);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags[0]!.path).toEqual(["wrong", "$return"]);
    });

    test("accepts a named callback matching the final instantiated type", () => {
      expect(checkModule(namedMapModule([I, I], I, arrOfInt), BT)).toEqual([]);
    });

    test("accepts a contravariantly broader named callback", () => {
      const N: Schema = { type: "number" };
      const mod = {
        callback: body(["value", "index"], { params: [N, I], returns: { type: "boolean" } }, true),
        main: body(
          [],
          { params: [], returns: arrOfInt },
          call("filter", { $var: "callback" }, [1, 2]),
        ),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });

    test("rejects a named callback narrower than the final data type", () => {
      const result = checkModule(namedMapModule([S, I], S, { type: "array", items: S }), BT);
      expect(result).toContainEqual(
        expect.objectContaining({
          path: ["main", "$return", "$args[0]"],
          actual: { $fnType: { params: [S, I], returns: S } },
          expected: { $fnType: { params: [I, I], returns: S } },
          severity: "error",
        }),
      );
    });

    test("infers a named callback's return into the map result", () => {
      const strArr: Schema = { type: "array", items: S };
      const mod = {
        callback: body(["value", "index"], { params: [I, I], returns: S }, "value"),
        main: body([], { params: [], returns: strArr }, call("map", { $var: "callback" }, [1, 2])),
      };
      expect(checkModule(mod, BT)).toEqual([]);
    });
  });
});
