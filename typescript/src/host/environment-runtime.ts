import { loadBuiltinTable } from "../builtins";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "../definition-pool";
import {
  EnvironmentConfigurationError,
  mergeCallableTables,
  validateEnvironment,
  type Environment,
} from "../environment/environment";
import { enforceRuntimeContract } from "../runtime-contract";
import type { CallableTypeRuleRegistry } from "../check/builtin-types";
import type { FunctionRegistry, JSONType } from "../types";

/** A host capability: answers one effect, synchronously or asynchronously. */
export type Capability = (...args: JSONType[]) => Promise<JSONType> | JSONType;

export type EnvironmentHostConfiguration = {
  registry: FunctionRegistry;
  capabilities: Record<string, Capability>;
  /** Accepted alongside runtime configuration for hosts that share one setup object with the checker. */
  typeRules?: CallableTypeRuleRegistry;
};

export type PreparedEnvironmentRuntime = {
  registry: FunctionRegistry;
  definitions: DefinitionSources;
  defs: Record<string, JSONType>;
};

export function prepareEnvironmentRuntime(
  environment: Environment,
  host: EnvironmentHostConfiguration,
  module: Record<string, JSONType>,
): PreparedEnvironmentRuntime {
  if (
    host === undefined ||
    typeof host !== "object" ||
    host.registry === undefined ||
    host.capabilities === undefined
  ) {
    throw new EnvironmentConfigurationError(
      "environment execution requires registry and capabilities",
    );
  }
  const core = loadBuiltinTable();
  validateEnvironment(environment, core.$defs);
  const effective = mergeCallableTables(core, environment);
  const definitions: DefinitionSources = {
    builtinDefs: core.$defs,
    environmentDefs: environment.$defs,
  };
  const defs = mergeDefinitionPools(definitions, readModuleDefinitions(module));
  const registry: FunctionRegistry = { ...host.registry };

  for (const name of Object.keys(effective.builtins)) {
    if (registry[name] === undefined) {
      throw new EnvironmentConfigurationError(
        `callable contract "${name}" has no runtime implementation`,
      );
    }
  }
  for (const name of Object.keys(registry)) {
    if (effective.builtins[name] === undefined) {
      throw new EnvironmentConfigurationError(
        `runtime function "${name}" has no callable contract`,
      );
    }
  }

  for (const [name, contract] of Object.entries(environment.functions ?? {})) {
    const implementation = registry[name];
    // The parity pass above established this entry.
    if (implementation === undefined) continue;
    const concrete = contract.signatures.filter((signature) => signature.typeParams === undefined);
    if (concrete.length === 0) continue;
    const alias = `@environment:${name}`;
    if (alias in registry) {
      throw new EnvironmentConfigurationError(
        `reserved runtime function name "${alias}" is in use`,
      );
    }
    registry[alias] = implementation;
    const arms = concrete.map((signature) => ({
      $fnType: {
        required: signature.required,
        optional: signature.optional,
        ...(signature.rest === undefined ? {} : { rest: signature.rest }),
        returns: signature.returns,
      },
    }));
    const schema = arms.length === 1 ? arms[0]! : { anyOf: arms };
    registry[name] = enforceRuntimeContract(
      alias,
      schema,
      defs,
      `host function "${name}"`,
    ) as FunctionRegistry[string];
  }

  const effectNames = new Set(Object.keys(environment.effects ?? {}));
  for (const name of effectNames) {
    if (host.capabilities[name] === undefined) {
      throw new EnvironmentConfigurationError(
        `effect contract "${name}" has no capability implementation`,
      );
    }
  }
  for (const name of Object.keys(host.capabilities)) {
    if (!effectNames.has(name)) {
      throw new EnvironmentConfigurationError(
        `capability implementation "${name}" has no effect contract`,
      );
    }
  }

  return {
    registry,
    definitions,
    defs,
  };
}
