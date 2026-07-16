import { readFileSync } from "fs";
import type { BuiltinEntry, BuiltinSig, BuiltinTable } from "./check/builtin-types";
import type { Defs, Schema } from "./check/schema";
import { taskType } from "./check/schema";
import { BuiltinTableValidationError, validateBuiltinTable } from "./builtins";
import type { EffectManifest } from "./effects";
import { EffectManifestValidationError, validateEffectManifest } from "./effects";

type EntryReturn = Schema | { task: Schema };

type EntryContract = {
  name: string;
  params: Schema[];
  returns: EntryReturn;
};

type Environment = {
  $defs?: Defs;
  functions?: Record<string, BuiltinEntry>;
  effects?: EffectManifest;
  entry: EntryContract;
};

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

function remapBuiltinError(error: BuiltinTableValidationError, from: string, to: string): never {
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
  const defs = { ...baseDefs, ...ownDefs } as Defs;

  const functions = "functions" in value ? value.functions : {};
  if (!isObject(functions)) fail("environment.functions", "expected an object");
  try {
    validateBuiltinTable({ $defs: defs, builtins: functions });
  } catch (error) {
    if (!(error instanceof BuiltinTableValidationError)) throw error;
    remapBuiltinError(error, "table.builtins", "environment.functions");
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
  assertOnlyKeys(value.entry, new Set(["name", "params", "returns"]), "environment.entry");
  if (typeof value.entry.name !== "string" || value.entry.name.length === 0) {
    fail("environment.entry.name", "expected a non-empty string");
  }
  if (!Array.isArray(value.entry.params)) {
    fail("environment.entry.params", "expected an array");
  }
  if (!("returns" in value.entry)) fail("environment.entry.returns", "field is required");

  const rawReturn = value.entry.returns;
  let portableReturn = rawReturn;
  if (isObject(rawReturn) && "task" in rawReturn) {
    assertOnlyKeys(rawReturn, new Set(["task"]), "environment.entry.returns");
    portableReturn = rawReturn.task;
  }
  const signature: BuiltinSig = {
    params: value.entry.params as Schema[],
    returns: portableReturn as Schema,
  };
  try {
    validateBuiltinTable({
      $defs: defs,
      builtins: { entry: { signatures: [signature] } },
    });
  } catch (error) {
    if (!(error instanceof BuiltinTableValidationError)) throw error;
    remapBuiltinError(error, "table.builtins.entry.signatures[0]", "environment.entry");
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
  core: BuiltinTable,
  operator: Pick<Environment, "$defs" | "functions">,
): BuiltinTable {
  const hostFunctions = operator.functions ?? {};
  for (const name of Object.keys(hostFunctions)) {
    if (name in core.builtins) throw new DuplicateCallableContractError(name);
  }
  const merged: BuiltinTable = {
    $defs: { ...core.$defs, ...operator.$defs },
    builtins: { ...core.builtins, ...hostFunctions },
  };
  validateBuiltinTable(merged);
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
export type { EntryContract, EntryReturn, Environment };
