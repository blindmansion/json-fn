import { describe, expect, test } from "bun:test";
import { callFunction, createPerfStats, createStdlib } from "../src";
import { getStaticCost, hasStaticCost, rememberStaticCost } from "../src/expression-metadata";
import { isRuntimeValue } from "../src/runtime-values";
import { parseExpression } from "../src/shorthand";
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
    expect(warm.perf.discoveredStaticSkips).toBeGreaterThan(cold.perf.discoveredStaticSkips);
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
    expect(replay.perf.discoveredStaticSkips).toBe(cold.perf.discoveredStaticSkips);
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
    // The skip is attributed to the preseeded route; a discovery run first
    // pays the full walk and records no preseeded skips at all.
    expect(preseeded.perf.preseededStaticSkips).toBeGreaterThan(0);
    expect(discovered.perf.preseededStaticSkips).toBe(0);

    // Later evaluations stay stable after the result also becomes a runtime
    // value (returned by identity from the call).
    const again = run(makeProgram(preseededPayload));
    expect(again.fuel).toBe(preseeded.fuel);
  });
});

describe("shorthand raw inference preseeding", () => {
  test("the parser preseeds proven static composite literals", () => {
    const parsed = parseExpression(
      "[{ id: 1, nested: [1, 2, 3] }, { id: 2, nested: [4, 5, 6] }]",
    ) as JSONType[];
    expect(getStaticCost(parsed)).toBe(PAYLOAD_COST);

    const discovered = run(makeProgram(makePayload()));
    const preseeded = run(makeProgram(parsed));
    expect(preseeded.result).toEqual(discovered.result);
    expect(preseeded.fuel).toBe(discovered.fuel);
    // The very first evaluation of the parsed program already skips discovery.
    expect(preseeded.perf.preseededStaticSkips).toBeGreaterThan(0);
  });

  test("static children of a dynamic literal are preseeded individually", () => {
    const parsed = parseExpression('{ dynamic: f(), fixed: { retries: 3, tags: ["a"] } }') as {
      [key: string]: JSONType;
    };
    expect(hasStaticCost(parsed)).toBe(false);
    // fixed(1) + retries(1) + tags array(1) + "a"(1) = 4
    expect(getStaticCost(parsed.fixed as object)).toBe(4);
  });

  test("composites absorbed into an inferred $raw payload are not preseeded", () => {
    const wrapper = parseExpression(
      '{ envelope: { limits: [1, 2], payload: { "$call": "not code", "$args": [] } } }',
    ) as { $raw: { [key: string]: JSONType } };
    expect(Object.keys(wrapper)).toEqual(["$raw"]);

    // A payload is quoted data, not constant expression syntax: on a cold
    // canonical route its interior is never charged as a constant, so
    // preseeding it would change re-entry fuel between ingestion routes.
    const envelope = wrapper.$raw.envelope as { [key: string]: JSONType };
    expect(hasStaticCost(wrapper.$raw)).toBe(false);
    expect(hasStaticCost(envelope)).toBe(false);
    expect(hasStaticCost(envelope.limits as object)).toBe(false);
    const payload = envelope.payload as { [key: string]: JSONType };
    expect(hasStaticCost(payload)).toBe(false);
    expect(hasStaticCost(payload.$args as object)).toBe(false);
  });

  test("inferred $raw charges identical fuel across ingestion routes", () => {
    const direct = parseExpression('{ "$fn": ["not", "x"] }');
    const program: FunctionDeclaration = { $return: direct };
    const directRun = run(program);

    // A JSON round trip loses wrapper provenance and payload-cost caches but
    // must not change results or deterministic fuel.
    const reparsed = JSON.parse(JSON.stringify(program)) as FunctionDeclaration;
    const replay = run(reparsed);
    expect(replay.result).toEqual(directRun.result);
    expect(replay.fuel).toBe(directRun.fuel);

    // And quotation itself is fuel-neutral: the equivalent plain constant
    // literal (same value shape without the reserved key collision) costs the
    // same as the quoted spelling, one unit per value node.
    const plain = run({ $return: parseExpression('{ fn: ["not", "x"] }') });
    expect(plain.fuel).toBe(directRun.fuel);
  });
});
