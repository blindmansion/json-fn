/**
 * Effect orchestration with large payloads.
 *
 * Flow-through fetches a payload on every hop and consumes it immediately.
 * Captured fetches once, then carries that payload through every pending
 * continuation. A payload-size slope in captured but not flow-through exposes
 * repeated closure substitution/evaluation work. Serialization is measured
 * separately because durable persistence is intentionally O(payload).
 */

import {
  createStdlib,
  parseShorthand,
  prepareProgram,
  runTask,
  serializeTask,
  stepTask,
} from "../../src";
import type { Environment, ExecutionLimits, JSONType } from "../../src";
import type { BenchDef, Mode, Suite } from "../harness";
import { withMetrics } from "../harness";
import { makeRecords } from "../data";

const registry = createStdlib();
const HOPS = 8;

const flowThrough = parseShorthand(`{
  run: (hops) => go(hops, 0),
  go: (k, acc) => if k <= 0 then pure(acc)
    else bind(perform("fetch", [k]), (rows) => go(k - 1, acc + length(rows)))
}`) as Record<string, JSONType>;

const captured = parseShorthand(`{
  run: (hops) => bind(perform("fetch", [0]), (rows) => loop(rows, hops, 0)),
  loop: (rows, k, acc) => if k <= 0 then pure(acc + length(rows))
    else bind(perform("ping", [k]), (x) => loop(rows, k - 1, acc + x))
}`) as Record<string, JSONType>;

const flowThroughEnvironment = parseShorthand(`{
  run: (hops) => go(hops, 0),
  go: (k, acc) => if k <= 0 then pure(acc)
    else bind(effects.fetch(k), (rows) => go(k - 1, acc + length(rows)))
}`) as Record<string, JSONType>;

const capturedEnvironment = parseShorthand(`{
  run: (hops) => bind(effects.fetch(0), (rows) => loop(rows, hops, 0)),
  loop: (rows, k, acc) => if k <= 0 then pure(acc + length(rows))
    else bind(effects.ping(k), (x) => loop(rows, k - 1, acc + x))
}`) as Record<string, JSONType>;

const anySchema = true as unknown as Record<string, never>;
const environment = {
  effects: {
    fetch: { params: [{ type: "number" }], returns: anySchema },
    ping: { params: [{ type: "number" }], returns: { type: "number" } },
  },
  entry: {
    name: "run",
    required: [{ type: "number" }],
    optional: [],
    returns: { task: { type: "number" } },
  },
} as unknown as Environment;

function manualTrampoline(
  module: Record<string, JSONType>,
  rows: JSONType,
  limits: ExecutionLimits,
): JSONType {
  const { invokeEntry, call, meter } = prepareProgram(module, registry, limits);
  let task = invokeEntry("run", [HOPS]);
  for (;;) {
    const stepped = stepTask(task, call, meter);
    if ("done" in stepped) return stepped.done;
    const { name, resume } = stepped.pending;
    const value = name === "fetch" ? rows : 1;
    task = call(resume, [value]);
  }
}

function suspendedCapturedTask(rows: JSONType): JSONType {
  const { invokeEntry, call, meter } = prepareProgram(captured, registry);
  const first = stepTask(invokeEntry("run", [HOPS]), call, meter);
  if ("done" in first || first.pending.name !== "fetch") {
    throw new Error("Expected captured benchmark to suspend on fetch");
  }
  return call(first.pending.resume, [rows]);
}

export function makeSuite(mode: Mode): Suite {
  const sizes = mode === "quick" ? [100, 1_000] : [1_000, 10_000, 50_000];
  const benches: BenchDef[] = [];

  for (const records of sizes) {
    const rows = makeRecords(records);

    for (const [name, module] of [
      ["flow-through", flowThrough],
      ["captured", captured],
    ] as const) {
      benches.push({
        name: `manual-${name}`,
        params: { records, hops: HOPS },
        ...withMetrics((limits) => () => manualTrampoline(module, rows as JSONType, limits)),
      });
    }

    const host = {
      registry,
      capabilities: {
        fetch: async (_index: JSONType) => rows,
        ping: async (_index: JSONType) => 1,
      },
    };
    for (const [name, module] of [
      ["flow-through", flowThroughEnvironment],
      ["captured", capturedEnvironment],
    ] as const) {
      benches.push({
        name: `run-task-${name}`,
        params: { records, hops: HOPS },
        ...withMetrics((limits) => () => runTask(module, environment, [HOPS], host, limits)),
      });
    }

    const suspended = suspendedCapturedTask(rows as JSONType);
    benches.push({
      name: "serialize-captured-suspension",
      params: { records },
      run: () => serializeTask(suspended),
    });
  }

  return { name: "effects", benches };
}
