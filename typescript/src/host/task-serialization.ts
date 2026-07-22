import { isTask, TASK_TAG } from "../task";
import type { JSONType } from "../types";
import { raw } from "../utils";

/**
 * Serialize a task for durable storage. Escaping-closure capture makes the task
 * graph self-contained JSON; runtime-only inertness marks are restored on load.
 */
export function serializeTask(task: JSONType): string {
  if (!isTask(task)) {
    throw new Error("serializeTask: value is not a task");
  }
  return JSON.stringify(task);
}

/** Parse a serialized task and restore runtime-only task inertness marks. */
export function hydrateTask(serialized: string): JSONType {
  const value = JSON.parse(serialized) as JSONType;
  remarkTaskNodes(value);
  if (!isTask(value)) {
    throw new Error("hydrateTask: value is not a task");
  }
  return value;
}

export function remarkTaskNodes(value: JSONType): void {
  if (Array.isArray(value)) {
    for (const item of value) remarkTaskNodes(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (typeof value[TASK_TAG] === "string") raw(value);
    for (const key of Object.keys(value)) remarkTaskNodes(value[key]!);
  }
}
