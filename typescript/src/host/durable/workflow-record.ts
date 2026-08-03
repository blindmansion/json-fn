import { isFunctionBody } from "../../function-value";
import { assertStructuralDepth } from "../../structural-depth";
import type { JSONType } from "../../types";
import { markRuntimeValue } from "../../runtime-values";
import { assertTaskShapes, restoreRuntimeMarks } from "../task-serialization";

export type PendingEffect = {
  effectId: string;
  name: string;
  args: JSONType[];
  resume: JSONType;
};

export type RunningBasis =
  | { kind: "start"; args: JSONType[] }
  | { kind: "resume"; pending: PendingEffect; result: JSONType };

export type WorkflowFailureCode =
  | "raise"
  | "contract"
  | "unknown-effect"
  | "malformed-task"
  | "limit"
  | "host"
  | "external";

export type WorkflowFailure = {
  code: WorkflowFailureCode;
  message: string;
  payload?: JSONType;
};

type WorkflowMetadata = {
  workflowId: string;
  revision: number;
  deploymentId: string;
  effectSequence: number;
  fuelUsed: number;
};

export type WorkflowRecord = WorkflowMetadata &
  (
    | { status: "running"; basis: RunningBasis }
    | { status: "suspended"; pending: PendingEffect }
    | { status: "completed"; result: JSONType }
    | { status: "failed"; failure: WorkflowFailure }
  );

export class WorkflowRecordValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "WorkflowRecordValidationError";
  }
}

const COMMON_KEYS = [
  "workflowId",
  "revision",
  "deploymentId",
  "effectSequence",
  "fuelUsed",
  "status",
];
const FAILURE_CODES = new Set<WorkflowFailureCode>([
  "raise",
  "contract",
  "unknown-effect",
  "malformed-task",
  "limit",
  "host",
  "external",
]);

export function validateWorkflowRecord(value: unknown): asserts value is WorkflowRecord {
  // Records embed guest values and continuations; enforce the portable
  // structural-depth limit before serialization (`JSON.stringify`) or the
  // recursive re-mark walk can recurse on the host stack. Serialize and
  // hydrate both validate, so the one check covers both directions.
  assertStructuralDepth(value);
  if (!isObject(value)) fail("record", "expected an object");

  requireNonEmptyString(value.workflowId, "record.workflowId");
  requireNonNegativeInteger(value.revision, "record.revision");
  requireNonEmptyString(value.deploymentId, "record.deploymentId");
  requireNonNegativeInteger(value.effectSequence, "record.effectSequence");
  requireNonNegativeInteger(value.fuelUsed, "record.fuelUsed");

  switch (value.status) {
    case "running":
      assertOnlyKeys(value, [...COMMON_KEYS, "basis"], "record");
      validateRunningBasis(value.basis, "record.basis");
      return;
    case "suspended":
      assertOnlyKeys(value, [...COMMON_KEYS, "pending"], "record");
      validatePendingEffect(value.pending, "record.pending");
      return;
    case "completed":
      assertOnlyKeys(value, [...COMMON_KEYS, "result"], "record");
      if (!Object.prototype.hasOwnProperty.call(value, "result")) {
        fail("record.result", "field is required");
      }
      return;
    case "failed":
      assertOnlyKeys(value, [...COMMON_KEYS, "failure"], "record");
      validateWorkflowFailure(value.failure, "record.failure");
      return;
    default:
      fail("record.status", 'expected "running", "suspended", "completed", or "failed"');
  }
}

export function serializeWorkflowRecord(record: WorkflowRecord): string {
  validateWorkflowRecord(record);
  // Tagged shapes embedded in guest values (effect args, results, resume
  // bodies) are validated at persist time too, so a forged malformed task can
  // never poison a stored record and fail only at recovery.
  assertTaskShapes(record as unknown as JSONType, "record", fail);
  return JSON.stringify(record);
}

export function hydrateWorkflowRecord(serialized: string): WorkflowRecord {
  const value: unknown = JSON.parse(serialized);
  validateWorkflowRecord(value);

  // JSON parsing loses the WeakSet-backed runtime-value marks. The shared
  // rehydration pass validates every `@task`-tagged shape in the record and
  // restores marks to the validated task nodes; the record's own validated
  // continuation closures are then marked from their known workflow fields.
  restoreRuntimeMarks(value as unknown as JSONType, "record", fail);
  if (value.status === "suspended") {
    markRuntimeValue(value.pending.resume);
  } else if (value.status === "running" && value.basis.kind === "resume") {
    markRuntimeValue(value.basis.pending.resume);
  }
  return value;
}

function validateRunningBasis(value: unknown, path: string): asserts value is RunningBasis {
  if (!isObject(value)) fail(path, "expected an object");
  switch (value.kind) {
    case "start":
      assertOnlyKeys(value, ["kind", "args"], path);
      if (!Array.isArray(value.args)) fail(`${path}.args`, "expected an array");
      return;
    case "resume":
      assertOnlyKeys(value, ["kind", "pending", "result"], path);
      validatePendingEffect(value.pending, `${path}.pending`);
      if (!Object.prototype.hasOwnProperty.call(value, "result")) {
        fail(`${path}.result`, "field is required");
      }
      return;
    default:
      fail(`${path}.kind`, 'expected "start" or "resume"');
  }
}

function validatePendingEffect(value: unknown, path: string): asserts value is PendingEffect {
  if (!isObject(value)) fail(path, "expected an object");
  assertOnlyKeys(value, ["effectId", "name", "args", "resume"], path);
  requireNonEmptyString(value.effectId, `${path}.effectId`);
  requireNonEmptyString(value.name, `${path}.name`);
  if (!Array.isArray(value.args)) fail(`${path}.args`, "expected an array");
  if (!isFunctionBody(value.resume)) {
    fail(`${path}.resume`, "expected a continuation closure");
  }
}

function validateWorkflowFailure(value: unknown, path: string): asserts value is WorkflowFailure {
  if (!isObject(value)) fail(path, "expected an object");
  assertOnlyKeys(value, ["code", "message", "payload"], path);
  if (typeof value.code !== "string" || !FAILURE_CODES.has(value.code as WorkflowFailureCode)) {
    fail(`${path}.code`, "unknown failure code");
  }
  if (typeof value.message !== "string") fail(`${path}.message`, "expected a string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "expected a non-empty string");
  }
}

function requireNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "expected a non-negative integer");
  }
}

function fail(path: string, message: string): never {
  throw new WorkflowRecordValidationError(path, message);
}
