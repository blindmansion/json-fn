import { loadBuiltinTable } from "../builtins";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "../definition-pool";
import { buildEffectNamespace, EFFECTS_BINDING } from "../environment/effects";
import type { EffectManifest } from "../environment/effect-types";
import { EnvironmentConfigurationError, entryCompletionType } from "../environment/environment";
import type { Environment } from "../environment/types";
import { prepareProgram } from "../eval";
import { enforceRuntimeContract, RuntimeContractError } from "../runtime-contract";
import { stepTask } from "../task";
import type { ExecutionLimits, FunctionRegistry, JSONType } from "../types";

export type PendingStep = {
  name: string;
  args: JSONType[];
  resume: JSONType;
};

export type PreparedTaskRuntime = {
  validateArgs(args: JSONType[]): JSONType[];
  invokeEntry(args: JSONType[]): JSONType;
  step(task: JSONType): { done: JSONType } | { pending: PendingStep };
  applyResume(resume: JSONType, name: string, result: JSONType): JSONType;
  validateCompletion(value: JSONType): JSONType;
  refreshDeadline(): void;
  fuelUsed(): number;
};

/** Thrown when a task performs `raise(err)` that no in-language handler caught. */
export class TaskRaiseError extends Error {
  readonly payload: JSONType;
  constructor(payload: JSONType) {
    super(`Unhandled raise: ${safeStringify(payload)}`);
    this.name = "TaskRaiseError";
    this.payload = payload;
  }
}

export function prepareTaskRuntime(
  module: Record<string, JSONType>,
  environment: Environment,
  registry: FunctionRegistry,
  limits?: ExecutionLimits,
): PreparedTaskRuntime {
  if (Object.prototype.hasOwnProperty.call(module, EFFECTS_BINDING)) {
    throw new EnvironmentConfigurationError(
      `"${EFFECTS_BINDING}" is reserved for environment-declared effects`,
    );
  }

  const effects = environment.effects ?? {};
  const runtimeModule = {
    ...module,
    [EFFECTS_BINDING]: buildEffectNamespace(environment.effects),
  };
  const definitions: DefinitionSources = {
    builtinDefs: loadBuiltinTable().$defs,
    environmentDefs: environment.$defs,
  };
  const defs = mergeDefinitionPools(definitions, readModuleDefinitions(runtimeModule));
  const usage = limits?.usage ?? { fuel: 0 };
  const prepared = prepareProgram(runtimeModule, registry, { ...limits, usage }, definitions);

  const effectContract = (name: string): EffectManifest[string] => {
    const effect = effects[name];
    if (effect === undefined) {
      throw new RuntimeContractError(`unknown effect "${name}"`);
    }
    return effect;
  };

  return {
    validateArgs(args) {
      return enforceRuntimeContract(
        args,
        {
          type: "array",
          prefixItems: [...environment.entry.required, ...environment.entry.optional],
          items: false,
          minItems: environment.entry.required.length,
        },
        defs,
        `entry "${environment.entry.name}" arguments`,
      ) as JSONType[];
    },

    invokeEntry(args) {
      return prepared.invokeEntry(environment.entry.name, args);
    },

    step(task) {
      const stepped = stepTask(task, prepared.call, prepared.meter);
      if ("done" in stepped) return stepped;

      const { name, args } = stepped.pending;
      if (name === "raise") {
        throw new TaskRaiseError(args[0] ?? null);
      }
      const effect = effectContract(name);
      enforceRuntimeContract(
        args,
        {
          type: "array",
          prefixItems: effect.params,
          items: false,
        },
        defs,
        `effect "${name}" arguments`,
      );
      return stepped;
    },

    applyResume(resume, name, result) {
      const checked = enforceRuntimeContract(
        result ?? null,
        effectContract(name).returns,
        defs,
        `effect "${name}" result`,
      );
      return prepared.call(resume, [checked]);
    },

    validateCompletion(value) {
      return enforceRuntimeContract(
        value,
        entryCompletionType(environment.entry.returns),
        defs,
        `entry "${environment.entry.name}" result`,
      );
    },

    refreshDeadline: prepared.refreshDeadline,
    fuelUsed: prepared.fuelUsed,
  };
}

function safeStringify(value: JSONType): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
