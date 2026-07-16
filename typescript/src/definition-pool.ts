import type { JSONType } from "./types";

/** Named schemas available to checker and runtime `$ref` resolution. */
export type DefinitionPool = Record<string, JSONType>;

/**
 * Operator-owned definition sources. Module `$types` are read from the module
 * separately so they always remain the highest-precedence layer.
 */
export type DefinitionSources = {
  builtinDefs?: DefinitionPool;
  environmentDefs?: DefinitionPool;
};

export class ReservedDefinitionError extends Error {
  constructor(readonly source: "module" | "environment") {
    super(`${source} definitions cannot declare reserved type "Task"`);
    this.name = "ReservedDefinitionError";
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

/** Merge named schemas in the language-defined precedence order. */
export function mergeDefinitionPools(
  sources: DefinitionSources = {},
  moduleDefs: DefinitionPool = {},
): DefinitionPool {
  if (Object.prototype.hasOwnProperty.call(sources.environmentDefs ?? {}, "Task")) {
    throw new ReservedDefinitionError("environment");
  }
  if (Object.prototype.hasOwnProperty.call(moduleDefs, "Task")) {
    throw new ReservedDefinitionError("module");
  }
  return { ...sources.builtinDefs, ...sources.environmentDefs, ...moduleDefs };
}
