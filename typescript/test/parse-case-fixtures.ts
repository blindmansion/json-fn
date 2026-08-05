import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { JSONType } from "../src/types";

export type ParseMode = "expression" | "module";

export interface ParseErrorPosition {
  line: number;
  column: number;
}

export interface StructuredParseError {
  messageIncludes?: string;
  at?: ParseErrorPosition;
}

export type ParseErrorExpectation = true | string | StructuredParseError;

interface ParseCaseBase {
  description: string;
  comment?: string;
  source: string;
  mode?: ParseMode;
}

export type ParseCase = ParseCaseBase &
  ({ expected: JSONType; error?: never } | { expected?: never; error: ParseErrorExpectation });

export interface ParseSuite {
  $schema: "../parse.schema.json";
  description: string;
  comment?: string;
  mode?: ParseMode;
  cases: ParseCase[];
}

const SUITE_FIELDS = new Set(["$schema", "description", "comment", "mode", "cases"]);
const CASE_FIELDS = new Set(["description", "comment", "source", "mode", "expected", "error"]);
const ERROR_FIELDS = new Set(["messageIncludes", "at"]);
const POSITION_FIELDS = new Set(["line", "column"]);

export function loadParseSuite(path: string): ParseSuite {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: invalid JSON: ${message}`);
  }
  validateParseSuite(value, path);
  return value;
}

export function loadParseSuites(dir: string): ParseSuite[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => loadParseSuite(join(dir, file)));
}

export function validateParseSuite(
  value: unknown,
  path = "<parse suite>",
): asserts value is ParseSuite {
  assertRecord(value, path, "$");
  assertKnownFields(value, SUITE_FIELDS, path, "$");
  assertField(value, "$schema", path, "$");
  if (value.$schema !== "../parse.schema.json") {
    fail(path, "$.$schema", 'must equal "../parse.schema.json"');
  }
  assertStringField(value, "description", path, "$");
  assertOptionalStringField(value, "comment", path, "$");
  assertOptionalMode(value.mode, path, "$.mode");
  assertField(value, "cases", path, "$");
  if (!Array.isArray(value.cases)) fail(path, "$.cases", "must be an array");

  for (const [index, parseCase] of value.cases.entries()) {
    validateParseCase(parseCase, path, `$.cases[${index}]`);
  }
}

function validateParseCase(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, CASE_FIELDS, fixturePath, fieldPath);
  assertStringField(value, "description", fixturePath, fieldPath);
  assertOptionalStringField(value, "comment", fixturePath, fieldPath);
  assertStringField(value, "source", fixturePath, fieldPath);
  assertOptionalMode(value.mode, fixturePath, `${fieldPath}.mode`);

  const hasExpected = Object.hasOwn(value, "expected");
  const hasError = Object.hasOwn(value, "error");
  if (hasExpected === hasError) {
    fail(fixturePath, fieldPath, "must contain exactly one of 'expected' or 'error'");
  }
  if (hasError) validateError(value.error, fixturePath, `${fieldPath}.error`);
}

function validateError(value: unknown, fixturePath: string, fieldPath: string): void {
  if (value === true || typeof value === "string") return;
  if (!isRecord(value)) {
    fail(fixturePath, fieldPath, "must be true, a message substring, or a structured error");
  }

  assertKnownFields(value, ERROR_FIELDS, fixturePath, fieldPath);
  const hasMessage = Object.hasOwn(value, "messageIncludes");
  const hasPosition = Object.hasOwn(value, "at");
  if (!hasMessage && !hasPosition) {
    fail(fixturePath, fieldPath, "must contain at least one of 'messageIncludes' or 'at'");
  }
  if (hasMessage && typeof value.messageIncludes !== "string") {
    fail(fixturePath, `${fieldPath}.messageIncludes`, "must be a string");
  }
  if (hasPosition) validatePosition(value.at, fixturePath, `${fieldPath}.at`);
}

function validatePosition(value: unknown, fixturePath: string, fieldPath: string): void {
  assertRecord(value, fixturePath, fieldPath);
  assertKnownFields(value, POSITION_FIELDS, fixturePath, fieldPath);
  assertPositiveIntegerField(value, "line", fixturePath, fieldPath);
  assertPositiveIntegerField(value, "column", fixturePath, fieldPath);
}

function assertOptionalMode(value: unknown, fixturePath: string, fieldPath: string): void {
  if (value !== undefined && value !== "expression" && value !== "module") {
    fail(fixturePath, fieldPath, 'must be "expression" or "module"');
  }
}

function assertStringField(
  value: Record<string, unknown>,
  field: string,
  fixturePath: string,
  fieldPath: string,
): void {
  assertField(value, field, fixturePath, fieldPath);
  if (typeof value[field] !== "string")
    fail(fixturePath, `${fieldPath}.${field}`, "must be a string");
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

function assertPositiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  fixturePath: string,
  fieldPath: string,
): void {
  assertField(value, field, fixturePath, fieldPath);
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue) || fieldValue < 1) {
    fail(fixturePath, `${fieldPath}.${field}`, "must be a positive integer");
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
