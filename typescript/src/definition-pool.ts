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

export function readModuleDefinitions(module: Record<string, JSONType>): DefinitionPool {
  const types = module.$types;
  return typeof types === "object" && types !== null && !Array.isArray(types)
    ? (types as DefinitionPool)
    : {};
}

/** Merge named schemas in the language-defined precedence order. */
export function mergeDefinitionPools(
  sources: DefinitionSources = {},
  moduleDefs: DefinitionPool = {},
): DefinitionPool {
  return { ...sources.builtinDefs, ...sources.environmentDefs, ...moduleDefs };
}
