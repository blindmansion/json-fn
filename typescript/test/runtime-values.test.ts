/**
 * Characterization tests for runtime-value identity and fuel
 * (plans/raw-semantics-cleanup.md, Workstream A).
 *
 * These tests pin the observable behavior at each boundary where a JSON tree
 * crosses from expression syntax into value space: host arguments and results,
 * closure capture/substitution, canonical `$raw` payloads, task nodes and
 * generated continuations, and serialization/hydration. They also pin the
 * *exact fuel* charged under the stable virtual-cost model: `$raw` payloads
 * charge their full static-literal cost, runtime values re-enter at one
 * node, and cached constant literals keep charging their complete recorded
 * cost, independent of caches, marks, and ingestion route.
 */
import { describe, expect, test } from "bun:test";
import {
  callFunction,
  createStdlib,
  hydrateTask,
  hydrateWorkflowRecord,
  prepareProgram,
  pure,
  serializeTask,
  serializeWorkflowRecord,
  stepTask,
  type FunctionRegistry,
  type JSONType,
  type Suspended,
  type WorkflowRecord,
} from "../src";
import type { FunctionDeclaration } from "../src";
import { staticLiteralCost } from "../src/expression-metadata";
import { markRuntimeValue } from "../src/runtime-values";

const stdlib = createStdlib();

/** `(value) => () => value` — captures its argument into an escaping closure. */
const capture: FunctionDeclaration = {
  $params: ["value"],
  $return: { $params: [], $return: { $var: "value" } },
};

/** `(value) => value` — identity through one call boundary. */
const identity: FunctionDeclaration = {
  $params: ["value"],
  $return: { $var: "value" },
};

function measureFuel(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry = stdlib,
): number {
  const usage = { fuel: 0 };
  callFunction(fn, args, functions, { usage });
  return usage.fuel;
}

function bigRecords(n: number): JSONType {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    tags: [`a${i}`, `b${i}`],
    nested: { score: i * 2 },
  }));
}

function expectPending(stepped: Suspended): Extract<Suspended, { pending: unknown }>["pending"] {
  if ("done" in stepped) throw new Error(`Expected a pending task, got ${JSON.stringify(stepped)}`);
  return stepped.pending;
}

function expectDone(stepped: Suspended): JSONType {
  if ("pending" in stepped) {
    throw new Error(`Expected a completed task, got ${JSON.stringify(stepped.pending.name)}`);
  }
  return stepped.done;
}

describe("expression-shaped host arguments", () => {
  test("an argument shaped like an expression is returned as data, by identity", () => {
    const payload = { $var: "not a variable" };
    expect(callFunction(identity, [payload], stdlib)).toBe(payload);
  });

  test("stays data through closure capture and later invocation", () => {
    const payload = { $call: "not code", $args: [{ $var: "nested" }] };
    const closure = callFunction(capture, [payload], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(payload);
  });

  test("stays data when embedded in a dynamically built result", () => {
    const payload = { $var: "not a variable" };
    const wrap: FunctionDeclaration = {
      $params: ["value"],
      $return: { wrapped: { $var: "value" } },
    };
    const result = callFunction(wrap, [payload], stdlib) as Record<string, JSONType>;
    expect(result.wrapped).toBe(payload);
  });
});

describe("expression-shaped host function results", () => {
  test("an impure host function's expression-shaped result is returned as data", () => {
    const registry: FunctionRegistry = {
      ...stdlib,
      fetchPayload: () => ({ $call: "not code", $args: [] }),
    };
    const program: FunctionDeclaration = {
      $return: { $call: "fetchPayload", $args: [] },
    };
    expect(callFunction(program, [], registry)).toEqual({ $call: "not code", $args: [] });
  });

  test("a pure host function's expression-shaped result stays data through capture", () => {
    const payload = { $if: "not syntax", $then: 1, $else: 2 };
    const registry: FunctionRegistry = {
      ...stdlib,
      fetchPayload: pure(() => payload) as FunctionRegistry[string],
    };
    const program: FunctionDeclaration = {
      $return: {
        $call: { $params: ["v"], $return: { $params: [], $return: { $var: "v" } } },
        $args: [{ $call: "fetchPayload", $args: [] }],
      },
    };
    const closure = callFunction(program, [], registry) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(payload);
  });
});

describe("guest-constructed expression-shaped data", () => {
  test("data built with $-keys at runtime is returned as data", () => {
    const program: FunctionDeclaration = {
      $return: { $call: "fromEntries", $args: [[["$var", "x"]]] },
    };
    expect(callFunction(program, [], stdlib)).toEqual({ $var: "x" });
  });

  test("stays data through capture into an escaping closure", () => {
    const program: FunctionDeclaration = {
      $return: {
        $call: { $params: ["v"], $return: { $params: [], $return: { $var: "v" } } },
        $args: [{ $call: "fromEntries", $args: [[["$call", "boom"]]] }],
      },
    };
    const closure = callFunction(program, [], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toEqual({ $call: "boom" });
  });
});

describe("function-valued results", () => {
  test("a returned closure capturing a local is callable later", () => {
    const makeAdder: FunctionDeclaration = {
      $params: ["n"],
      $return: {
        $params: ["x"],
        $return: { $call: "add", $args: [{ $var: "x" }, { $var: "n" }] },
      },
    };
    const add3 = callFunction(makeAdder, [3], stdlib) as FunctionDeclaration;
    expect(callFunction(add3, [4], stdlib)).toBe(7);
  });

  test("a returned closure can be re-captured into another closure", () => {
    const makeAdder: FunctionDeclaration = {
      $params: ["n"],
      $return: {
        $params: ["x"],
        $return: { $call: "add", $args: [{ $var: "x" }, { $var: "n" }] },
      },
    };
    const add5 = callFunction(makeAdder, [5], stdlib) as FunctionDeclaration;
    const applyLater: FunctionDeclaration = {
      $params: ["f"],
      $return: { $params: ["x"], $return: { $call: { $var: "f" }, $args: [{ $var: "x" }] } },
    };
    const wrapped = callFunction(applyLater, [add5], stdlib) as FunctionDeclaration;
    expect(callFunction(wrapped, [2], stdlib)).toBe(7);
  });

  test("function-shaped host data is treated as syntax unless explicitly marked", () => {
    // Unmarked, well-formed: `{ $return: ... }` is treated as a source
    // function body, so closure construction walks and copies it. The data
    // survives but loses identity.
    const wellFormed = { $return: "data" };
    const closure = callFunction(capture, [wellFormed], stdlib) as FunctionDeclaration;
    const copied = callFunction(closure, [], stdlib);
    expect(copied).toEqual(wellFormed);
    expect(copied).not.toBe(wellFormed);

    // Unmarked with a non-syntax field: classification rejects it as a
    // malformed function body. This is the documented gap that canonical
    // `$raw` (or the runtime-value mark, for hosts) exists to close.
    const illFormed = { $return: "data", metadata: true };
    const illFormedClosure = callFunction(capture, [illFormed], stdlib) as FunctionDeclaration;
    expect(() => callFunction(illFormedClosure, [], stdlib)).toThrow(
      'Function body field "metadata" is not supported',
    );

    // Marked as an already-produced runtime value: identity is preserved.
    const marked = markRuntimeValue({ $return: "data", metadata: true });
    const markedClosure = callFunction(capture, [marked], stdlib) as FunctionDeclaration;
    expect(callFunction(markedClosure, [], stdlib)).toBe(marked);
  });
});

describe("explicitly raw canonical payloads", () => {
  test("evaluating $raw returns the payload as data, by identity", () => {
    const payload = { $var: "quoted", nested: [{ $call: "also quoted" }] };
    const program: FunctionDeclaration = { $return: { $raw: payload } };
    expect(callFunction(program, [], stdlib)).toBe(payload);
  });

  test("a raw payload stays data when re-entering expression position", () => {
    const payload = { $call: "quoted", $args: [] };
    const program: FunctionDeclaration = {
      $return: {
        $call: { $params: ["v"], $return: { $params: [], $return: { $var: "v" } } },
        $args: [{ $raw: payload }],
      },
    };
    const closure = callFunction(program, [], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(payload);
  });

  test("$raw preserves $comment entries that plain literals strip", () => {
    const viaRaw: FunctionDeclaration = {
      $return: { $raw: { $comment: "kept", value: 1 } },
    };
    expect(callFunction(viaRaw, [], stdlib)).toEqual({ $comment: "kept", value: 1 });

    const viaLiteral: FunctionDeclaration = {
      $return: { $comment: "stripped", value: 1 },
    };
    expect(callFunction(viaLiteral, [], stdlib)).toEqual({ value: 1 });
  });
});

describe("task nodes and generated continuations", () => {
  const performProgram: FunctionDeclaration = {
    $return: { $call: "perform", $args: ["fetch", [1, 2]] },
  };

  test("task constructors build tagged records that pass through guest code intact", () => {
    const task = callFunction(performProgram, [], stdlib);
    expect(task).toEqual({ "@task": "effect", name: "fetch", args: [1, 2] });
    const closure = callFunction(capture, [task], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(task);
  });

  test("a stepped effect suspends with a multi-shot resume continuation", () => {
    const module: Record<string, JSONType> = {
      main: {
        $return: {
          $call: "bind",
          $args: [
            { $call: "perform", $args: ["ask", []] },
            { $params: ["answer"], $return: { $call: "pure", $args: [{ $var: "answer" }] } },
          ],
        },
      },
    };
    const runtime = prepareProgram(module, stdlib);
    const pending = expectPending(
      stepTask(runtime.invokeEntry("main", []), runtime.call, runtime.meter),
    );
    expect(pending.name).toBe("ask");
    // Multi-shot: the continuation is inert JSON and can be resumed twice.
    expect(
      expectDone(stepTask(runtime.call(pending.resume, [10]), runtime.call, runtime.meter)),
    ).toBe(10);
    expect(
      expectDone(stepTask(runtime.call(pending.resume, [20]), runtime.call, runtime.meter)),
    ).toBe(20);
  });
});

describe("task and workflow serialization round trips", () => {
  const module: Record<string, JSONType> = {
    main: {
      $return: {
        $call: "bind",
        $args: [
          { $call: "perform", $args: ["ask", []] },
          {
            $params: ["answer"],
            $return: { $call: "pure", $args: [{ $call: "mul", $args: [{ $var: "answer" }, 2] }] },
          },
        ],
      },
    },
  };

  test("hydrated tasks step and resume in a fresh runtime", () => {
    const creator = prepareProgram(module, stdlib);
    const serialized = serializeTask(creator.invokeEntry("main", []));

    const runtime = prepareProgram(
      JSON.parse(JSON.stringify(module)) as Record<string, JSONType>,
      stdlib,
    );
    const pending = expectPending(stepTask(hydrateTask(serialized), runtime.call, runtime.meter));
    expect(pending.name).toBe("ask");
    expect(
      expectDone(stepTask(runtime.call(pending.resume, [21]), runtime.call, runtime.meter)),
    ).toBe(42);
  });

  test("hydrated workflow records expose a callable resume continuation", () => {
    const creator = prepareProgram(module, stdlib);
    const pending = expectPending(
      stepTask(creator.invokeEntry("main", []), creator.call, creator.meter),
    );
    const record: WorkflowRecord = {
      workflowId: "characterization",
      revision: 0,
      deploymentId: "test",
      effectSequence: 1,
      fuelUsed: 0,
      status: "suspended",
      pending: {
        effectId: "characterization:0",
        name: pending.name,
        args: pending.args,
        resume: pending.resume,
      },
    };
    const hydrated = hydrateWorkflowRecord(serializeWorkflowRecord(record));
    if (hydrated.status !== "suspended") throw new Error("Expected a suspended workflow");

    const runtime = prepareProgram(
      JSON.parse(JSON.stringify(module)) as Record<string, JSONType>,
      stdlib,
    );
    expect(
      expectDone(stepTask(runtime.call(hydrated.pending.resume, [5]), runtime.call, runtime.meter)),
    ).toBe(10);
  });

  test("a hydrated task node passes through guest code by identity", () => {
    const creator = prepareProgram(module, stdlib);
    const hydrated = hydrateTask(serializeTask(creator.invokeEntry("main", [])));
    const closure = callFunction(capture, [hydrated], stdlib) as FunctionDeclaration;
    expect(callFunction(closure, [], stdlib)).toBe(hydrated);
  });
});

describe("fuel: explicitly raw payloads", () => {
  // Stable virtual cost (Workstream E): a `$raw` boundary charges the
  // complete static-literal cost of its payload — the same deterministic
  // fuel as evaluating the equivalent plain constant literal — independent
  // of quotation, caches, and ingestion route. Quoting no longer reduces
  // fuel; it only skips the classification walk.
  test("charges the payload's full static-literal cost", () => {
    // 1 (call) + 2 ({a: 1}: object node + one entry value) = 3.
    const small: FunctionDeclaration = { $return: { $raw: { a: 1 } } };
    expect(measureFuel(small, [])).toBe(3);

    const payload = bigRecords(200);
    const large: FunctionDeclaration = { $return: { $raw: payload } };
    expect(measureFuel(large, [])).toBe(1 + staticLiteralCost(payload));
  });

  test("charges the same fuel as the equivalent plain constant literal", () => {
    const rawProgram: FunctionDeclaration = { $return: { $raw: bigRecords(50) } };
    const literalProgram: FunctionDeclaration = { $return: bigRecords(50) };
    expect(measureFuel(rawProgram, [])).toBe(measureFuel(literalProgram, []));
  });

  test("is stable across repeated evaluation", () => {
    const program: FunctionDeclaration = { $return: { $raw: bigRecords(50) } };
    expect(measureFuel(program, [])).toBe(measureFuel(program, []));
  });

  test("$comment payloads charge the node count of the value each form produces", () => {
    // `$raw` preserves the `$comment` entry (3 produced nodes); the plain
    // literal strips it (2 produced nodes). Each charges its own output.
    const viaRaw: FunctionDeclaration = { $return: { $raw: { $comment: "kept", value: 1 } } };
    const viaLiteral: FunctionDeclaration = { $return: { $comment: "stripped", value: 1 } };
    expect(measureFuel(viaRaw, [])).toBe(1 + 3);
    expect(measureFuel(viaLiteral, [])).toBe(1 + 2);
  });
});

describe("fuel: ingestion-route equivalence", () => {
  // The same program charges identical fuel whether it is evaluated
  // directly, after a JSON serialization round trip (losing all identity
  // metadata), or from an independently constructed deep-equal tree. Only
  // host preparation work may differ.
  const makeProgram = (): FunctionDeclaration => ({
    $return: {
      quoted: { $raw: { $var: "data, not a variable" } },
      constant: [1, 2, [3, 4]],
    },
  });

  test("direct, serialized, and independently constructed programs charge identical fuel", () => {
    const direct = makeProgram();
    const fuel = measureFuel(direct, []);
    expect(measureFuel(direct, [])).toBe(fuel); // warm identity caches
    const serialized = JSON.parse(JSON.stringify(direct)) as FunctionDeclaration;
    expect(measureFuel(serialized, [])).toBe(fuel);
    expect(measureFuel(makeProgram(), [])).toBe(fuel);
  });

  test("exact fuel limits accept and reject identically across routes", () => {
    const fuel = measureFuel(makeProgram(), []);
    const routes = () => [
      makeProgram(),
      JSON.parse(JSON.stringify(makeProgram())) as FunctionDeclaration,
    ];
    for (const program of routes()) {
      expect(callFunction(program, [], stdlib, { maxFuel: fuel })).toEqual({
        quoted: { $var: "data, not a variable" },
        constant: [1, 2, [3, 4]],
      });
    }
    for (const program of routes()) {
      expect(() => callFunction(program, [], stdlib, { maxFuel: fuel - 1 })).toThrow(
        "Maximum fuel",
      );
    }
  });
});

describe("fuel: runtime values re-entering expression position", () => {
  test("costs one node regardless of payload size", () => {
    // Invoking the closure evaluates its `$return`, which *is* the substituted
    // payload object: 1 (call) + 1 (runtime-value re-entry) = 2.
    for (const payload of [{ small: true }, bigRecords(200)]) {
      const closure = callFunction(capture, [payload], stdlib) as FunctionDeclaration;
      expect(measureFuel(closure, [])).toBe(2);
    }
  });
});

describe("fuel: constant literals (current semantics)", () => {
  test("charges one unit per expression node, and the same on re-evaluation", () => {
    // [1, 2, 3]: 1 (call) + 1 (array) + 3 (scalars) = 5, first and second time.
    const program: FunctionDeclaration = { $return: [1, 2, 3] };
    expect(measureFuel(program, [])).toBe(5);
    expect(measureFuel(program, [])).toBe(5);
  });

  test("a constant subtree returned as a call result still charges full cost on re-evaluation", () => {
    // The first call returns the AST subtree itself (constant identity) and
    // marks it as an already-produced result. Re-evaluating the same program
    // must charge the full recorded constant cost, not the one-node
    // runtime-value re-entry cost.
    const program: FunctionDeclaration = {
      $return: [{ id: 1, nested: [1, 2, 3] }, { id: 2 }],
    };
    // 1 (call) + 1 (outer array) + (1 obj + 1 scalar + 1 array + 3 scalars)
    //          + (1 obj + 1 scalar) = 10.
    const first = measureFuel(program, []);
    expect(first).toBe(10);
    expect(measureFuel(program, [])).toBe(first);
    expect(measureFuel(program, [])).toBe(first);
  });

  test("dynamic collections charge their evaluated children each time", () => {
    const program: FunctionDeclaration = {
      $params: ["x"],
      $return: [1, { $var: "x" }],
    };
    // 1 (call) + 1 (array) + 1 (scalar) + 1 ($var) = 4, every evaluation.
    expect(measureFuel(program, [9])).toBe(4);
    expect(measureFuel(program, [9])).toBe(4);
  });
});
