import { describe, expect, test } from "bun:test";
import {
  TaskShapeValidationError,
  WorkflowRecordValidationError,
  hydrateTask,
  hydrateWorkflowRecord,
  serializeTask,
  serializeWorkflowRecord,
  type JSONType,
  type WorkflowRecord,
} from "../src";
import { bindTask, effectTask, pureTask } from "../src/task";
import { isRuntimeValue } from "../src/runtime-values";

const marked = (value: JSONType): boolean => isRuntimeValue(value as object);

const thenClosure: JSONType = {
  $params: ["x"],
  $return: { $call: "pure", $args: [{ $var: "x" }] },
};

const resume: JSONType = {
  $params: ["value"],
  $return: { $call: "pure", $args: [{ $var: "value" }] },
};

const metadata = {
  workflowId: "rehydration",
  revision: 0,
  deploymentId: "test",
  effectSequence: 1,
  fuelUsed: 0,
} as const;

// A task graph exercising every node kind, with a task nested inside guest
// data (the effect's args).
function makeTaskGraph(): JSONType {
  return bindTask(effectTask("ask", [pureTask({ nested: true })]), thenClosure);
}

describe("centralized task rehydration", () => {
  test("direct: constructors mark every task node kind", () => {
    const graph = makeTaskGraph() as Record<string, JSONType>;
    expect(marked(graph)).toBe(true); // bind
    expect(marked(graph.task!)).toBe(true); // effect
    const args = (graph.task as Record<string, JSONType>).args as JSONType[];
    expect(marked(args[0]!)).toBe(true); // nested pure
  });

  test("serialized: hydrateTask restores marks on every validated task node", () => {
    const hydrated = hydrateTask(serializeTask(makeTaskGraph())) as Record<string, JSONType>;

    expect(marked(hydrated)).toBe(true); // bind
    const effect = hydrated.task as Record<string, JSONType>;
    expect(marked(effect)).toBe(true); // effect
    expect(marked((effect.args as JSONType[])[0]!)).toBe(true); // nested pure

    // Continuations stay live syntax: `then` is a function declaration, not a
    // runtime value, so closure capture can still walk it.
    expect(marked(hydrated.then!)).toBe(false);
  });

  test("durable: hydrateWorkflowRecord restores task nodes and resume continuations", () => {
    const suspended: WorkflowRecord = {
      ...metadata,
      status: "suspended",
      pending: {
        effectId: "rehydration:0",
        name: "ask",
        args: [pureTask({ nested: true })],
        resume,
      },
    };
    const hydratedSuspended = hydrateWorkflowRecord(serializeWorkflowRecord(suspended));
    if (hydratedSuspended.status !== "suspended") throw new Error("expected suspended");
    expect(marked(hydratedSuspended.pending.resume)).toBe(true);
    expect(marked(hydratedSuspended.pending.args[0]!)).toBe(true);

    const running: WorkflowRecord = {
      ...metadata,
      status: "running",
      basis: {
        kind: "resume",
        pending: { effectId: "rehydration:0", name: "ask", args: [], resume },
        result: { carried: effectTask("noop", []) },
      },
    };
    const hydratedRunning = hydrateWorkflowRecord(serializeWorkflowRecord(running));
    if (hydratedRunning.status !== "running" || hydratedRunning.basis.kind !== "resume") {
      throw new Error("expected running/resume");
    }
    expect(marked(hydratedRunning.basis.pending.resume)).toBe(true);
    const result = hydratedRunning.basis.result as Record<string, JSONType>;
    expect(marked(result.carried!)).toBe(true);
  });

  test("hydrateTask rejects malformed and unknown tagged shapes with their path", () => {
    const cases: Array<[JSONType, string]> = [
      [{ "@task": "bogus" }, 'task: unknown @task tag "bogus"'],
      [{ "@task": "pure", value: { "@task": 42 } }, "task.value: unknown @task tag 42"],
      [
        { "@task": "pure", value: [{ "@task": "effect", name: 7, args: [] }] },
        "task.value[0]: effect `name` must be a string",
      ],
      [
        { "@task": "pure", value: { "@task": "effect", name: "x", args: null } },
        "task.value: effect `args` must be an array",
      ],
      [{ "@task": "pure", value: 1, extra: true }, 'task: pure task has unsupported field "extra"'],
      [{ "@task": "bind", task: null }, 'task: bind task field "then" is required'],
      // eslint-disable-next-line no-thenable -- `then` is the spec'd task field name, not a Promise
      [{ "@task": "bind", task: null, then: 42 }, "task: bind `then` must be a function"],
    ];
    for (const [value, message] of cases) {
      expect(() => hydrateTask(JSON.stringify(value))).toThrow(TaskShapeValidationError);
      expect(() => hydrateTask(JSON.stringify(value))).toThrow(message);
    }
  });

  test("serializeTask rejects malformed tagged shapes at persist time", () => {
    const forged: JSONType = { "@task": "pure", value: { "@task": "bogus" } };
    expect(() => serializeTask(forged)).toThrow(TaskShapeValidationError);
    expect(() => serializeTask(forged)).toThrow('task.value: unknown @task tag "bogus"');
  });

  test("workflow records reject malformed tagged shapes in both directions", () => {
    const record = {
      ...metadata,
      status: "suspended",
      pending: {
        effectId: "rehydration:0",
        name: "ask",
        args: [{ "@task": "effect", name: "forged" }],
        resume,
      },
    } as unknown as WorkflowRecord;

    const path = 'record.pending.args[0]: effect task field "args" is required';
    expect(() => serializeWorkflowRecord(record)).toThrow(WorkflowRecordValidationError);
    expect(() => serializeWorkflowRecord(record)).toThrow(path);
    expect(() => hydrateWorkflowRecord(JSON.stringify(record))).toThrow(
      WorkflowRecordValidationError,
    );
    expect(() => hydrateWorkflowRecord(JSON.stringify(record))).toThrow(path);
  });
});
