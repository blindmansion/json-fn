import { describe, expect, test } from "bun:test";
import {
  analyzeParameters,
  boundParameterNames,
  defaultBindings,
  formatParameterIssue,
  formatParameterPath,
} from "../src/params";
import type { ParameterIssueCode, ParameterPath } from "../src/params";

function layout(params: unknown) {
  const analysis = analyzeParameters(params);
  if (!analysis.ok) throw new Error(formatParameterIssue(analysis.issue));
  return analysis.layout;
}

describe("parameter analysis", () => {
  test("normalizes absent and empty parameter lists", () => {
    expect(layout(undefined)).toEqual({
      slots: [],
      fixedCount: 0,
      requiredCount: 0,
      omittableCount: 0,
      rest: null,
    });
    expect(layout([])).toEqual(layout(undefined));
  });

  test("normalizes every slot and field kind with source indexes", () => {
    const result = layout([
      "first",
      {
        $fields: [
          "requiredField",
          { $field: "optionalField", $optional: true },
          { $field: "defaultedField", $default: { $var: "first" } },
        ],
      },
      { $param: "defaulted", $default: 3 },
      { $param: "optional", $optional: true },
      "...rest",
    ]);

    expect(result).toEqual({
      slots: [
        { kind: "required", name: "first", index: 0 },
        {
          kind: "fields",
          index: 1,
          bindings: [
            { kind: "required", name: "requiredField", fieldIndex: 0 },
            { kind: "optional", name: "optionalField", fieldIndex: 1 },
            {
              kind: "defaulted",
              name: "defaultedField",
              fieldIndex: 2,
              defaultExpression: { $var: "first" },
            },
          ],
        },
        { kind: "defaulted", name: "defaulted", index: 2, defaultExpression: 3 },
        { kind: "optional", name: "optional", index: 3 },
        { kind: "rest", name: "rest", index: 4 },
      ],
      fixedCount: 4,
      requiredCount: 2,
      omittableCount: 2,
      rest: { kind: "rest", name: "rest", index: 4 },
    });
  });

  test("keeps object patterns required regardless of their field kinds", () => {
    const result = layout([
      { $fields: [{ $field: "first", $optional: true }] },
      { $fields: [{ $field: "second", $default: 2 }] },
      { $param: "last", $default: 3 },
    ]);

    expect(result.fixedCount).toBe(3);
    expect(result.requiredCount).toBe(2);
    expect(result.omittableCount).toBe(1);
  });

  test("derives bound names and defaults in canonical order", () => {
    const result = layout([
      "first",
      {
        $fields: [
          { $field: "fieldDefault", $default: 1 },
          "requiredField",
          { $field: "optionalField", $optional: true },
        ],
      },
      { $param: "paramDefault", $default: { $var: "fieldDefault" } },
      "...rest",
    ]);

    expect(boundParameterNames(result)).toEqual([
      "first",
      "fieldDefault",
      "requiredField",
      "optionalField",
      "paramDefault",
      "rest",
    ]);
    expect(defaultBindings(result)).toEqual([
      {
        name: "fieldDefault",
        expression: 1,
        path: [1, "$fields", 0, "$default"],
      },
      {
        name: "paramDefault",
        expression: { $var: "fieldDefault" },
        path: [2, "$default"],
      },
    ]);
  });

  test("formats structured paths and issues", () => {
    expect(formatParameterPath([])).toBe("$params");
    expect(formatParameterPath([1, "$fields", 2, "$default"])).toBe(
      "$params[1].$fields[2].$default",
    );

    const analysis = analyzeParameters([{ $param: "value", $optional: false }]);
    expect(analysis).toEqual({
      ok: false,
      issue: {
        code: "invalid-param-descriptor",
        path: [0, "$optional"],
        message: "$optional must be true.",
      },
    });
    if (analysis.ok) throw new Error("Expected parameter analysis to fail.");
    expect(formatParameterIssue(analysis.issue)).toBe(
      "$params[0].$optional: $optional must be true.",
    );
  });
});

type FailureCase = {
  name: string;
  params: unknown;
  code: ParameterIssueCode;
  path: ParameterPath;
  message: string;
};

const failureCases: FailureCase[] = [
  {
    name: "present non-array params",
    params: null,
    code: "params-not-array",
    path: [],
    message: "must be an array",
  },
  {
    name: "unknown primitive slot",
    params: [1],
    code: "invalid-slot",
    path: [0],
    message: "$params entries",
  },
  {
    name: "unknown object slot",
    params: [{ name: "value" }],
    code: "invalid-slot",
    path: [0],
    message: "$params entries",
  },
  {
    name: "missing parameter descriptor key",
    params: [{ $param: "value" }],
    code: "invalid-param-descriptor",
    path: [0],
    message: "exactly $param",
  },
  {
    name: "extra parameter descriptor key",
    params: [{ $param: "value", $default: 1, extra: true }],
    code: "invalid-param-descriptor",
    path: [0],
    message: "exactly $param",
  },
  {
    name: "mixed parameter descriptor forms",
    params: [{ $param: "value", $default: 1, $optional: true }],
    code: "invalid-param-descriptor",
    path: [0],
    message: "$optional: true",
  },
  {
    name: "non-string parameter name",
    params: [{ $param: 1, $default: 2 }],
    code: "invalid-param-name",
    path: [0, "$param"],
    message: "string parameter name",
  },
  {
    name: "descriptor-encoded positional rest",
    params: [{ $param: "...values", $default: [] }],
    code: "invalid-param-name",
    path: [0, "$param"],
    message: "cannot encode a rest parameter",
  },
  {
    name: "undefined positional default",
    params: [{ $param: "value", $default: undefined }],
    code: "invalid-param-descriptor",
    path: [0, "$default"],
    message: "cannot be undefined",
  },
  {
    name: "non-true positional optional marker",
    params: [{ $param: "value", $optional: "yes" }],
    code: "invalid-param-descriptor",
    path: [0, "$optional"],
    message: "must be true",
  },
  {
    name: "extra object-pattern key",
    params: [{ $fields: ["value"], extra: true }],
    code: "invalid-fields-pattern",
    path: [0],
    message: "exactly $fields",
  },
  {
    name: "non-array fields",
    params: [{ $fields: "value" }],
    code: "invalid-fields-pattern",
    path: [0, "$fields"],
    message: "non-empty array",
  },
  {
    name: "empty fields",
    params: [{ $fields: [] }],
    code: "invalid-fields-pattern",
    path: [0, "$fields"],
    message: "non-empty array",
  },
  {
    name: "unknown field entry",
    params: [{ $fields: [1] }],
    code: "invalid-field-descriptor",
    path: [0, "$fields", 0],
    message: "$fields entries",
  },
  {
    name: "missing field descriptor key",
    params: [{ $fields: [{ $field: "value" }] }],
    code: "invalid-field-descriptor",
    path: [0, "$fields", 0],
    message: "exactly $field",
  },
  {
    name: "extra field descriptor key",
    params: [{ $fields: [{ $field: "value", $default: 1, extra: true }] }],
    code: "invalid-field-descriptor",
    path: [0, "$fields", 0],
    message: "exactly $field",
  },
  {
    name: "non-string field name",
    params: [{ $fields: [{ $field: 1, $default: 2 }] }],
    code: "invalid-field-name",
    path: [0, "$fields", 0, "$field"],
    message: "string field name",
  },
  {
    name: "descriptor-encoded field rest",
    params: [{ $fields: [{ $field: "...values", $default: [] }] }],
    code: "invalid-field-name",
    path: [0, "$fields", 0, "$field"],
    message: "cannot encode a rest parameter",
  },
  {
    name: "undefined field default",
    params: [{ $fields: [{ $field: "value", $default: undefined }] }],
    code: "invalid-field-descriptor",
    path: [0, "$fields", 0, "$default"],
    message: "cannot be undefined",
  },
  {
    name: "non-true field optional marker",
    params: [{ $fields: [{ $field: "value", $optional: false }] }],
    code: "invalid-field-descriptor",
    path: [0, "$fields", 0, "$optional"],
    message: "must be true",
  },
  {
    name: "unnamed rest",
    params: ["..."],
    code: "invalid-param-name",
    path: [0],
    message: "non-empty name",
  },
  {
    name: "non-final rest",
    params: ["...values", "later"],
    code: "rest-not-final",
    path: [0],
    message: "final $params entry",
  },
  {
    name: "required parameter after default",
    params: [{ $param: "first", $default: 1 }, "later"],
    code: "required-after-omittable",
    path: [1],
    message: "must precede defaulted parameters",
  },
  {
    name: "required pattern after optional",
    params: [{ $param: "first", $optional: true }, { $fields: ["later"] }],
    code: "required-after-omittable",
    path: [1],
    message: "object pattern",
  },
  {
    name: "duplicate positional binding",
    params: ["same", { $param: "same", $default: 1 }],
    code: "duplicate-binding",
    path: [1, "$param"],
    message: "first declared at $params[0]",
  },
  {
    name: "duplicate fields in one pattern",
    params: [{ $fields: ["same", { $field: "same", $optional: true }] }],
    code: "duplicate-binding",
    path: [0, "$fields", 1, "$field"],
    message: "first declared at $params[0].$fields[0]",
  },
  {
    name: "duplicate across patterns",
    params: [{ $fields: ["same"] }, { $fields: [{ $field: "same", $default: 1 }] }],
    code: "duplicate-binding",
    path: [1, "$fields", 0, "$field"],
    message: "first declared at $params[0].$fields[0]",
  },
  {
    name: "duplicate rest binding",
    params: ["same", "...same"],
    code: "duplicate-binding",
    path: [1],
    message: "first declared at $params[0]",
  },
];

describe("parameter analysis failures", () => {
  for (const failure of failureCases) {
    test(failure.name, () => {
      const analysis = analyzeParameters(failure.params);
      expect(analysis.ok).toBeFalse();
      if (analysis.ok) throw new Error("Expected parameter analysis to fail.");
      expect(analysis.issue.code).toBe(failure.code);
      expect(analysis.issue.path).toEqual(failure.path);
      expect(analysis.issue.message).toContain(failure.message);
      expect(formatParameterIssue(analysis.issue)).toStartWith(
        `${formatParameterPath(failure.path)}: `,
      );
    });
  }
});
