import type { CallableTable } from "./check/builtin-types";
import { loadBuiltinTable } from "./builtins";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "./definition-pool";
import { buildEffectNamespace, EFFECTS_BINDING } from "./environment/effects";
import {
  entryReturnType,
  mergeCallableTables,
  validateEnvironmentContract,
} from "./environment/environment";
import type { EnvironmentContract } from "./environment/types";
import type { Defs, Schema } from "./schema/schema";
import type { JSONType } from "./types";
import { isFunctionBody } from "./function-value";

export class ModuleLinkError extends Error {
  constructor(
    readonly code: "RESERVED_MODULE_BINDING" | "MISSING_CONTRACT_ENTRY" | "INVALID_CONTRACT_ENTRY",
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ModuleLinkError";
  }
}

export type LinkedEntrySignature = Readonly<{
  required: Schema[];
  optional: Schema[];
  returns: Schema;
}>;

export type LinkedModule = Readonly<{
  module: Readonly<Record<string, JSONType>>;
  moduleDefinitions: Readonly<Defs>;
  definitionSources: Readonly<DefinitionSources>;
  definitions: Readonly<Defs>;
  callableTable?: Readonly<CallableTable>;
  entryName?: string;
  entrySignature?: LinkedEntrySignature;
}>;

export type LinkModuleOptions = {
  module: Record<string, JSONType>;
  /** Omit for engine builtins; `false` is the explicit checker-only opt-out. */
  builtins?: CallableTable | false;
  contract?: EnvironmentContract;
  /** Public linking validates the executable entry; the checker opts out to report diagnostics. */
  validateEntry?: boolean;
};

/**
 * Assemble the portable parts of a module exactly once. Runtime adapters and
 * execution policy deliberately remain outside this phase of linking.
 */
export function linkModule({
  module,
  builtins: configuredBuiltins,
  contract,
  validateEntry = true,
}: LinkModuleOptions): LinkedModule {
  const builtins = configuredBuiltins === undefined ? loadBuiltinTable() : configuredBuiltins;
  if (contract !== undefined) {
    validateEnvironmentContract(contract, builtins);
    if (Object.prototype.hasOwnProperty.call(module, EFFECTS_BINDING)) {
      throw new ModuleLinkError(
        "RESERVED_MODULE_BINDING",
        EFFECTS_BINDING,
        `"${EFFECTS_BINDING}" is reserved for contract-declared effects`,
      );
    }
    if (validateEntry) {
      const entry = module[contract.entry.name];
      if (entry === undefined) {
        throw new ModuleLinkError(
          "MISSING_CONTRACT_ENTRY",
          `module.${contract.entry.name}`,
          `contract entry "${contract.entry.name}" is not defined`,
        );
      }
      if (!isFunctionBody(entry)) {
        throw new ModuleLinkError(
          "INVALID_CONTRACT_ENTRY",
          `module.${contract.entry.name}`,
          `contract entry "${contract.entry.name}" must be a function`,
        );
      }
    }
  }

  const moduleDefinitions = readModuleDefinitions(module);
  const definitionSources: DefinitionSources = {
    builtinDefs: builtins === false ? undefined : builtins.$defs,
    contractDefs: contract?.$defs,
  };
  const definitions = mergeDefinitionPools(definitionSources, moduleDefinitions);
  const callableTable =
    contract === undefined
      ? builtins === false
        ? undefined
        : builtins
      : mergeCallableTables(builtins === false ? { builtins: {} } : builtins, contract);
  const linkedProgram =
    contract === undefined
      ? { ...module }
      : { ...module, [EFFECTS_BINDING]: buildEffectNamespace(contract.effects) };
  const entrySignature =
    contract === undefined
      ? undefined
      : Object.freeze({
          required: contract.entry.required,
          optional: contract.entry.optional,
          returns: entryReturnType(contract.entry.returns),
        });

  return Object.freeze({
    module: Object.freeze(linkedProgram),
    moduleDefinitions: Object.freeze({ ...moduleDefinitions }),
    definitionSources: Object.freeze({ ...definitionSources }),
    definitions: Object.freeze({ ...definitions }),
    callableTable:
      callableTable === undefined
        ? undefined
        : Object.freeze({
            ...callableTable,
            $defs: Object.freeze({ ...callableTable.$defs }),
            builtins: Object.freeze({ ...callableTable.builtins }),
          }),
    entryName: contract?.entry.name,
    entrySignature,
  });
}
