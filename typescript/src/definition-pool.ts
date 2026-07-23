import type { JSONType } from "./types";

/** Named schemas available to checker and runtime `$ref` resolution. */
export type DefinitionPool = Record<string, JSONType>;

/**
 * Operator-owned definition sources. Module `$types` are read separately so
 * collisions can be rejected with source-specific diagnostics.
 */
export type DefinitionSources = {
  builtinDefs?: DefinitionPool;
  contractDefs?: DefinitionPool;
};

export class ReservedDefinitionError extends Error {
  readonly code = "RESERVED_DEFINITION";
  readonly path: string;

  constructor(readonly source: "module" | "contract") {
    super(`${source} definitions cannot declare reserved type "Task"`);
    this.name = "ReservedDefinitionError";
    this.path = source === "module" ? "module.$types.Task" : "contract.$defs.Task";
  }
}

export class DuplicateDefinitionError extends Error {
  readonly code = "DUPLICATE_DEFINITION";
  readonly path: string;

  constructor(
    readonly definition: string,
    readonly firstSource: "builtin" | "contract",
    readonly secondSource: "contract" | "module",
  ) {
    super(`duplicate definition "${definition}" across ${firstSource} and ${secondSource} sources`);
    this.name = "DuplicateDefinitionError";
    this.path = `definitions.${definition}`;
  }
}

export function readModuleDefinitions(module: Record<string, JSONType>): DefinitionPool {
  const types = module.$types;
  if (typeof types !== "object" || types === null || Array.isArray(types)) return {};
  if (Object.prototype.hasOwnProperty.call(types, "Task")) {
    throw new ReservedDefinitionError("module");
  }
  return types as DefinitionPool;
}

/** Merge named schemas, rejecting ambiguous names across ownership layers. */
export function mergeDefinitionPools(
  sources: DefinitionSources = {},
  moduleDefs: DefinitionPool = {},
): DefinitionPool {
  if (Object.prototype.hasOwnProperty.call(sources.contractDefs ?? {}, "Task")) {
    throw new ReservedDefinitionError("contract");
  }
  if (Object.prototype.hasOwnProperty.call(moduleDefs, "Task")) {
    throw new ReservedDefinitionError("module");
  }
  const builtinDefs = sources.builtinDefs ?? {};
  const contractDefs = sources.contractDefs ?? {};
  for (const name of Object.keys(contractDefs)) {
    if (Object.prototype.hasOwnProperty.call(builtinDefs, name)) {
      throw new DuplicateDefinitionError(name, "builtin", "contract");
    }
  }
  for (const name of Object.keys(moduleDefs)) {
    if (Object.prototype.hasOwnProperty.call(builtinDefs, name)) {
      throw new DuplicateDefinitionError(name, "builtin", "module");
    }
    if (Object.prototype.hasOwnProperty.call(contractDefs, name)) {
      throw new DuplicateDefinitionError(name, "contract", "module");
    }
  }
  return { ...builtinDefs, ...contractDefs, ...moduleDefs };
}
