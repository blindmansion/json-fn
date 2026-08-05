import { describe, expect, test } from "bun:test";
import { validateParseSuite } from "./parse-case-fixtures";

const successfulCase = {
  description: "parses null",
  source: "null",
  expected: null,
};

function suite(parseCase: unknown = successfulCase): unknown {
  return {
    $schema: "../parse.schema.json",
    description: "fixture validator test",
    cases: [parseCase],
  };
}

describe("parse-case fixture validation", () => {
  test.each([
    ["explicit expected null", successfulCase],
    ["unqualified failure", { description: "fails", source: "?", error: true }],
    ["message substring", { description: "fails", source: "?", error: "expected expression" }],
    [
      "structured message",
      {
        description: "fails",
        source: "?",
        error: { messageIncludes: "expected expression" },
      },
    ],
    [
      "structured position",
      { description: "fails", source: "?", error: { at: { line: 1, column: 1 } } },
    ],
    [
      "structured message and position",
      {
        description: "fails",
        source: "?",
        error: {
          messageIncludes: "expected expression",
          at: { line: 1, column: 1 },
        },
      },
    ],
  ])("accepts %s", (_name, parseCase) => {
    expect(() => validateParseSuite(suite(parseCase), "accepted.json")).not.toThrow();
  });

  test("accepts comments and mode defaults or overrides", () => {
    const value = {
      $schema: "../parse.schema.json",
      description: "modes and comments",
      comment: "suite rationale",
      mode: "module",
      cases: [
        {
          description: "expression override",
          comment: "case rationale",
          source: "null",
          mode: "expression",
          expected: null,
        },
      ],
    };
    expect(() => validateParseSuite(value, "comments.json")).not.toThrow();
  });

  test.each([
    ["non-object suite", null, "$ must be an object"],
    ["missing schema", { description: "suite", cases: [successfulCase] }, "$.$schema is required"],
    [
      "incorrect schema",
      { ...suiteObject(), $schema: "./parse.schema.json" },
      '$.$schema must equal "../parse.schema.json"',
    ],
    ["unknown suite field", { ...suiteObject(), extra: true }, "$.extra is not allowed"],
    ["invalid suite mode", { ...suiteObject(), mode: "script" }, "$.mode"],
    ["non-array cases", { ...suiteObject(), cases: {} }, "$.cases must be an array"],
    ["non-object case", suite(null), "$.cases[0] must be an object"],
    [
      "unknown case field",
      suite({ ...successfulCase, extra: true }),
      "$.cases[0].extra is not allowed",
    ],
    [
      "missing case description",
      suite({ source: "null", expected: null }),
      "$.cases[0].description is required",
    ],
    [
      "missing source",
      suite({ description: "missing source", expected: null }),
      "$.cases[0].source is required",
    ],
    ["invalid case mode", suite({ ...successfulCase, mode: "script" }), "$.cases[0].mode"],
    [
      "missing outcome",
      suite({ description: "no outcome", source: "null" }),
      "$.cases[0] must contain exactly one",
    ],
    [
      "conflicting outcomes",
      suite({ ...successfulCase, error: true }),
      "$.cases[0] must contain exactly one",
    ],
    [
      "invalid simple error",
      suite({ description: "fails", source: "?", error: false }),
      "$.cases[0].error must be true",
    ],
    [
      "empty structured error",
      suite({ description: "fails", source: "?", error: {} }),
      "$.cases[0].error must contain at least one",
    ],
    [
      "unknown structured error field",
      suite({ description: "fails", source: "?", error: { code: "parse" } }),
      "$.cases[0].error.code is not allowed",
    ],
    [
      "non-string message",
      suite({ description: "fails", source: "?", error: { messageIncludes: true } }),
      "$.cases[0].error.messageIncludes must be a string",
    ],
    [
      "unknown position field",
      suite({
        description: "fails",
        source: "?",
        error: { at: { line: 1, column: 1, offset: 0 } },
      }),
      "$.cases[0].error.at.offset is not allowed",
    ],
    [
      "missing position coordinate",
      suite({ description: "fails", source: "?", error: { at: { line: 1 } } }),
      "$.cases[0].error.at.column is required",
    ],
    [
      "non-integer position coordinate",
      suite({
        description: "fails",
        source: "?",
        error: { at: { line: 1, column: 1.5 } },
      }),
      "$.cases[0].error.at.column must be a positive integer",
    ],
    [
      "zero position coordinate",
      suite({
        description: "fails",
        source: "?",
        error: { at: { line: 0, column: 1 } },
      }),
      "$.cases[0].error.at.line must be a positive integer",
    ],
  ])("rejects %s", (_name, value, message) => {
    expect(() => validateParseSuite(value, "invalid.json")).toThrow(`invalid.json: ${message}`);
  });
});

function suiteObject(): Record<string, unknown> {
  return suite() as Record<string, unknown>;
}
