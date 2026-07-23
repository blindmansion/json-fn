import { readFileSync } from "fs";
import type { CallableSignature, CallableTable } from "../check/builtin-types";
import type { Defs, Schema } from "../schema/schema.ts";
import { taskType } from "../schema/schema.ts";
import { CallableTableValidationError, validateCallableTable } from "../builtins";
import { EFFECTS_BINDING, EffectManifestValidationError, validateEffectManifest } from "./effects";
import type { EntryReturn, Environment } from "./types";

class EnvironmentValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EnvironmentValidationError";
  }
}

class DuplicateCallableContractError extends Error {
  constructor(readonly callable: string) {
    super(`duplicate callable contract "${callable}"`);
    this.name = "DuplicateCallableContractError";
  }
}

class EnvironmentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigurationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new EnvironmentValidationError(path, message);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function remapCallableError(error: CallableTableValidationError, from: string, to: string): never {
  const path = error.path.startsWith(from) ? `${to}${error.path.slice(from.length)}` : error.path;
  throw new EnvironmentValidationError(path, error.message.slice(error.path.length + 2));
}

function isTaskReturn(value: EntryReturn): value is { task: Schema } {
  return isObject(value) && Object.keys(value).length === 1 && "task" in value;
}

function entryReturnType(value: EntryReturn): Schema {
  return isTaskReturn(value) ? taskType(value.task) : value;
}

function entryCompletionType(value: EntryReturn): Schema {
  return isTaskReturn(value) ? value.task : value;
}

/**
 * Validate one complete operator-owned environment. `baseDefs` lets host
 * contracts refer to core names while still validating every reference against
 * the same effective definition pool the checker and runtime will use.
 */
function validateEnvironment(value: unknown, baseDefs: Defs = {}): asserts value is Environment {
  if (!isObject(value)) fail("environment", "expected an object");
  assertOnlyKeys(value, new Set(["$defs", "functions", "effects", "entry"]), "environment");

  const ownDefs = "$defs" in value ? value.$defs : {};
  if (!isObject(ownDefs)) fail("environment.$defs", "expected an object");
  if (Object.prototype.hasOwnProperty.call(ownDefs, "Task")) {
    fail("environment.$defs.Task", '"Task" is reserved for the built-in Task<A> type constructor');
  }
  const defs = { ...baseDefs, ...ownDefs } as Defs;

  const functions = "functions" in value ? value.functions : {};
  if (!isObject(functions)) fail("environment.functions", "expected an object");
  try {
    validateCallableTable({ $defs: defs, builtins: functions });
  } catch (error) {
    if (!(error instanceof CallableTableValidationError)) throw error;
    remapCallableError(error, "table.builtins", "environment.functions");
  }

  const effects = "effects" in value ? value.effects : {};
  try {
    validateEffectManifest(effects, defs);
  } catch (error) {
    if (!(error instanceof EffectManifestValidationError)) throw error;
    throw new EnvironmentValidationError(
      `environment.${error.path}`,
      error.message.slice(error.path.length + 2),
    );
  }

  if (!isObject(value.entry)) fail("environment.entry", "expected an object");
  assertOnlyKeys(
    value.entry,
    new Set(["name", "required", "optional", "returns"]),
    "environment.entry",
  );
  if (typeof value.entry.name !== "string" || value.entry.name.length === 0) {
    fail("environment.entry.name", "expected a non-empty string");
  }
  if (value.entry.name === EFFECTS_BINDING) {
    fail("environment.entry.name", `"${EFFECTS_BINDING}" is reserved for declared effects`);
  }
  if (!Array.isArray(value.entry.required)) {
    fail("environment.entry.required", "expected an array");
  }
  if (!Array.isArray(value.entry.optional)) {
    fail("environment.entry.optional", "expected an array");
  }
  if (!("returns" in value.entry)) fail("environment.entry.returns", "field is required");

  const rawReturn = value.entry.returns;
  let portableReturn = rawReturn;
  if (isObject(rawReturn) && "task" in rawReturn) {
    assertOnlyKeys(rawReturn, new Set(["task"]), "environment.entry.returns");
    portableReturn = rawReturn.task;
  }
  const signature: CallableSignature = {
    required: value.entry.required as Schema[],
    optional: value.entry.optional as Schema[],
    returns: portableReturn as Schema,
  };
  try {
    validateCallableTable({
      $defs: defs,
      builtins: { entry: { signatures: [signature] } },
    });
  } catch (error) {
    if (!(error instanceof CallableTableValidationError)) throw error;
    remapCallableError(error, "table.builtins.entry.signatures[0]", "environment.entry");
  }
}

function loadEnvironment(path: string, baseDefs: Defs = {}): Environment {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateEnvironment(parsed, baseDefs);
  return parsed;
}

/**
 * Compose core and operator callable contracts. Definitions intentionally use
 * the established builtin < environment precedence, while callable names never
 * silently override one another.
 */
function mergeCallableTables(
  core: CallableTable,
  operator: Pick<Environment, "$defs" | "functions">,
): CallableTable {
  const hostFunctions = operator.functions ?? {};
  const operatorDefs = operator.$defs ?? {};
  // Nothing to merge: the (already validated) core table is the result, and
  // re-validating it per call is the dominant cost of environment preparation.
  if (Object.keys(hostFunctions).length === 0 && Object.keys(operatorDefs).length === 0) {
    return core;
  }
  for (const name of Object.keys(hostFunctions)) {
    if (name in core.builtins) throw new DuplicateCallableContractError(name);
  }
  const merged: CallableTable = {
    $defs: { ...core.$defs, ...operator.$defs },
    builtins: { ...core.builtins, ...hostFunctions },
  };
  validateCallableTable(merged);
  return merged;
}

export {
  DuplicateCallableContractError,
  EnvironmentConfigurationError,
  EnvironmentValidationError,
  entryCompletionType,
  entryReturnType,
  isTaskReturn,
  loadEnvironment,
  mergeCallableTables,
  validateEnvironment,
};
