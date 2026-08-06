// Validator tests for the shared checker conformance format. Every sample is
// run through the runtime validator, and the same corpus is replayed against
// `spec/cases/check.schema.json` compiled with AJV so the JSON Schema and the
// runtime validator cannot silently drift apart. Samples that only the
// runtime validator can reject (depth-relative `$schema` verification and
// deep environment-contract validation) are flagged `runtimeOnly`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Ajv2020 } from "ajv/dist/2020";
import { validateCheckSuite } from "./check-case-fixtures";

const SCHEMA_PATH = join(import.meta.dir, "../../spec/cases/check.schema.json");
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const matchesJsonSchema = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

const cleanExpression = {
  description: "synthesizes an integer literal",
  expression: 1,
  expected: { type: { type: "integer" }, diagnostics: [] },
};

const cleanModule = {
  description: "checks a typed module function",
  module: {
    main: {
      $params: [],
      $sig: { required: [], optional: [], returns: { type: "integer" } },
      $return: 1,
    },
  },
  expected: { diagnostics: [] },
};

const errorDiagnostic = {
  path: ["f", "$return"],
  severity: "error",
  messageIncludes: "not assignable",
  expected: { type: "integer" },
  actual: { const: "wrong" },
};

const minimalContract = {
  version: 1,
  entry: { name: "main", required: [], optional: [], returns: { type: "integer" } },
};

function suite(checkCase: unknown = cleanExpression, extra: Record<string, unknown> = {}): unknown {
  return {
    $schema: "../check.schema.json",
    description: "fixture validator test",
    builtins: "none",
    cases: [checkCase],
    ...extra,
  };
}

function suiteObject(): Record<string, unknown> {
  return suite() as Record<string, unknown>;
}

type AcceptedSample = { name: string; value: unknown; depth?: number };

const accepted: AcceptedSample[] = [
  { name: "clean expression with inferred type", value: suite() },
  { name: "clean module", value: suite(cleanModule) },
  {
    name: "expression without an inferred type",
    value: suite({ ...cleanExpression, expected: { diagnostics: [] } }),
  },
  {
    name: "explicit null expression",
    value: suite({ ...cleanExpression, expression: null, expected: { diagnostics: [] } }),
  },
  {
    name: "populated diagnostics with schema fields",
    value: suite({
      description: "reports a mismatch",
      expression: 1,
      expected: { diagnostics: [errorDiagnostic] },
    }),
  },
  {
    name: "information-level degradation diagnostic",
    value: suite({
      description: "records coverage loss",
      expression: 1,
      expected: {
        diagnostics: [{ path: [], severity: "info", messageIncludes: "no declared signature" }],
      },
    }),
  },
  {
    name: "portable throws outcome",
    value: suite({
      description: "exceeds the structural depth limit",
      expression: 1,
      throws: { messageIncludes: "Maximum structural depth" },
    }),
  },
  {
    name: "expression case with defs",
    value: suite({ ...cleanExpression, defs: { Id: { type: "integer" }, Any: true } }),
  },
  {
    name: "module case with an inline contract",
    value: suite({ ...cleanModule, contract: minimalContract }),
  },
  { name: "standard builtins suite", value: suite(cleanExpression, { builtins: "standard" }) },
  {
    name: "case-level builtins and options overrides",
    value: suite({
      ...cleanModule,
      builtins: "standard",
      options: { allowUntypedFunctions: true },
    }),
  },
  {
    name: "suite-level options and comments",
    value: suite(
      { ...cleanExpression, comment: "case rationale" },
      { comment: "suite rationale", options: { allowUntypedFunctions: false } },
    ),
  },
  {
    name: "nested suite with a depth-relative $schema",
    value: { ...suiteObject(), $schema: "../../check.schema.json" },
    depth: 1,
  },
];

type RejectedSample = {
  name: string;
  value: unknown;
  message: string;
  depth?: number;
  // Enforced only by the runtime validator (depth-exact `$schema`
  // verification and deep contract validation); the JSON Schema accepts it.
  runtimeOnly?: boolean;
};

const rejected: RejectedSample[] = [
  { name: "non-object suite", value: null, message: "$ must be an object" },
  {
    name: "missing $schema",
    value: { description: "suite", builtins: "none", cases: [] },
    message: "$.$schema is required",
  },
  {
    name: "incorrect $schema",
    value: { ...suiteObject(), $schema: "./check.schema.json" },
    message: '$.$schema must equal "../check.schema.json"',
  },
  {
    name: "depth-mismatched $schema",
    value: { ...suiteObject(), $schema: "../../check.schema.json" },
    message: '$.$schema must equal "../check.schema.json"',
    runtimeOnly: true,
  },
  {
    name: "unknown suite field",
    value: { ...suiteObject(), extra: true },
    message: "$.extra is not allowed",
  },
  {
    name: "missing suite builtins",
    value: (() => {
      const { builtins, ...rest } = suiteObject();
      void builtins;
      return rest;
    })(),
    message: "$.builtins is required",
  },
  {
    name: "invalid suite builtins",
    value: { ...suiteObject(), builtins: "custom" },
    message: '$.builtins must be "standard" or "none"',
  },
  {
    name: "non-array cases",
    value: { ...suiteObject(), cases: {} },
    message: "$.cases must be an array",
  },
  {
    name: "unknown suite option",
    value: { ...suiteObject(), options: { strict: true } },
    message: "$.options.strict is not allowed",
  },
  {
    name: "non-boolean option value",
    value: { ...suiteObject(), options: { allowUntypedFunctions: "yes" } },
    message: "$.options.allowUntypedFunctions must be a boolean",
  },
  { name: "non-object case", value: suite(null), message: "$.cases[0] must be an object" },
  {
    name: "unknown case field",
    value: suite({ ...cleanExpression, extra: true }),
    message: "$.cases[0].extra is not allowed",
  },
  {
    name: "missing case description",
    value: suite({ expression: 1, expected: { diagnostics: [] } }),
    message: "$.cases[0].description is required",
  },
  {
    name: "invalid case builtins",
    value: suite({ ...cleanExpression, builtins: "custom" }),
    message: '$.cases[0].builtins must be "standard" or "none"',
  },
  {
    name: "unknown case option",
    value: suite({ ...cleanExpression, options: { requireFullCoverage: true } }),
    message: "$.cases[0].options.requireFullCoverage is not allowed",
  },
  {
    name: "missing input",
    value: suite({ description: "no input", expected: { diagnostics: [] } }),
    message: "$.cases[0] must contain exactly one of 'expression' or 'module'",
  },
  {
    name: "conflicting inputs",
    value: suite({ ...cleanExpression, module: cleanModule.module }),
    message: "$.cases[0] must contain exactly one of 'expression' or 'module'",
  },
  {
    name: "non-object module",
    value: suite({ description: "bad module", module: [], expected: { diagnostics: [] } }),
    message: "$.cases[0].module must be an object",
  },
  {
    name: "contract on an expression case",
    value: suite({ ...cleanExpression, contract: minimalContract }),
    message: "$.cases[0].contract is only allowed on module cases",
  },
  {
    name: "defs on a module case",
    value: suite({ ...cleanModule, defs: { Id: { type: "integer" } } }),
    message: "$.cases[0].defs is only allowed on expression cases",
  },
  {
    name: "non-schema defs entry",
    value: suite({ ...cleanExpression, defs: { Id: 7 } }),
    message: "$.cases[0].defs.Id must be a boolean or object schema",
  },
  {
    name: "non-object contract",
    value: suite({ ...cleanModule, contract: [] }),
    message: "$.cases[0].contract is not a valid environment contract",
  },
  {
    name: "semantically invalid contract",
    value: suite({ ...cleanModule, contract: { ...minimalContract, version: 99 } }),
    message: "$.cases[0].contract is not a valid environment contract",
    runtimeOnly: true,
  },
  {
    name: "missing outcome",
    value: suite({ description: "no outcome", expression: 1 }),
    message: "$.cases[0] must contain exactly one of 'expected' or 'throws'",
  },
  {
    name: "conflicting outcomes",
    value: suite({ ...cleanExpression, throws: { messageIncludes: "boom" } }),
    message: "$.cases[0] must contain exactly one of 'expected' or 'throws'",
  },
  {
    name: "non-object expected",
    value: suite({ description: "bad expected", expression: 1, expected: [] }),
    message: "$.cases[0].expected must be an object",
  },
  {
    name: "unknown expected field",
    value: suite({ ...cleanExpression, expected: { diagnostics: [], valid: true } }),
    message: "$.cases[0].expected.valid is not allowed",
  },
  {
    name: "missing diagnostics",
    value: suite({ ...cleanExpression, expected: { type: { type: "integer" } } }),
    message: "$.cases[0].expected.diagnostics is required",
  },
  {
    name: "non-array diagnostics",
    value: suite({ ...cleanExpression, expected: { diagnostics: {} } }),
    message: "$.cases[0].expected.diagnostics must be an array",
  },
  {
    name: "inferred type on a module case",
    value: suite({
      ...cleanModule,
      expected: { type: { type: "integer" }, diagnostics: [] },
    }),
    message: "$.cases[0].expected.type is only allowed on expression cases",
  },
  {
    name: "non-schema inferred type",
    value: suite({ ...cleanExpression, expected: { type: 3, diagnostics: [] } }),
    message: "$.cases[0].expected.type must be a boolean or object schema",
  },
  {
    name: "non-object diagnostic",
    value: suite({ ...cleanExpression, expected: { diagnostics: [null] } }),
    message: "$.cases[0].expected.diagnostics[0] must be an object",
  },
  {
    name: "unknown diagnostic field",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, code: "E001" }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].code is not allowed",
  },
  {
    name: "missing diagnostic path",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ severity: "error", messageIncludes: "bad" }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].path is required",
  },
  {
    name: "non-string diagnostic path segment",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, path: ["f", 0] }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].path must be an array of strings",
  },
  {
    name: "invalid diagnostic severity",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, severity: "warning" }] },
    }),
    message: '$.cases[0].expected.diagnostics[0].severity must be "error" or "info"',
  },
  {
    name: "missing diagnostic message",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ path: [], severity: "error" }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].messageIncludes is required",
  },
  {
    name: "non-string diagnostic message",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, messageIncludes: 5 }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].messageIncludes must be a string",
  },
  {
    name: "non-schema diagnostic expected field",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, expected: "integer" }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].expected must be a boolean or object schema",
  },
  {
    name: "non-schema diagnostic actual field",
    value: suite({
      ...cleanExpression,
      expected: { diagnostics: [{ ...errorDiagnostic, actual: ["wrong"] }] },
    }),
    message: "$.cases[0].expected.diagnostics[0].actual must be a boolean or object schema",
  },
  {
    name: "non-object throws",
    value: suite({ description: "bad throws", expression: 1, throws: "boom" }),
    message: "$.cases[0].throws must be an object",
  },
  {
    name: "unknown throws field",
    value: suite({
      description: "bad throws",
      expression: 1,
      throws: { messageIncludes: "boom", code: "DEPTH" },
    }),
    message: "$.cases[0].throws.code is not allowed",
  },
  {
    name: "missing throws message",
    value: suite({ description: "bad throws", expression: 1, throws: {} }),
    message: "$.cases[0].throws.messageIncludes is required",
  },
];

describe("check-case fixture validation", () => {
  test.each(accepted.map((sample) => [sample.name, sample] as const))(
    "accepts %s",
    (_name, sample) => {
      expect(() =>
        validateCheckSuite(sample.value, "accepted.json", sample.depth ?? 0),
      ).not.toThrow();
    },
  );

  test.each(rejected.map((sample) => [sample.name, sample] as const))(
    "rejects %s",
    (_name, sample) => {
      expect(() => validateCheckSuite(sample.value, "invalid.json", sample.depth ?? 0)).toThrow(
        `invalid.json: ${sample.message}`,
      );
    },
  );
});

// The JSON Schema and the runtime validator must accept and reject the same
// corpus, so schema drift cannot silently broaden the fixture language.
describe("check-case JSON Schema agreement", () => {
  test.each(accepted.map((sample) => [sample.name, sample] as const))(
    "JSON Schema accepts %s",
    (_name, sample) => {
      expect(matchesJsonSchema(sample.value)).toBe(true);
    },
  );

  test.each(rejected.map((sample) => [sample.name, sample] as const))(
    "JSON Schema agrees on %s",
    (_name, sample) => {
      expect(matchesJsonSchema(sample.value)).toBe(sample.runtimeOnly === true);
    },
  );
});
