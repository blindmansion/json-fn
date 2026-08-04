// Loader for the canonical, language-agnostic builtin signature table
// (`spec/builtins.json`). The table is the shared source of truth for builtin
// types across implementations; the TypeScript checker's Section F reads it via
// `CheckContext.builtins`. See docs/builtins/builtin-signatures.md for the format.
//
// For now this reads the JSON off disk at runtime, mirroring how the spec-case
// harness loads `spec/cases`. Bundling / codegen is a later concern.

import { readFileSync } from "fs";
import { join } from "path";
import type { CallableTable } from "./check/builtin-types";
import type { Defs } from "./schema/schema";
import {
  SchemaFragmentValidationError,
  validateCallableSignature,
  validateDefinitionTable,
} from "./schema/validation";
import { assertStructuralDepth } from "./structural-depth";

const DEFAULT_PATH = join(import.meta.dir, "../../spec/builtins.json");

export class CallableTableValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CallableTableValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new CallableTableValidationError(path, message);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function validateSchemaErrors(validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (!(error instanceof SchemaFragmentValidationError)) throw error;
    fail(error.path, error.message.slice(error.path.length + 2));
  }
}

export function validateCallableTable(value: unknown): asserts value is CallableTable {
  assertStructuralDepth(value);
  const table = assertObject(value, "table");
  assertOnlyKeys(table, new Set(["description", "$defs", "builtins"]), "table");
  if ("description" in table && typeof table.description !== "string") {
    fail("table.description", "expected a string");
  }

  const rawDefs = "$defs" in table ? assertObject(table.$defs, "table.$defs") : {};
  validateSchemaErrors(() => validateDefinitionTable(rawDefs, "table.$defs"));
  const defs = rawDefs as Defs;

  const builtins = assertObject(table.builtins, "table.builtins");
  for (const [name, entry] of Object.entries(builtins)) {
    const path = `table.builtins.${name}`;
    if (name.length === 0) fail(path, "builtin name cannot be empty");
    const contract = assertObject(entry, path);
    assertOnlyKeys(contract, new Set(["description", "category", "signatures", "rule"]), path);
    for (const field of ["description", "category"] as const) {
      if (
        field in contract &&
        (typeof contract[field] !== "string" || contract[field].length === 0)
      ) {
        fail(`${path}.${field}`, "expected a non-empty string");
      }
    }
    if (!Array.isArray(contract.signatures)) fail(`${path}.signatures`, "expected an array");
    const signatures = contract.signatures;
    if (signatures.length === 0) {
      fail(`${path}.signatures`, "fallback signature set cannot be empty");
    }
    for (let i = 0; i < signatures.length; i++) {
      validateSchemaErrors(() =>
        validateCallableSignature(signatures[i], defs, `${path}.signatures[${i}]`),
      );
    }
    if (
      "rule" in contract &&
      (typeof contract.rule !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(contract.rule))
    ) {
      fail(`${path}.rule`, "expected a namespaced rule identifier");
    }
  }
}

// The table is static for the process lifetime, and hosts (e.g. runTask) load
// it on every invocation — parse + validate costs ~700µs, so cache per path.
// Only successful loads are cached; callers treat the table as read-only.
const loadedTables = new Map<string, CallableTable>();

export function loadBuiltinTable(path: string = DEFAULT_PATH): CallableTable {
  const cached = loadedTables.get(path);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateCallableTable(parsed);
  loadedTables.set(path, parsed);
  return parsed;
}
