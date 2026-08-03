import type { EffectManifest } from "../environment/effect-types";
import { entryCompletionType } from "../environment/environment";
import { getOwnProperty } from "../own-properties";
import { prepareProgram } from "../eval";
import { enforceRuntimeContract, RuntimeContractError } from "../runtime-contract";
import { stepTask } from "../task";
import type { ExecutionLimits, JSONType, PerfStats, ExecutionUsage } from "../types";
import type { PreparedDeployment } from "./deployment";

export type PendingStep = {
  name: string;
  args: JSONType[];
  resume: JSONType;
};

export type HostLocalRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  perf?: PerfStats;
  usage?: ExecutionUsage;
};

export type TaskSession = {
  validateArgs(args: JSONType[]): JSONType[];
  invokeEntry(args: JSONType[]): JSONType;
  step(task: JSONType): { done: JSONType } | { pending: PendingStep };
  applyResume(resume: JSONType, name: string, result: JSONType): JSONType;
  validateCompletion(value: JSONType): JSONType;
  refreshDeadline(): void;
  fuelUsed(): number;
};

export class RunOptionsValidationError extends Error {
  readonly code = "INVALID_RUN_OPTIONS";
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "RunOptionsValidationError";
  }
}

/** Thrown when a task performs `raise(err)` that no in-language handler caught. */
export class TaskRaiseError extends Error {
  readonly payload: JSONType;
  constructor(payload: JSONType) {
    super(`Unhandled raise: ${safeStringify(payload)}`);
    this.name = "TaskRaiseError";
    this.payload = payload;
  }
}

export function createTaskSession(
  deployment: PreparedDeployment,
  runOptions: HostLocalRunOptions = {},
): TaskSession {
  for (const key of Object.keys(runOptions)) {
    if (!new Set(["signal", "timeoutMs", "perf", "usage"]).has(key)) {
      throw new RunOptionsValidationError(
        `runOptions.${key}`,
        "portable execution limits must come from the deployment profile",
      );
    }
  }
  const { contract, linked, registry, profile } = deployment;
  const effects = contract.effects ?? {};
  const usage = runOptions.usage ?? { fuel: 0 };
  const limits: ExecutionLimits = { ...profile.limits, ...runOptions, usage };
  const prepared = prepareProgram(
    linked.module as Record<string, JSONType>,
    registry,
    limits,
    linked.definitionSources,
  );
  const defs = linked.definitions;

  const effectContract = (name: string): EffectManifest[string] => {
    const effect = getOwnProperty(effects, name);
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
          prefixItems: [...contract.entry.required, ...contract.entry.optional],
          items: false,
          minItems: contract.entry.required.length,
        },
        defs,
        `entry "${contract.entry.name}" arguments`,
        "args",
      ) as JSONType[];
    },

    invokeEntry(args) {
      return prepared.invokeEntry(contract.entry.name, args);
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
        "args",
      );
      return stepped;
    },

    applyResume(resume, name, result) {
      const checked = enforceRuntimeContract(
        result ?? null,
        effectContract(name).returns,
        defs,
        `effect "${name}" result`,
        "result",
      );
      return prepared.call(resume, [checked]);
    },

    validateCompletion(value) {
      return enforceRuntimeContract(
        value,
        entryCompletionType(contract.entry.returns),
        defs,
        `entry "${contract.entry.name}" result`,
        "result",
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
