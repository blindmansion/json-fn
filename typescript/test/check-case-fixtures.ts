// Typed loader and runtime validator for the shared checker conformance
// format documented by `spec/cases/check.schema.json`. Follows the hardened
// parse-suite pattern (`parse-case-fixtures.ts`): malformed fixtures fail with
// the fixture path and failing field before any test is registered. The
// validator uses only public entry points — no checker internals.

import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import type { JSONType } from "../src/types";
import { loadBuiltinTable, validateEnvironmentContract } from "../src";

export type BuiltinsSelection = "standard" | "none";

export type DiagnosticSeverity = "error" | "info";

export interface CheckCaseOptions {
  allowUntypedFunctions?: boolean;
}

export interface DiagnosticMatcher {
  path: string[];
  severity: DiagnosticSeverity;
  messageIncludes: string;
  expected?: JSONType;
  actual?: JSONType;
}

export interface ExpectedOutcome {
  type?: JSONType;
  diagnostics: DiagnosticMatcher[];
}

export interface ThrowsExpectation {
  messageIncludes: string;
}

interface CheckCaseBase {
  description: string;
  comment?: string;
  builtins?: BuiltinsSelection;
  options?: CheckCaseOptions;
}

export type CheckCase = CheckCaseBase &
  (
    | { expression: JSONType; defs?: Record<string, JSONType>; module?: never; contract?: never }
    | { module: Record<string, JSONType>; contract?: JSONType; expression?: never; defs?: never }
  ) &
  ({ expected: ExpectedOutcome; throws?: never } | { expected?: never; throws: ThrowsExpectation });

export interface CheckSuite {
  $schema: "../check.schema.json" | "../../check.schema.json";
  description: string;
  comment?: string;
  builtins: BuiltinsSelection;
  options?: CheckCaseOptions;
  cases: CheckCase[];
}

const SUITE_FIELDS = new Set(["$schema", "description", "comment", "builtins", "options", "cases"]);
const CASE_FIELDS = new Set([
  "description",
  "comment",
  "builtins",
  "options",
  "expression",
  "defs",
  "module",
  "contract",
  "expected",
  "throws",
]);
const OPTION_FIELDS = new Set(["allowUntypedFunctions"]);
const EXPECTED_FIELDS = new Set(["type", "diagnostics"]);
const DIAGNOSTIC_FIELDS = new Set(["path", "severity", "messageIncludes", "expected", "actual"]);
const THROWS_FIELDS = new Set(["messageIncludes"]);

export function loadCheckSuite(path: string, depth = 0): CheckSuite {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: invalid JSON: ${message}`);
  }
  validateCheckSuite(value, path, depth);
  return value;
}

// Recursively load every suite below `dir`. Suites may sit directly below the
// root or exactly one directory level deeper; their `$schema` must spell the
// depth-exact relative path to `check.schema.json`.
export function loadCheckSuites(dir: string): CheckSuite[] {
  return collectCaseFiles(dir).map((path) => {
    const depth = relative(dir, path).split(sep).length - 1;
    if (depth > 1) {
      throw new Error(`${path}: check suites must be at most one directory level below ${dir}`);
    }
    return loadCheckSuite(path, depth);
  });
}

function collectCaseFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectCaseFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

export function validateCheckSuite(
  value: unknown,
  path = "<check suite>",
  depth = 0,
): asserts value is CheckSuite {
  assertRecord(value, path, "$");
  assertKnownFields(value, SUITE_FIELDS, path, "$");
  assertField(value, "$schema", path, "$");
  const expectedSchema = `${"../".repeat(depth + 1)}check.schema.json`;
  if (value.$schema !== expectedSchema) {
    fail(path, "$.$schema", `must equal "${expectedSchema}"`);
  }
  assertStringField(value, "description", path, "$");
  assertOptionalStringField(value, "comment", path, "$");
  assertField(value, "builtins", path, "$");
  assertBuiltins(value.builtins, path, "$.builtins");
  if (Object.hasOwn(value, "options")) validateOptions(value.options, path, "$.options");
  assertField(value, "cases", path, "$");
  if (!Array.isArray(value.cases)) fail(path, "$.cases", "must be an array");

  const suiteBuiltins = value.builtins as BuiltinsSelection;
  for (const [index, checkCase] of value.cases.entries()) {
    validateCheckCase(checkCase, path, `$.cases[${index}]`, suiteBuiltins);
  }
}

function validateCheckCase(
  value: unknown,
  fixturePath: string,
  fieldPath: string,
  suiteBuiltins: BuiltinsSelection,
): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, CASE_FIELDS, fixturePath, fieldPath);
  assertStringField(value, "description", fixturePath, fieldPath);
  assertOptionalStringField(value, "comment", fixturePath, fieldPath);
  let builtins = suiteBuiltins;
  if (Object.hasOwn(value, "builtins")) {
    assertBuiltins(value.builtins, fixturePath, `${fieldPath}.builtins`);
    builtins = value.builtins as BuiltinsSelection;
  }
  if (Object.hasOwn(value, "options")) {
    validateOptions(value.options, fixturePath, `${fieldPath}.options`);
  }

  const hasExpression = Object.hasOwn(value, "expression");
  const hasModule = Object.hasOwn(value, "module");
  if (hasExpression === hasModule) {
    fail(fixturePath, fieldPath, "must contain exactly one of 'expression' or 'module'");
  }
  if (hasExpression) {
    if (Object.hasOwn(value, "contract")) {
      fail(fixturePath, `${fieldPath}.contract`, "is only allowed on module cases");
    }
    if (Object.hasOwn(value, "defs")) {
      validateDefs(value.defs, fixturePath, `${fieldPath}.defs`);
    }
  } else {
    if (!isRecord(value.module)) fail(fixturePath, `${fieldPath}.module`, "must be an object");
    if (Object.hasOwn(value, "defs")) {
      fail(fixturePath, `${fieldPath}.defs`, "is only allowed on expression cases");
    }
    if (Object.hasOwn(value, "contract")) {
      validateContract(value.contract, builtins, fixturePath, `${fieldPath}.contract`);
    }
  }

  const hasExpected = Object.hasOwn(value, "expected");
  const hasThrows = Object.hasOwn(value, "throws");
  if (hasExpected === hasThrows) {
    fail(fixturePath, fieldPath, "must contain exactly one of 'expected' or 'throws'");
  }
  if (hasExpected) {
    validateExpected(value.expected, hasExpression, fixturePath, `${fieldPath}.expected`);
  }
  if (hasThrows) validateThrows(value.throws, fixturePath, `${fieldPath}.throws`);
}

function validateDefs(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  for (const [name, schema] of Object.entries(value)) {
    if (!isSchemaValue(schema)) {
      fail(fixturePath, `${fieldPath}.${name}`, "must be a boolean or object schema");
    }
  }
}

// Deep-validate an inline environment contract at load time through the
// public validator, resolving names against the case's effective builtin
// selection — the same table the runner will link against.
function validateContract(
  value: unknown,
  builtins: BuiltinsSelection,
  fixturePath: string,
  fieldPath: string,
): void {
  try {
    validateEnvironmentContract(value, builtins === "standard" ? loadBuiltinTable() : false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(fixturePath, fieldPath, `is not a valid environment contract: ${message}`);
  }
}

function validateExpected(
  value: unknown,
  isExpressionCase: boolean,
  fixturePath: string,
  fieldPath: string,
): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, EXPECTED_FIELDS, fixturePath, fieldPath);
  if (Object.hasOwn(value, "type")) {
    if (!isExpressionCase) {
      fail(fixturePath, `${fieldPath}.type`, "is only allowed on expression cases");
    }
    if (!isSchemaValue(value.type)) {
      fail(fixturePath, `${fieldPath}.type`, "must be a boolean or object schema");
    }
  }
  assertField(value, "diagnostics", fixturePath, fieldPath);
  if (!Array.isArray(value.diagnostics)) {
    fail(fixturePath, `${fieldPath}.diagnostics`, "must be an array");
  }
  for (const [index, diagnostic] of value.diagnostics.entries()) {
    validateDiagnostic(diagnostic, fixturePath, `${fieldPath}.diagnostics[${index}]`);
  }
}

function validateDiagnostic(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, DIAGNOSTIC_FIELDS, fixturePath, fieldPath);
  assertField(value, "path", fixturePath, fieldPath);
  if (!Array.isArray(value.path) || value.path.some((segment) => typeof segment !== "string")) {
    fail(fixturePath, `${fieldPath}.path`, "must be an array of strings");
  }
  assertField(value, "severity", fixturePath, fieldPath);
  if (value.severity !== "error" && value.severity !== "info") {
    fail(fixturePath, `${fieldPath}.severity`, 'must be "error" or "info"');
  }
  assertStringField(value, "messageIncludes", fixturePath, fieldPath);
  for (const field of ["expected", "actual"]) {
    if (Object.hasOwn(value, field) && !isSchemaValue(value[field])) {
      fail(fixturePath, `${fieldPath}.${field}`, "must be a boolean or object schema");
    }
  }
}

function validateThrows(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, THROWS_FIELDS, fixturePath, fieldPath);
  assertStringField(value, "messageIncludes", fixturePath, fieldPath);
}

function validateOptions(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, OPTION_FIELDS, fixturePath, fieldPath);
  if (
    Object.hasOwn(value, "allowUntypedFunctions") &&
    typeof value.allowUntypedFunctions !== "boolean"
  ) {
    fail(fixturePath, `${fieldPath}.allowUntypedFunctions`, "must be a boolean");
  }
}

function assertBuiltins(value: unknown, fixturePath: string, fieldPath: string): void {
  if (value !== "standard" && value !== "none") {
    fail(fixturePath, fieldPath, 'must be "standard" or "none"');
  }
}

function isSchemaValue(value: unknown): boolean {
  return typeof value === "boolean" || isRecord(value);
}

function assertStringField(
  value: Record<string, unknown>,
  field: string,
  fixturePath: string,
  fieldPath: string,
): void {
  assertField(value, field, fixturePath, fieldPath);
  if (typeof value[field] !== "string") {
    fail(fixturePath, `${fieldPath}.${field}`, "must be a string");
  }
}

function assertOptionalStringField(
  value: Record<string, unknown>,
  field: string,
  fixturePath: string,
  fieldPath: string,
): void {
  if (Object.hasOwn(value, field) && typeof value[field] !== "string") {
    fail(fixturePath, `${fieldPath}.${field}`, "must be a string");
  }
}

function assertField(
  value: Record<string, unknown>,
  field: string,
  fixturePath: string,
  fieldPath: string,
): void {
  if (!Object.hasOwn(value, field)) fail(fixturePath, `${fieldPath}.${field}`, "is required");
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fixturePath: string,
  fieldPath: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(fixturePath, `${fieldPath}.${field}`, "is not allowed");
  }
}

function assertRecord(
  value: unknown,
  fixturePath: string,
  fieldPath: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(fixturePath, fieldPath, "must be an object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(fixturePath: string, fieldPath: string, message: string): never {
  throw new Error(`${fixturePath}: ${fieldPath} ${message}`);
}
