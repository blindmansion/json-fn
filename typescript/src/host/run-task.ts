/**
 * Host trampoline — the async boundary where tasks meet the outside world.
 * The in-language task kernel is pure and synchronous; capabilities run here.
 */

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
import {
  prepareEnvironmentRuntime,
  type Capability,
  type EnvironmentHostConfiguration,
} from "./environment-runtime";

/** Thrown when a task performs `raise(err)` that no in-language handler caught. */
export class TaskRaiseError extends Error {
  readonly payload: JSONType;
  constructor(payload: JSONType) {
    super(`Unhandled raise: ${safeStringify(payload)}`);
    this.name = "TaskRaiseError";
    this.payload = payload;
  }
}

/** Thrown when a task performs an effect with no matching capability. */
export class UnhandledEffectError extends Error {
  readonly effect: string;
  constructor(effect: string) {
    super(`No capability for effect "${effect}"`);
    this.name = "UnhandledEffectError";
    this.effect = effect;
  }
}

/**
 * Run a module entry as a task, driving it to completion by answering each
 * suspended effect from the host capability table.
 */
export async function runTask(
  module: Record<string, JSONType>,
  environment: Environment,
  args: JSONType[],
  host: EnvironmentHostConfiguration,
  limits?: ExecutionLimits,
): Promise<JSONType> {
  if (Object.prototype.hasOwnProperty.call(module, EFFECTS_BINDING)) {
    throw new EnvironmentConfigurationError(
      `"${EFFECTS_BINDING}" is reserved for environment-declared effects`,
    );
  }
  const prepared = prepareEnvironmentRuntime(environment, host, module);
  const runtimeModule = {
    ...module,
    [EFFECTS_BINDING]: buildEffectNamespace(environment.effects),
  };
  const checkedArgs = enforceRuntimeContract(
    args,
    {
      type: "array",
      prefixItems: [...environment.entry.required, ...environment.entry.optional],
      items: false,
      minItems: environment.entry.required.length,
    },
    prepared.defs,
    `entry "${environment.entry.name}" arguments`,
  ) as JSONType[];
  const result = await runTaskConfigured(
    runtimeModule,
    environment.entry.name,
    checkedArgs,
    prepared.registry,
    host.capabilities,
    limits,
    prepared.definitions,
    environment.effects ?? {},
  );
  return enforceRuntimeContract(
    result,
    entryCompletionType(environment.entry.returns),
    prepared.defs,
    `entry "${environment.entry.name}" result`,
  );
}

async function runTaskConfigured(
  module: Record<string, JSONType>,
  entry: string,
  args: JSONType[],
  registry: FunctionRegistry,
  capabilities: Record<string, Capability>,
  limits?: ExecutionLimits,
  definitions: DefinitionSources = {},
  effects: EffectManifest = {},
): Promise<JSONType> {
  const { invokeEntry, call, meter, refreshDeadline } = prepareProgram(
    module,
    registry,
    limits,
    definitions,
  );
  const defs = mergeDefinitionPools(definitions, readModuleDefinitions(module));
  let task = invokeEntry(entry, args);

  for (;;) {
    const stepped = stepTask(task, call, meter);
    if ("done" in stepped) return stepped.done;

    const { name, args: effectArgs, resume } = stepped.pending;
    if (name === "raise") {
      throw new TaskRaiseError(effectArgs[0] ?? null);
    }
    const effect = effects[name];
    if (effect === undefined) {
      throw new RuntimeContractError(`unknown effect "${name}"`);
    }
    enforceRuntimeContract(
      effectArgs,
      {
        type: "array",
        prefixItems: effect.params,
        items: false,
      },
      defs,
      `effect "${name}" arguments`,
    );
    const capability = capabilities[name];
    if (capability === undefined) {
      throw new UnhandledEffectError(name);
    }

    refreshDeadline();
    const value = await capability(...effectArgs);
    const checked = enforceRuntimeContract(
      value ?? null,
      effect.returns,
      defs,
      `effect "${name}" result`,
    );
    task = call(resume, [checked]);
  }
}

function safeStringify(value: JSONType): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
