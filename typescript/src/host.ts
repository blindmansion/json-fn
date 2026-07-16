/**
 * Host trampoline — the async boundary where tasks meet the outside world
 * (`plans/effects-implementation.md` §4). The in-language kernel (`task.ts`,
 * `handle`) is pure and synchronous; this is where capabilities run I/O, where
 * unhandled effects become host errors, and where a suspended task can be
 * serialized for durable resume.
 *
 * The host is the *outermost handler*: an effect that no in-language `handle`
 * discharges bubbles all the way out to `runTask`, which either answers it from
 * the capability table or fails. `resume` is plain self-contained JSON (thanks
 * to escaping-closure capture), so suspend → persist → rehydrate → resume works
 * across process boundaries — the whole point of `serializeTask`/`hydrateTask`.
 */

import type { ExecutionLimits, FunctionRegistry, JSONType } from "./types";
import type { EffectManifest } from "./effects";
import type { CallableTypeRuleRegistry } from "./check/builtin-types";
import { prepareProgram } from "./evaluate";
import { loadBuiltinTable } from "./builtins";
import {
  EnvironmentConfigurationError,
  entryCompletionType,
  mergeCallableTables,
  validateEnvironment,
  type Environment,
} from "./environment";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "./definition-pool";
import { enforceRuntimeContract, RuntimeContractError } from "./runtime-contract";
import { isTask, stepTask, TASK_TAG } from "./task";
import { raw } from "./utils";

/** A host capability: answers one effect, synchronously or asynchronously. */
export type Capability = (...args: JSONType[]) => Promise<JSONType> | JSONType;

export type EnvironmentHostConfiguration = {
  registry: FunctionRegistry;
  capabilities: Record<string, Capability>;
  /** Accepted alongside runtime configuration for hosts that share one setup object with the checker. */
  typeRules?: CallableTypeRuleRegistry;
};

/** Thrown when a task performs `raise(err)` that no in-language handler caught;
 * carries the guest-supplied payload unchanged. */
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
 * suspended effect from the `capabilities` table. Loops:
 *
 *   1. normalize the current task to its suspended form (`stepTask`);
 *   2. `{ done }` → return the value;
 *   3. `{ pending }` → `raise` throws `TaskRaiseError`; an unknown effect throws
 *      `UnhandledEffectError`; otherwise `await` the capability and re-enter by
 *      applying `resume` to its result.
 *
 * `runTask` answers each `pending` exactly once. Durable workflows make
 * *at-least-once* effect execution the practical reality (a crash between
 * running a capability and persisting the resumed task reruns the effect on
 * recovery — same as Temporal); capabilities with external side effects should
 * therefore take idempotency keys. In-language multi-shot `resume` is a feature;
 * at the host boundary, replay is not free.
 */
export async function runTask(
  module: Record<string, JSONType>,
  environment: Environment,
  args: JSONType[],
  host: EnvironmentHostConfiguration,
  limits?: ExecutionLimits,
): Promise<JSONType> {
  const prepared = prepareEnvironmentRuntime(environment, host, module);
  const checkedArgs = enforceRuntimeContract(
    args,
    {
      type: "array",
      prefixItems: environment.entry.params,
      items: false,
    },
    prepared.defs,
    `entry "${environment.entry.name}" arguments`,
  ) as JSONType[];
  const result = await runTaskConfigured(
    module,
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
    const s = stepTask(task, call, meter);
    if ("done" in s) return s.done;

    const { name, args: effectArgs, resume } = s.pending;
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
    const normalized = value ?? null;
    const checked = enforceRuntimeContract(
      normalized,
      effect.returns,
      defs,
      `effect "${name}" result`,
    );
    task = call(resume, [checked]);
  }
}

function prepareEnvironmentRuntime(
  environment: Environment,
  host: EnvironmentHostConfiguration,
  module: Record<string, JSONType>,
): {
  registry: FunctionRegistry;
  definitions: DefinitionSources;
  defs: Record<string, JSONType>;
} {
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
        params: signature.params,
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

/**
 * Serialize a task to a JSON string for durable storage. The task graph is
 * already plain JSON — escaping-closure capture guarantees every embedded
 * continuation is self-contained — so this is an assert-and-stringify. The
 * runtime-only `raw()` inertness marks are *not* stored (they live in a
 * `WeakSet`); `hydrateTask` restores them.
 */
export function serializeTask(task: JSONType): string {
  if (!isTask(task)) {
    throw new Error("serializeTask: value is not a task");
  }
  return JSON.stringify(task);
}

/**
 * Parse a serialized task and restore the inertness lost to the `raw()`
 * `WeakSet`: every `@task` node is re-marked so the evaluator treats it as an
 * opaque value (not a data object) if it flows through a later hop as an
 * argument or result.
 *
 * Only `@task` nodes are marked — deliberately *not* the closure bodies nested
 * inside them. A continuation's inner closures are still live code: when a
 * resumed recursive continuation re-runs, it must capture its *next*
 * continuation, and `replaceVars` skips raw-marked bodies. Marking them would
 * freeze a captured `n`/sibling reference and break recursive `where`-local
 * loops across a resume. Constructors re-mark every task the resumed code
 * builds, so post-hop tasks stay inert regardless.
 */
export function hydrateTask(serialized: string): JSONType {
  const value = JSON.parse(serialized) as JSONType;
  remark(value);
  if (!isTask(value)) {
    throw new Error("hydrateTask: value is not a task");
  }
  return value;
}

function remark(value: JSONType): void {
  if (Array.isArray(value)) {
    for (const item of value) remark(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (typeof value[TASK_TAG] === "string") raw(value);
    for (const key of Object.keys(value)) remark(value[key]!);
  }
}

/**
 * Static admission check: the effect names a module (or an already-built task)
 * could ever perform, computed by a pure walk over the JSON — Effect.ts's `R`
 * parameter derived from data instead of tracked by types. A host can enumerate
 * what a program might ask for *before* running it and reject at admission time
 * rather than hitting `UnhandledEffectError` mid-run.
 *
 * Collects the literal first argument of every `perform(name, …)` call, an
 * implicit `"raise"` for every `raise(…)` call, and the `name` of every
 * embedded `@task` effect node. This is a conservative over-approximation: it
 * does not subtract effects an in-language `handle` discharges (proving
 * discharge needs dataflow the walk deliberately avoids), and `perform` with a
 * non-literal name sets `dynamic` so hosts can refuse programs whose effect set
 * is not statically known.
 */
export type RequiredCapabilities = { names: string[]; dynamic: boolean };

export function requiredCapabilities(node: JSONType): RequiredCapabilities {
  const names = new Set<string>();
  let dynamic = false;

  const walk = (value: JSONType): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;

    // Embedded task node: an `effect` carries its name directly.
    if (typeof value[TASK_TAG] === "string") {
      if (value[TASK_TAG] === "effect") {
        const name = value.name;
        if (typeof name === "string") names.add(name);
        else dynamic = true;
      }
    }

    // `perform(name, args)` / `raise(err)` calls.
    const callee = value.$call;
    const callArgs = value.$args;
    if (typeof callee === "string" && Array.isArray(callArgs)) {
      if (callee === "perform") {
        const name = callArgs[0];
        if (typeof name === "string") names.add(name);
        else dynamic = true;
      } else if (callee === "raise") {
        names.add("raise");
      }
    }

    for (const key of Object.keys(value)) walk(value[key]!);
  };

  walk(node);
  return { names: [...names].sort(), dynamic };
}

function safeStringify(value: JSONType): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
