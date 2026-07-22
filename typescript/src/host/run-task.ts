/**
 * Host trampoline — the async boundary where tasks meet the outside world.
 * The in-language task kernel is pure and synchronous; capabilities run here.
 */

import { EFFECTS_BINDING } from "../environment/effects";
import type { EffectManifest } from "../environment/effect-types";
import { EnvironmentConfigurationError, isTaskReturn } from "../environment/environment";
import type { Environment } from "../environment/types";
import type { ExecutionLimits, JSONType } from "../types";
import {
  prepareEnvironmentRuntime,
  type Capability,
  type EnvironmentHostConfiguration,
} from "./environment-runtime";
import { prepareTaskRuntime } from "./task-runtime";

export { TaskRaiseError } from "./task-runtime";

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
 * Run a module entry according to its environment return contract. Task
 * entries are driven to completion by answering suspended host effects.
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
  validateEffectCapabilityParity(environment.effects ?? {}, host.capabilities);
  const runtime = prepareTaskRuntime(module, environment, prepared.registry, limits);
  const checkedArgs = runtime.validateArgs(args);
  let result = runtime.invokeEntry(checkedArgs);

  if (isTaskReturn(environment.entry.returns)) {
    let task = result;
    for (;;) {
      const stepped = runtime.step(task);
      if ("done" in stepped) {
        result = stepped.done;
        break;
      }

      const { name, args: effectArgs, resume } = stepped.pending;
      const capability = host.capabilities[name];
      if (capability === undefined) {
        throw new UnhandledEffectError(name);
      }

      runtime.refreshDeadline();
      const value = await capability(...effectArgs);
      task = runtime.applyResume(resume, name, value);
    }
  }

  return runtime.validateCompletion(result);
}

function validateEffectCapabilityParity(
  effects: EffectManifest,
  capabilities: Record<string, Capability>,
): void {
  const effectNames = new Set(Object.keys(effects));
  for (const name of effectNames) {
    if (capabilities[name] === undefined) {
      throw new EnvironmentConfigurationError(
        `effect contract "${name}" has no capability implementation`,
      );
    }
  }
  for (const name of Object.keys(capabilities)) {
    if (!effectNames.has(name)) {
      throw new EnvironmentConfigurationError(
        `capability implementation "${name}" has no effect contract`,
      );
    }
  }
}
