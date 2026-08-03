import { describe, expect, test } from "bun:test";
import { callFunction, createPerfStats, createStdlib } from "../src";
import { getStaticCost, hasStaticCost, rememberStaticCost } from "../src/expression-metadata";
import { isRuntimeValue } from "../src/runtime-values";
import type { FunctionDeclaration, JSONType } from "../src";

const stdlib = createStdlib();

// One unit per JSON value node (object keys are not separately charged):
// array(1) + 2 * (object(1) + id(1) + nested array(1) + 3 elements(3)) = 13.
const PAYLOAD_COST = 13;

function makePayload(): JSONType[] {
  return [
    { id: 1, nested: [1, 2, 3] },
    { id: 2, nested: [4, 5, 6] },
  ];
}

function makeProgram(payload: JSONType[]): FunctionDeclaration {
  return { $return: payload };
}

type Run = { fuel: number; perf: ReturnType<typeof createPerfStats>; result: JSONType };

function run(program: FunctionDeclaration): Run {
  const perf = createPerfStats();
  const usage = { fuel: 0 };
  const result = callFunction(program, [], stdlib, { perf, usage });
  return { fuel: usage.fuel, perf, result };
}

describe("constant-expression metadata", () => {
  test("first evaluation discovers and records the complete static cost", () => {
    const payload = makePayload();
    expect(hasStaticCost(payload)).toBe(false);

    run(makeProgram(payload));

    expect(getStaticCost(payload)).toBe(PAYLOAD_COST);
  });

  test("warm evaluation skips traversal but charges identical fuel", () => {
    const payload = makePayload();
    const program = makeProgram(payload);

    const cold = run(program);
    const warm = run(program);

    // Deterministic outputs are identical...
    expect(warm.result).toBe(payload);
    expect(cold.result).toBe(payload);
    expect(warm.fuel).toBe(cold.fuel);

    // ...while host-side preparation work differs: the warm run returns the
    // cached constant from its recorded cost instead of re-walking it.
    expect(warm.perf.evaluateExpression).toBeLessThan(cold.perf.evaluateExpression);
    expect(warm.perf.rawSkips).toBeGreaterThan(cold.perf.rawSkips);
  });

  test("serializing/reparsing the program loses metadata but changes counters only", () => {
    const original = makeProgram(makePayload());
    const cold = run(original);
    run(original); // warm the metadata caches

    // A JSON round trip produces fresh object identities: all constant-cost
    // metadata (and runtime-value marks) are gone.
    const reparsed = JSON.parse(JSON.stringify(original)) as FunctionDeclaration;
    const replay = run(reparsed);

    // Same result and same deterministic fuel as the original cold run; the
    // performance counters show the rediscovery walk.
    expect(replay.result).toEqual(cold.result);
    expect(replay.fuel).toBe(cold.fuel);
    expect(replay.perf.evaluateExpression).toBe(cold.perf.evaluateExpression);
    expect(replay.perf.rawSkips).toBe(cold.perf.rawSkips);
  });

  test("parser-style preseeding skips discovery and charges the same fuel", () => {
    const discoveredPayload = makePayload();
    const discovered = run(makeProgram(discoveredPayload));

    const preseededPayload = makePayload();
    rememberStaticCost(preseededPayload, PAYLOAD_COST);
    // Preseeding is optimization metadata only: the node is still syntax,
    // not a runtime value.
    expect(isRuntimeValue(preseededPayload)).toBe(false);

    const preseeded = run(makeProgram(preseededPayload));

    // Identical result shape and deterministic fuel, with the discovery walk
    // skipped even on the first evaluation.
    expect(preseeded.result).toBe(preseededPayload);
    expect(preseeded.result).toEqual(discovered.result);
    expect(preseeded.fuel).toBe(discovered.fuel);
    expect(preseeded.perf.evaluateExpression).toBeLessThan(discovered.perf.evaluateExpression);
    expect(preseeded.perf.rawSkips).toBeGreaterThan(discovered.perf.rawSkips);

    // Later evaluations stay stable after the result also becomes a runtime
    // value (returned by identity from the call).
    const again = run(makeProgram(preseededPayload));
    expect(again.fuel).toBe(preseeded.fuel);
  });
});
