import { describe, expect, test } from "bun:test";
import {
  FUNCTION_BODY_FIELDS,
  FUNCTION_BODY_RUNTIME_FIELDS,
  FUNCTION_BODY_SOURCE_FIELDS,
  analyzeFunctionBodyStructure,
} from "../src/function-body-structure";
import { isFunctionBody } from "../src/function-value";

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
    expect(
      analyzeFunctionBodyStructure({
        $params: ["value"],
        $sig: { required: [true], optional: [], returns: true },
        $comment: "identity",
        $return: { $var: "value" },
      }),
    ).toEqual({ ok: true, issues: [] });

    expect(
      analyzeFunctionBodyStructure({
        $return: null,
        $captures: { helper: { $return: 1 } },
        $runtimeContract: {
          schema: { $fnType: { required: [], optional: [], returns: true } },
          defs: {},
          target: { $return: 1 },
        },
      }),
    ).toEqual({ ok: true, issues: [] });
  });

  test("reports every unsupported ordinary or reserved field", () => {
    const analysis = analyzeFunctionBodyStructure({
      local: 1,
      $types: {},
      $unknown: true,
      $return: null,
    });
    expect(analysis).toEqual({
      ok: false,
      issues: [
        { code: "unsupported-field", path: ["local"], field: "local" },
        { code: "unsupported-field", path: ["$types"], field: "$types" },
        { code: "unsupported-field", path: ["$unknown"], field: "$unknown" },
      ],
    });
  });

  test("reports malformed supported fields at precise relative paths", () => {
    const analysis = analyzeFunctionBodyStructure({
      $params: ["x", "x"],
      $comment: false,
      $captures: { valid: { $return: null }, invalid: 1 },
      $runtimeContract: { schema: true, defs: {}, target: 1 },
    });
    expect(analysis.ok).toBeFalse();
    if (analysis.ok) throw new Error("expected malformed body");
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
    expect(analyzeFunctionBodyStructure(malformed).ok).toBeFalse();
    expect(analyzeFunctionBodyStructure(null)).toEqual({
      ok: false,
      issues: [{ code: "not-object", path: [] }],
    });
  });
});
