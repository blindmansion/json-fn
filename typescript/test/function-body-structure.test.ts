import { describe, expect, test } from "bun:test";
import { callFunction, createStdlib } from "../src";
import {
  FUNCTION_BODY_FIELDS,
  FUNCTION_BODY_RUNTIME_FIELDS,
  FUNCTION_BODY_SOURCE_FIELDS,
  analyzeFunctionBodyStructure,
} from "../src/function-body-structure";
import { isFunctionBody } from "../src/function-value";
import type { FunctionBody, FunctionDeclaration, FunctionRegistry } from "../src/types";

describe("function body structure", () => {
  test("centralizes source and runtime field vocabulary", () => {
    expect([...FUNCTION_BODY_SOURCE_FIELDS]).toEqual(["$return", "$params", "$sig", "$comment"]);
    expect([...FUNCTION_BODY_RUNTIME_FIELDS]).toEqual(["$captures", "$runtimeContract"]);
    expect([...FUNCTION_BODY_FIELDS]).toEqual([
      "$return",
      "$params",
      "$sig",
      "$comment",
      "$captures",
      "$runtimeContract",
    ]);
    expect(FUNCTION_BODY_FIELDS.has("$types")).toBeFalse();
  });

  test("accepts source bodies and readable evaluator-owned state", () => {
    const sourceAnalysis = analyzeFunctionBodyStructure({
      $params: ["value"],
      $sig: { required: [true], optional: [], returns: true },
      $comment: "identity",
      $return: { $var: "value" },
    });
    expect(sourceAnalysis.issues).toEqual([]);
    expect(sourceAnalysis.layout?.requiredCount).toBe(1);

    const runtimeAnalysis = analyzeFunctionBodyStructure({
      $return: null,
      $captures: { helper: { $return: 1 } },
      $runtimeContract: {
        schema: { $fnType: { required: [], optional: [], returns: true } },
        defs: {},
        target: { $return: 1 },
      },
    });
    expect(runtimeAnalysis.issues).toEqual([]);
    expect(runtimeAnalysis.captures).toEqual({ helper: { $return: 1 } });
  });

  test("reports every unsupported ordinary or reserved field", () => {
    const analysis = analyzeFunctionBodyStructure({
      local: 1,
      $types: {},
      $unknown: true,
      $return: null,
    });
    expect(analysis.issues).toEqual([
      { code: "unsupported-field", path: ["local"], field: "local" },
      { code: "unsupported-field", path: ["$types"], field: "$types" },
      { code: "unsupported-field", path: ["$unknown"], field: "$unknown" },
    ]);
  });

  test("reports malformed supported fields at precise relative paths", () => {
    const analysis = analyzeFunctionBodyStructure({
      $params: ["x", "x"],
      $comment: false,
      $captures: { valid: { $return: null }, invalid: 1 },
      $runtimeContract: { schema: true, defs: {}, target: 1 },
    });
    expect(analysis.issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "missing-return", path: [] },
      { code: "invalid-comment", path: ["$comment"] },
      { code: "invalid-params", path: ["$params", 1] },
      { code: "invalid-capture", path: ["$captures", "invalid"] },
      { code: "invalid-runtime-contract", path: ["$runtimeContract"] },
    ]);
  });

  test("keeps body recognition separate from validity", () => {
    const malformed = { local: 1, $return: null };
    expect(isFunctionBody(malformed)).toBeTrue();
    expect(analyzeFunctionBodyStructure(malformed).issues).not.toEqual([]);
    expect(analyzeFunctionBodyStructure(null).issues).toEqual([{ code: "not-object", path: [] }]);
  });
});

describe("function body structural boundaries", () => {
  // Checker-observable structural-boundary cases (stray fields, continued
  // checking through supported fields, malformed supported fields,
  // unannotated-body rejection, module-root behavior) live in the shared
  // conformance suite at `spec/cases/check/functions/body-structure.json`.
  const stdlib = createStdlib();

  test("evaluator uses the same stray-field validation for expression and registry functions", () => {
    const ordinary = { local: 1, $return: null } as unknown as FunctionBody;
    const reserved = { $unknown: true, $return: null } as unknown as FunctionDeclaration;
    const registry: FunctionRegistry = { ...stdlib, bad: ordinary };

    expect(() => callFunction({ $return: reserved }, [], stdlib)).toThrow(
      'Function body field "$unknown" is not supported.',
    );
    expect(() => callFunction("bad", [], registry)).toThrow(
      'Function body field "local" is not supported.',
    );
  });
});
