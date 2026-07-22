import { EnvironmentConfigurationError, isTaskReturn } from "../../environment/environment";
import type { Environment } from "../../environment/types";
import type { ExecutionLimits, FunctionRegistry, JSONType } from "../../types";

export type DurableEffectMode = "inline" | "suspending";

export type DurableEffectContext = {
  workflowId: string;
  effectId: string;
};

export type DurableCapability = (
  context: DurableEffectContext,
  ...args: JSONType[]
) => Promise<JSONType> | JSONType;

export type DurableHostConfiguration = {
  registry: FunctionRegistry;
  effects: Record<string, DurableEffectMode>;
  capabilities: Record<string, DurableCapability>;
  deploymentId: string;
  limits?: ExecutionLimits;
};

/** Validate the durable host's mode classification against its environment. */
export function validateDurableHostConfiguration(
  environment: Environment,
  host: DurableHostConfiguration,
): void {
  if (host === undefined || typeof host !== "object" || host === null) {
    throw new EnvironmentConfigurationError("durable execution requires host configuration");
  }
  if (!isTaskReturn(environment.entry.returns)) {
    throw new EnvironmentConfigurationError("durable execution requires a task entry");
  }
  if (host.registry === undefined || typeof host.registry !== "object" || host.registry === null) {
    throw new EnvironmentConfigurationError("durable execution requires a registry");
  }
  if (!isRecord(host.effects)) {
    throw new EnvironmentConfigurationError("durable execution requires effect classifications");
  }
  if (!isRecord(host.capabilities)) {
    throw new EnvironmentConfigurationError("durable execution requires inline capabilities");
  }
  if (typeof host.deploymentId !== "string" || host.deploymentId.length === 0) {
    throw new EnvironmentConfigurationError("durable execution requires a non-empty deploymentId");
  }

  const environmentEffects = new Set(Object.keys(environment.effects ?? {}));
  if (
    environmentEffects.has("raise") ||
    Object.prototype.hasOwnProperty.call(host.effects, "raise")
  ) {
    throw new EnvironmentConfigurationError('"raise" is intrinsic and cannot be classified');
  }
  if (Object.prototype.hasOwnProperty.call(host.capabilities, "raise")) {
    throw new EnvironmentConfigurationError('"raise" is intrinsic and cannot have a capability');
  }

  for (const name of environmentEffects) {
    if (!Object.prototype.hasOwnProperty.call(host.effects, name)) {
      throw new EnvironmentConfigurationError(
        `effect contract "${name}" has no durable classification`,
      );
    }
  }
  for (const [name, mode] of Object.entries(host.effects)) {
    if (!environmentEffects.has(name)) {
      throw new EnvironmentConfigurationError(
        `durable classification "${name}" has no effect contract`,
      );
    }
    if (mode !== "inline" && mode !== "suspending") {
      throw new EnvironmentConfigurationError(
        `effect "${name}" has unknown durable classification "${String(mode)}"`,
      );
    }
  }

  const inlineEffects = new Set(
    Object.entries(host.effects)
      .filter(([, mode]) => mode === "inline")
      .map(([name]) => name),
  );
  for (const name of inlineEffects) {
    if (typeof host.capabilities[name] !== "function") {
      throw new EnvironmentConfigurationError(
        `inline effect "${name}" has no capability implementation`,
      );
    }
  }
  for (const name of Object.keys(host.capabilities)) {
    if (!inlineEffects.has(name)) {
      throw new EnvironmentConfigurationError(
        `capability implementation "${name}" has no inline effect classification`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
