import { describe, expect, test } from "bun:test";
import {
  WorkflowRecordValidationError,
  createStdlib,
  hydrateWorkflowRecord,
  prepareProgram,
  serializeWorkflowRecord,
  type JSONType,
  type PendingEffect,
  type WorkflowFailureCode,
  type WorkflowRecord,
} from "../src";
import { isRuntimeValue } from "../src/runtime-values";

const metadata = {
  workflowId: "workflow-1",
  revision: 2,
  deploymentId: "deployment-a",
  effectSequence: 3,
  fuelUsed: 42,
} as const;

const resume: JSONType = {
  $params: ["value"],
  $return: { $call: "pure", $args: [{ $var: "value" }] },
};

const pending: PendingEffect = {
  effectId: "workflow-1:2",
  name: "request",
  args: [{ input: true }],
  resume,
};

describe("workflow record codec", () => {
  test("round trips every workflow status and running basis", () => {
    const records: WorkflowRecord[] = [
      { ...metadata, status: "running", basis: { kind: "start", args: [1, "two"] } },
      {
        ...metadata,
        status: "running",
        basis: { kind: "resume", pending, result: { answer: 42 } },
      },
      { ...metadata, status: "suspended", pending },
      { ...metadata, status: "completed", result: { nested: [1, 2, 3] } },
      {
        ...metadata,
        status: "failed",
        failure: { code: "external", message: "worker stopped", payload: { retryable: false } },
      },
    ];

    for (const record of records) {
      const hydrated = hydrateWorkflowRecord(serializeWorkflowRecord(record));
      expect(hydrated).toEqual(record);
      if (hydrated.status === "suspended") {
        expect(isRuntimeValue(hydrated.pending.resume)).toBe(true);
      }
      if (hydrated.status === "running" && hydrated.basis.kind === "resume") {
        expect(isRuntimeValue(hydrated.basis.pending.resume)).toBe(true);
      }
    }
  });

  test("round trips every failure code", () => {
    const codes: WorkflowFailureCode[] = [
      "raise",
      "contract",
      "unknown-effect",
      "malformed-task",
      "limit",
      "host",
      "external",
    ];

    for (const code of codes) {
      const record: WorkflowRecord = {
        ...metadata,
        status: "failed",
        failure: { code, message: code },
      };
      expect(hydrateWorkflowRecord(serializeWorkflowRecord(record))).toEqual(record);
    }
  });

  test("rejects malformed records before serialization or hydration", () => {
    const malformed: Array<[unknown, string]> = [
      [null, "record"],
      [{}, "record.workflowId"],
      [{ ...metadata, status: "waiting" }, "record.status"],
      [{ ...metadata, revision: -1, status: "completed", result: null }, "record.revision"],
      [
        { ...metadata, effectSequence: 1.5, status: "completed", result: null },
        "record.effectSequence",
      ],
      [{ ...metadata, fuelUsed: -1, status: "completed", result: null }, "record.fuelUsed"],
      [{ ...metadata, status: "running", basis: { kind: "other" } }, "record.basis.kind"],
      [
        { ...metadata, status: "running", basis: { kind: "start", args: null } },
        "record.basis.args",
      ],
      [
        { ...metadata, status: "suspended", pending: { ...pending, effectId: "" } },
        "record.pending.effectId",
      ],
      [
        { ...metadata, status: "suspended", pending: { ...pending, args: null } },
        "record.pending.args",
      ],
      [
        { ...metadata, status: "suspended", pending: { ...pending, resume: null } },
        "record.pending.resume",
      ],
      [
        {
          ...metadata,
          status: "failed",
          failure: { code: "other", message: "no" },
        },
        "record.failure.code",
      ],
      [
        {
          ...metadata,
          status: "completed",
          result: null,
          pending,
        },
        "record.pending",
      ],
    ];

    for (const [value, path] of malformed) {
      expect(() => serializeWorkflowRecord(value as WorkflowRecord)).toThrow(
        WorkflowRecordValidationError,
      );
      expect(() => serializeWorkflowRecord(value as WorkflowRecord)).toThrow(path);
      expect(() => hydrateWorkflowRecord(JSON.stringify(value))).toThrow(path);
    }
    expect(() => hydrateWorkflowRecord("{")).toThrow(SyntaxError);
  });

  test("restores task inertness inside a hydrated continuation", () => {
    const nestedTask: JSONType = {
      "@task": "pure",
      value: { $call: "add", $args: [1, 2] },
    };
    const record: WorkflowRecord = {
      ...metadata,
      status: "suspended",
      pending: {
        ...pending,
        resume: { $params: [], $return: nestedTask },
      },
    };

    const hydrated = hydrateWorkflowRecord(serializeWorkflowRecord(record));
    if (hydrated.status !== "suspended") throw new Error("Expected suspended record");
    const runtime = prepareProgram({ main: { $params: [], $return: null } }, createStdlib());
    expect(runtime.call(hydrated.pending.resume, [])).toEqual(nestedTask);
  });
});
