/**
 * Host trampoline — the async boundary where tasks meet the outside world.
 * The in-language task kernel is pure and synchronous; capabilities run here.
 */

import { isTaskReturn } from "../environment/environment";
import { getOwnProperty } from "../own-properties";
import type { JSONType } from "../types";
import type { PreparedLiveDeployment } from "./deployment";
import type { HostLocalRunOptions } from "./task-runtime";

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
 * Run a prepared module entry according to its portable contract. Task
 * entries are driven to completion by answering suspended host effects.
 */
export async function runTask(
  deployment: PreparedLiveDeployment,
  args: JSONType[],
  runOptions?: HostLocalRunOptions,
): Promise<JSONType> {
  const runtime = deployment.createTaskSession(runOptions);
  const checkedArgs = runtime.validateArgs(args);
  let result = runtime.invokeEntry(checkedArgs);

  if (isTaskReturn(deployment.contract.entry.returns)) {
    let task = result;
    for (;;) {
      const stepped = runtime.step(task);
      if ("done" in stepped) {
        result = stepped.done;
        break;
      }

      const { name, args: effectArgs, resume } = stepped.pending;
      const capability = getOwnProperty(deployment.effects, name);
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
