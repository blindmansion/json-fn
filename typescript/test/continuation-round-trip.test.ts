import { describe, expect, test } from "bun:test";
import {
  createStdlib,
  hydrateTask,
  parseShorthand,
  prepareProgram,
  raw,
  serializeTask,
  stepTask,
  type JSONType,
  type Suspended,
} from "../src";

const stdlib = createStdlib();

function parseModule(source: string): Record<string, JSONType> {
  return parseShorthand(source) as Record<string, JSONType>;
}

function freshModule(module: Record<string, JSONType>): Record<string, JSONType> {
  return JSON.parse(JSON.stringify(module)) as Record<string, JSONType>;
}

function expectPending(stepped: Suspended): Extract<Suspended, { pending: unknown }>["pending"] {
  if ("done" in stepped) throw new Error(`Expected a pending task, got ${JSON.stringify(stepped)}`);
  return stepped.pending;
}

function expectDone(stepped: Suspended): JSONType {
  if ("pending" in stepped) {
    throw new Error(
      `Expected a completed task, got effect ${JSON.stringify(stepped.pending.name)}`,
    );
  }
  return stepped.done;
}

function startInFreshRuntime(module: Record<string, JSONType>): Suspended {
  const creator = prepareProgram(freshModule(module), stdlib);
  const serializedTask = serializeTask(creator.invokeEntry("main", []));

  const runtime = prepareProgram(freshModule(module), stdlib);
  return stepTask(hydrateTask(serializedTask), runtime.call, runtime.meter);
}

function resumeInFreshRuntime(
  module: Record<string, JSONType>,
  resume: JSONType,
  result: JSONType,
): Suspended {
  // A workflow record will restore both kinds of runtime-only inertness:
  // recursively re-mark embedded task nodes, then re-mark the resume closure.
  const carrier = serializeTask({ "@task": "pure", value: resume });
  const hydratedCarrier = hydrateTask(carrier) as Record<string, JSONType>;
  const hydratedResume = raw(hydratedCarrier.value!);

  const runtime = prepareProgram(freshModule(module), stdlib);
  const task = runtime.call(hydratedResume, [result]);
  return stepTask(task, runtime.call, runtime.meter);
}

describe("durable continuation round trips", () => {
  test("preserves recursive locals through nested tasks and a multi-effect do chain", () => {
    const module = parseModule(`{
      main: () => do {
        first <- perform("first", [2]),
        second <- nested(first),
        pure(countdown(second))
      } where {
        nested: (value) => do {
          next <- perform("second", [value + 1]),
          pure(next * 2)
        },
        countdown: (value) =>
          if value <= 0 then 0 else 1 + countdown(value - 1)
      }
    }`);

    const first = expectPending(startInFreshRuntime(module));
    expect({ name: first.name, args: first.args }).toEqual({ name: "first", args: [2] });

    const second = expectPending(resumeInFreshRuntime(module, first.resume, 3));
    expect({ name: second.name, args: second.args }).toEqual({ name: "second", args: [4] });

    expect(expectDone(resumeInFreshRuntime(module, second.resume, 5))).toBe(10);
  });

  test("re-enters an in-language handler wrapped around the suspension point", () => {
    const module = parseModule(`{
      main: () => handle do {
        external <- perform("external", ["request"]),
        local <- perform("local", [external]),
        pure(local + 1)
      } with {
        local: (value, resume) => resume(value * 2)
      }
    }`);

    const pending = expectPending(startInFreshRuntime(module));
    expect({ name: pending.name, args: pending.args }).toEqual({
      name: "external",
      args: ["request"],
    });

    expect(expectDone(resumeInFreshRuntime(module, pending.resume, 4))).toBe(9);
  });

  test("preserves accumulated manual state-transformer state across suspension", () => {
    const module = parseModule(`{
      main: () => (handle perform("record", ["before"]) with {
        record: (message, resume) => (state) =>
          bind(
            perform("external", [message]),
            (answer) => resume(answer)(concat(state, [message, answer]))
          ),
        "return": (value) => (state) => pure({ value: value, state: state })
      })(["seed"])
    }`);

    const pending = expectPending(startInFreshRuntime(module));
    expect({ name: pending.name, args: pending.args }).toEqual({
      name: "external",
      args: ["before"],
    });

    expect(expectDone(resumeInFreshRuntime(module, pending.resume, "ok"))).toEqual({
      value: "ok",
      state: ["seed", "before", "ok"],
    });
  });
});
