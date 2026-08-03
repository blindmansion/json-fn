import { loadBuiltinTable } from "../../builtins";
import type { CallableEntry } from "../../check/builtin-types";
import { isTaskReturn } from "../../environment/environment";
import type { EnvironmentContract } from "../../environment/types";
import { linkModule, type LinkedModule } from "../../module-linker";
import { enforceRuntimeContract } from "../../runtime-contract";
import { setOwnProperty } from "../../own-properties";
import type { FunctionRegistry, JSONType } from "../../types";
import { createStdlib } from "../../stdlib";
import type { DurableCapability } from "../durable/config";
import { createTaskSession, type HostLocalRunOptions, type TaskSession } from "../task-runtime";
import {
  validateDeploymentProfile,
  type DeploymentProfile,
  type DurableDeploymentProfile,
  type LiveDeploymentProfile,
} from "./profile";

export type DeploymentFunction = (...args: JSONType[]) => JSONType;
export type DeploymentFunctions = Record<string, DeploymentFunction>;
export type Capability = (...args: JSONType[]) => Promise<JSONType> | JSONType;

export type LiveRuntimeAdapter = {
  functions: DeploymentFunctions;
  effects: Record<string, Capability>;
};

export type DurableRuntimeAdapter = {
  functions: DeploymentFunctions;
  effects: Record<string, DurableCapability>;
};

export type RuntimeAdapter = LiveRuntimeAdapter | DurableRuntimeAdapter;

type PreparedDeploymentBase = {
  contract: EnvironmentContract;
  linked: LinkedModule;
  registry: FunctionRegistry;
  createTaskSession(runOptions?: HostLocalRunOptions): TaskSession;
};

export type PreparedLiveDeployment = PreparedDeploymentBase & {
  mode: "live";
  profile: LiveDeploymentProfile;
  effects: Readonly<Record<string, Capability>>;
};

export type PreparedDurableDeployment = PreparedDeploymentBase & {
  mode: "durable";
  profile: DurableDeploymentProfile;
  effects: Readonly<Record<string, DurableCapability>>;
};

export type PreparedDeployment = PreparedLiveDeployment | PreparedDurableDeployment;

export class AdapterLinkError extends Error {
  constructor(
    readonly code:
      | "MISSING_ADAPTER_FUNCTION"
      | "EXTRA_ADAPTER_FUNCTION"
      | "MISSING_ADAPTER_EFFECT"
      | "EXTRA_ADAPTER_EFFECT"
      | "EXTRA_ADAPTER_FIELD"
      | "INVALID_ADAPTER_IMPLEMENTATION"
      | "INVALID_DURABLE_ENTRY",
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "AdapterLinkError";
  }
}

type PrepareDeploymentBase = {
  module: Record<string, JSONType>;
  contract: EnvironmentContract;
};

export function prepareDeployment(
  options: PrepareDeploymentBase & {
    profile: LiveDeploymentProfile;
    adapter: LiveRuntimeAdapter;
  },
): PreparedLiveDeployment;
export function prepareDeployment(
  options: PrepareDeploymentBase & {
    profile: DurableDeploymentProfile;
    adapter: DurableRuntimeAdapter;
  },
): PreparedDurableDeployment;
export function prepareDeployment(options: {
  module: Record<string, JSONType>;
  contract: EnvironmentContract;
  profile: DeploymentProfile;
  adapter: RuntimeAdapter;
}): PreparedLiveDeployment | PreparedDurableDeployment {
  const { module, contract, profile, adapter } = options;
  validateDeploymentProfile(profile, contract);
  if (profile.mode === "durable" && !isTaskReturn(contract.entry.returns)) {
    throw new AdapterLinkError(
      "INVALID_DURABLE_ENTRY",
      "contract.entry.returns",
      "durable execution requires a task entry",
    );
  }

  const builtinContracts = loadBuiltinTable();
  const linked = linkModule({ module, builtins: builtinContracts, contract });
  const adapterRecord = requireRecord(adapter, "adapter");
  for (const key of Object.keys(adapterRecord)) {
    if (key !== "functions" && key !== "effects") {
      throw new AdapterLinkError(
        "EXTRA_ADAPTER_FIELD",
        `adapter.${key}`,
        "unsupported adapter field",
      );
    }
  }
  const functions = requireRecord(adapterRecord.functions, "adapter.functions");
  const effects = requireRecord(adapterRecord.effects, "adapter.effects");
  validateExactBindings(functions, contract.functions ?? {}, "function");

  const selectedEffects =
    profile.mode === "live"
      ? new Set(profile.effects)
      : new Set(
          Object.entries(profile.effects)
            .filter(([, classification]) => classification === "inline")
            .map(([name]) => name),
        );
  validateExactEffectBindings(effects, selectedEffects);

  const registry = wrapContractFunctions(createStdlib(), functions, contract, linked);
  const base = { contract, linked, registry };
  const deployment: PreparedDeployment =
    profile.mode === "live"
      ? {
          ...base,
          mode: "live",
          profile,
          effects: Object.freeze({ ...(effects as Record<string, Capability>) }),
          createTaskSession(runOptions) {
            return createTaskSession(deployment, runOptions);
          },
        }
      : {
          ...base,
          mode: "durable",
          profile,
          effects: Object.freeze({ ...(effects as Record<string, DurableCapability>) }),
          createTaskSession(runOptions) {
            return createTaskSession(deployment, runOptions);
          },
        };
  return Object.freeze(deployment);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdapterLinkError("INVALID_ADAPTER_IMPLEMENTATION", path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function validateExactBindings(
  implementations: Record<string, unknown>,
  contracts: Record<string, CallableEntry>,
  kind: "function",
): void {
  for (const name of Object.keys(contracts)) {
    if (!Object.hasOwn(implementations, name)) {
      throw new AdapterLinkError(
        "MISSING_ADAPTER_FUNCTION",
        `adapter.functions.${name}`,
        `missing implementation for contract ${kind} "${name}"`,
      );
    }
    if (typeof implementations[name] !== "function") {
      throw new AdapterLinkError(
        "INVALID_ADAPTER_IMPLEMENTATION",
        `adapter.functions.${name}`,
        "expected a function",
      );
    }
  }
  for (const name of Object.keys(implementations)) {
    if (!Object.hasOwn(contracts, name)) {
      throw new AdapterLinkError(
        "EXTRA_ADAPTER_FUNCTION",
        `adapter.functions.${name}`,
        `implementation has no contract function "${name}"`,
      );
    }
  }
}

function validateExactEffectBindings(
  implementations: Record<string, unknown>,
  selected: Set<string>,
): void {
  for (const name of selected) {
    if (!Object.hasOwn(implementations, name)) {
      throw new AdapterLinkError(
        "MISSING_ADAPTER_EFFECT",
        `adapter.effects.${name}`,
        `missing implementation for selected effect "${name}"`,
      );
    }
    if (typeof implementations[name] !== "function") {
      throw new AdapterLinkError(
        "INVALID_ADAPTER_IMPLEMENTATION",
        `adapter.effects.${name}`,
        "expected a function",
      );
    }
  }
  for (const name of Object.keys(implementations)) {
    if (!selected.has(name)) {
      throw new AdapterLinkError(
        "EXTRA_ADAPTER_EFFECT",
        `adapter.effects.${name}`,
        `implementation is not selected by the profile`,
      );
    }
  }
}

function wrapContractFunctions(
  stdlib: FunctionRegistry,
  implementations: Record<string, unknown>,
  contract: EnvironmentContract,
  linked: LinkedModule,
): FunctionRegistry {
  const registry: FunctionRegistry = { ...stdlib };
  for (const [name, callable] of Object.entries(contract.functions ?? {})) {
    const implementation = implementations[name] as FunctionRegistry[string];
    const alias = `@adapter:${name}`;
    setOwnProperty(registry, alias, implementation);
    const arms = callable.signatures.map((signature) => ({
      $fnType: {
        required: signature.required.map(eraseTypeVariables),
        optional: signature.optional.map(eraseTypeVariables),
        ...(signature.rest === undefined ? {} : { rest: eraseTypeVariables(signature.rest) }),
        returns: eraseTypeVariables(signature.returns),
      },
    }));
    setOwnProperty(
      registry,
      name,
      enforceRuntimeContract(
        alias,
        arms.length === 1 ? arms[0]! : { anyOf: arms },
        linked.definitions,
        `host function "${name}"`,
      ) as FunctionRegistry[string],
    );
  }
  return registry;
}

function eraseTypeVariables(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(eraseTypeVariables);
  if (value === null || typeof value !== "object") return value;
  if ("$tvar" in value) return true;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, eraseTypeVariables(child)]),
  );
}
