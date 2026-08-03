import { readFileSync } from "fs";
import type { CallableSignature, CallableTable } from "../check/builtin-types";
import type { Defs, Schema } from "../schema/schema.ts";
import { taskType } from "../schema/schema.ts";
import { CallableTableValidationError, loadBuiltinTable, validateCallableTable } from "../builtins";
import { EFFECTS_BINDING, EffectManifestValidationError, validateEffectManifest } from "./effects";
import type { EntryReturn, EnvironmentContract } from "./types";

const CONTRACT_VERSION = 1;

class EnvironmentContractValidationError extends Error {
  readonly code = "INVALID_CONTRACT";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EnvironmentContractValidationError";
  }
}

class DuplicateCallableContractError extends Error {
  readonly code = "DUPLICATE_CALLABLE";
  readonly path: string;

  constructor(
    readonly callable: string,
    path = `callables.${callable}`,
  ) {
    super(`duplicate callable contract "${callable}"`);
    this.name = "DuplicateCallableContractError";
    this.path = path;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new EnvironmentContractValidationError(path, message);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function remapCallableError(error: CallableTableValidationError, from: string, to: string): never {
  const path = error.path.startsWith(from) ? `${to}${error.path.slice(from.length)}` : error.path;
  throw new EnvironmentContractValidationError(path, error.message.slice(error.path.length + 2));
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
 * Validate one complete operator-owned contract. Core callables and definitions
 * participate by default so standalone validation is complete.
 */
function validateEnvironmentContract(
  value: unknown,
  core: CallableTable | false = loadBuiltinTable(),
): asserts value is EnvironmentContract {
  if (!isObject(value)) fail("contract", "expected an object");
  assertOnlyKeys(value, new Set(["version", "$defs", "functions", "effects", "entry"]), "contract");
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    fail("contract.version", "expected an integer");
  }
  if (value.version !== CONTRACT_VERSION) {
    fail(
      "contract.version",
      `unsupported contract version ${value.version}; expected ${CONTRACT_VERSION}`,
    );
  }

  const baseDefs = core === false ? {} : core.$defs;
  const ownDefs = "$defs" in value ? value.$defs : {};
  if (!isObject(ownDefs)) fail("contract.$defs", "expected an object");
  if (Object.prototype.hasOwnProperty.call(ownDefs, "Task")) {
    fail("contract.$defs.Task", '"Task" is reserved for the built-in Task<A> type constructor');
  }
  for (const name of Object.keys(ownDefs)) {
    if (Object.prototype.hasOwnProperty.call(baseDefs, name)) {
      fail(`contract.$defs.${name}`, `duplicates builtin definition "${name}"`);
    }
  }
  const defs = { ...baseDefs, ...ownDefs } as Defs;

  const functions = "functions" in value ? value.functions : {};
  if (!isObject(functions)) fail("contract.functions", "expected an object");
  if (core !== false) {
    for (const name of Object.keys(functions)) {
      if (Object.prototype.hasOwnProperty.call(core.builtins, name)) {
        throw new DuplicateCallableContractError(name, `contract.functions.${name}`);
      }
    }
  }
  try {
    validateCallableTable({ $defs: defs, builtins: functions });
  } catch (error) {
    if (!(error instanceof CallableTableValidationError)) throw error;
    remapCallableError(error, "table.builtins", "contract.functions");
  }

  const effects = "effects" in value ? value.effects : {};
  if (isObject(effects) && Object.prototype.hasOwnProperty.call(effects, "raise")) {
    fail("contract.effects.raise", '"raise" is intrinsic and cannot be declared');
  }
  try {
    validateEffectManifest(effects, defs);
  } catch (error) {
    if (!(error instanceof EffectManifestValidationError)) throw error;
    throw new EnvironmentContractValidationError(
      `contract.${error.path}`,
      error.message.slice(error.path.length + 2),
    );
  }

  if (!isObject(value.entry)) fail("contract.entry", "expected an object");
  assertOnlyKeys(
    value.entry,
    new Set(["name", "required", "optional", "returns"]),
    "contract.entry",
  );
  if (typeof value.entry.name !== "string" || value.entry.name.length === 0) {
    fail("contract.entry.name", "expected a non-empty string");
  }
  if (value.entry.name === EFFECTS_BINDING) {
    fail("contract.entry.name", `"${EFFECTS_BINDING}" is reserved for declared effects`);
  }
  if (!Array.isArray(value.entry.required)) {
    fail("contract.entry.required", "expected an array");
  }
  if (!Array.isArray(value.entry.optional)) {
    fail("contract.entry.optional", "expected an array");
  }
  if (!("returns" in value.entry)) fail("contract.entry.returns", "field is required");

  const rawReturn = value.entry.returns;
  let portableReturn = rawReturn;
  if (isObject(rawReturn) && "task" in rawReturn) {
    assertOnlyKeys(rawReturn, new Set(["task"]), "contract.entry.returns");
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
    remapCallableError(error, "table.builtins.entry.signatures[0]", "contract.entry");
  }
}

function loadEnvironmentContract(
  path: string,
  core: CallableTable | false = loadBuiltinTable(),
): EnvironmentContract {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateEnvironmentContract(parsed, core);
  return parsed;
}

/**
 * Compose core and operator callable contracts. Definitions and callable names
 * must remain unambiguous across ownership layers.
 */
function mergeCallableTables(
  core: CallableTable,
  operator: Pick<EnvironmentContract, "$defs" | "functions">,
): CallableTable {
  const hostFunctions = operator.functions ?? {};
  const operatorDefs = operator.$defs ?? {};
  // Nothing to merge: the (already validated) core table is the result, and
  // re-validating it per call is the dominant cost of contract preparation.
  if (Object.keys(hostFunctions).length === 0 && Object.keys(operatorDefs).length === 0) {
    return core;
  }
  for (const name of Object.keys(hostFunctions)) {
    if (Object.hasOwn(core.builtins, name)) {
      throw new DuplicateCallableContractError(name, `contract.functions.${name}`);
    }
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
  CONTRACT_VERSION,
  EnvironmentContractValidationError,
  entryCompletionType,
  entryReturnType,
  isTaskReturn,
  loadEnvironmentContract,
  mergeCallableTables,
  validateEnvironmentContract,
};
