import { assertStructuralDepth } from "../structural-depth";
import { isTask, TASK_TAG, taskNodeShapeProblem } from "../task";
import type { JSONType } from "../types";
import { markRuntimeValue } from "../runtime-values";

/**
 * Thrown when serialization or hydration encounters a malformed or unknown
 * `@task`-tagged shape. The path locates the offending node inside the
 * serialized value.
 */
export class TaskShapeValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "TaskShapeValidationError";
  }
}

function failTaskShape(path: string, message: string): never {
  throw new TaskShapeValidationError(path, message);
}

/**
 * Validate every `@task`-tagged object reachable in `value` against the exact
 * constructor shapes (`taskNodeShapeProblem`). Malformed or unknown tagged
 * shapes are rejected here — at the serialization boundary — rather than left
 * for evaluation to trip over after recovery. Iterative walk: guest data of
 * any depth must not exhaust the host stack (callers still enforce the
 * portable structural-depth limit first so the error is deterministic).
 */
export function assertTaskShapes(
  value: JSONType,
  rootPath: string,
  fail: (path: string, message: string) => never = failTaskShape,
): void {
  // Happy-path walk carries no per-node paths (this runs on every serialize
  // and hydrate); the path is reconstructed only when a node fails.
  const stack: JSONType[] = [value];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(node, TASK_TAG)) {
      const problem = taskNodeShapeProblem(node);
      if (problem !== undefined) failAtNodePath(value, node, rootPath, problem, fail);
    }
    for (const key of Object.keys(node)) stack.push(node[key]!);
  }
}

// Failure path only: re-walk with path tracking to locate the malformed node.
function failAtNodePath(
  root: JSONType,
  target: object,
  rootPath: string,
  problem: string,
  fail: (path: string, message: string) => never,
): never {
  const stack: Array<{ node: JSONType; path: string }> = [{ node: root, path: rootPath }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === target) fail(path, problem);
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i]!, path: `${path}[${i}]` });
      }
      continue;
    }
    for (const key of Object.keys(node)) {
      stack.push({ node: node[key]!, path: `${path}.${key}` });
    }
  }
  fail(rootPath, problem);
}

/**
 * The centralized rehydration pass shared by `hydrateTask` and
 * `hydrateWorkflowRecord` (`plans/raw-semantics-cleanup.md`, Workstream D).
 * JSON parsing loses the WeakSet-backed runtime-value marks; this pass first
 * validates every tagged shape in the decoded value, then restores marks to
 * the validated task nodes — never to malformed or unknown tagged data.
 * Record-specific fields (e.g. a workflow record's validated `resume`
 * continuations) are marked by their own hydrators after this pass.
 */
export function restoreRuntimeMarks(
  value: JSONType,
  rootPath: string,
  fail: (path: string, message: string) => never = failTaskShape,
): void {
  assertTaskShapes(value, rootPath, fail);
  markValidatedTaskNodes(value);
}

// Mark every task node in a value whose tagged shapes have all been validated.
function markValidatedTaskNodes(value: JSONType): void {
  const stack: JSONType[] = [value];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(node, TASK_TAG)) markRuntimeValue(node);
    for (const key of Object.keys(node)) stack.push(node[key]!);
  }
}

/**
 * Serialize a task for durable storage. Escaping-closure capture makes the task
 * graph self-contained JSON; runtime-value marks are restored on load. Tagged
 * shapes are validated here so a forged malformed node fails at persist time,
 * not at recovery.
 */
export function serializeTask(task: JSONType): string {
  if (!isTask(task)) {
    throw new Error("serializeTask: value is not a task");
  }
  // JSON.stringify recurses on the host stack; enforce the portable
  // structural-depth limit first so an over-deep task graph fails with the
  // deterministic limit error instead of a host RangeError.
  assertStructuralDepth(task);
  assertTaskShapes(task, "task");
  return JSON.stringify(task);
}

/**
 * Parse a serialized task, validate every tagged shape, and restore
 * runtime-value marks on the validated task nodes.
 */
export function hydrateTask(serialized: string): JSONType {
  const value = JSON.parse(serialized) as JSONType;
  // Reject over-deep records before the validating re-mark walk below.
  assertStructuralDepth(value);
  if (!isTask(value)) {
    throw new Error("hydrateTask: value is not a task");
  }
  restoreRuntimeMarks(value, "task");
  return value;
}
