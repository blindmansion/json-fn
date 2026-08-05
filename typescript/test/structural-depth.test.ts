import { describe, expect, test } from "bun:test";
import { callFunction, createStdlib } from "../src";
import type { FunctionDeclaration, JSONType } from "../src";
import { checkExpr, checkModule } from "../src/check/module";
import { hydrateTask, serializeTask } from "../src/host/task-serialization";
import { hydrateWorkflowRecord } from "../src/host/durable/workflow-record";
import { validateDefinitionTable, validateSchemaFragment } from "../src/schema/validation";
import { printExpression } from "../src/shorthand/printer";
import {
  MAX_EVALUATION_NESTING,
  MAX_STRUCTURAL_DEPTH,
  assertStructuralDepth,
} from "../src/structural-depth";

const stdlib = createStdlib();

const DEPTH_ERROR = `Maximum structural depth of ${MAX_STRUCTURAL_DEPTH} exceeded`;
const NESTING_ERROR = `Maximum evaluation nesting of ${MAX_EVALUATION_NESTING} exceeded`;

/** `depth` nested single-element arrays around `leaf`. */
function deepArray(depth: number, leaf: JSONType = 1): JSONType {
  let v: JSONType = leaf;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

/** `depth` nested single-entry objects around `leaf`. */
function deepObject(depth: number, leaf: JSONType = 1): JSONType {
  let v: JSONType = leaf;
  for (let i = 0; i < depth; i++) v = { k: v };
  return v;
}

describe("portable limit constants", () => {
  test("are pinned to the documented values", () => {
    expect(MAX_STRUCTURAL_DEPTH).toBe(512);
    expect(MAX_EVALUATION_NESTING).toBe(4096);
  });
});

describe("assertStructuralDepth", () => {
  test("accepts scalars and empty containers", () => {
    for (const v of [null, true, 0, "s", [], {}]) {
      expect(() => assertStructuralDepth(v)).not.toThrow();
    }
  });

  test("accepts trees exactly at the limit", () => {
    expect(() => assertStructuralDepth(deepArray(MAX_STRUCTURAL_DEPTH))).not.toThrow();
    expect(() => assertStructuralDepth(deepObject(MAX_STRUCTURAL_DEPTH))).not.toThrow();
  });

  test("rejects trees one past the limit with the canonical error", () => {
    expect(() => assertStructuralDepth(deepArray(MAX_STRUCTURAL_DEPTH + 1))).toThrow(DEPTH_ERROR);
    expect(() => assertStructuralDepth(deepObject(MAX_STRUCTURAL_DEPTH + 1))).toThrow(DEPTH_ERROR);
  });

  test("depth follows the deepest path, not the first one", () => {
    const value = [1, [deepArray(MAX_STRUCTURAL_DEPTH)]];
    expect(() => assertStructuralDepth(value)).toThrow(DEPTH_ERROR);
  });

  test("rejects cyclic host objects with the depth error instead of hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertStructuralDepth(cyclic)).toThrow(DEPTH_ERROR);
  });

  test("composing verified subtrees still enforces the total depth", () => {
    const inner = deepArray(MAX_STRUCTURAL_DEPTH - 10);
    assertStructuralDepth(inner); // populate the cache
    expect(() => assertStructuralDepth(deepArray(10, inner))).not.toThrow();
    expect(() => assertStructuralDepth(deepArray(11, inner))).toThrow(DEPTH_ERROR);
  });
});

describe("evaluator boundaries", () => {
  const identity: FunctionDeclaration = { $params: ["x"], $return: { $var: "x" } };

  test("accepts an argument at the limit and returns it", () => {
    const arg = deepArray(MAX_STRUCTURAL_DEPTH);
    expect(callFunction(identity, [arg], stdlib)).toEqual(arg);
  });

  test("rejects an argument one past the limit", () => {
    expect(() => callFunction(identity, [deepArray(MAX_STRUCTURAL_DEPTH + 1)], stdlib)).toThrow(
      DEPTH_ERROR,
    );
  });

  test("rejects a function body one past the limit", () => {
    // The function object wraps its `$return` literal in one container level.
    const fn = { $params: [], $return: deepArray(MAX_STRUCTURAL_DEPTH) } as FunctionDeclaration;
    expect(() => callFunction(fn, [], stdlib)).toThrow(DEPTH_ERROR);
  });

  test("evaluates a literal at the limit", () => {
    const fn = { $params: [], $return: deepArray(MAX_STRUCTURAL_DEPTH - 1) } as FunctionDeclaration;
    expect(callFunction(fn, [], stdlib)).toEqual(deepArray(MAX_STRUCTURAL_DEPTH - 1));
  });

  test("a runtime-built value past the limit is caught at the exit boundary", () => {
    // reduce builds one level per element; each callback is a fresh guest
    // call, so construction never trips the nesting cap — only the exit
    // boundary can catch the over-deep result.
    const build: FunctionDeclaration = {
      $params: ["xs"],
      $return: {
        $call: "reduce",
        $args: [{ $params: ["acc", "x"], $return: [{ $var: "acc" }] }, 1, { $var: "xs" }],
      },
    };
    const zeros = (n: number): JSONType => Array.from({ length: n }, () => 0);
    expect(callFunction(build, [zeros(MAX_STRUCTURAL_DEPTH)], stdlib)).toEqual(
      deepArray(MAX_STRUCTURAL_DEPTH),
    );
    expect(() => callFunction(build, [zeros(MAX_STRUCTURAL_DEPTH + 1)], stdlib)).toThrow(
      DEPTH_ERROR,
    );
  });

  test("nesting compounded across call frames fails with the nesting error", () => {
    // Each guest call buries the recursive call site under 500 nested arrays
    // (every tree stays within the structural limit), so evaluation nesting
    // compounds across frames until the cap fires.
    let site: JSONType = {
      $if: { $call: "lte", $args: [{ $var: "n" }, 0] },
      $then: 0,
      $else: { $call: "go", $args: [{ $call: "sub", $args: [{ $var: "n" }, 1] }] },
    };
    for (let i = 0; i < 500; i++) site = [site];
    const body: FunctionDeclaration = {
      $params: ["n"],
      $return: { $call: "go", $args: [{ $var: "n" }] },
    };
    const functions = { ...stdlib, go: { $params: ["n"], $return: site } };
    expect(() => callFunction(body, [50], functions, { maxCallDepth: 200 })).toThrow(NESTING_ERROR);
  });
});

describe("checker", () => {
  test("rejects an over-deep expression before synthesis", () => {
    expect(() => checkExpr(deepArray(MAX_STRUCTURAL_DEPTH + 1))).toThrow(DEPTH_ERROR);
  });

  test("synthesizes a type for an expression at the limit", () => {
    expect(() => checkExpr(deepArray(MAX_STRUCTURAL_DEPTH))).not.toThrow();
  });

  test("rejects an over-deep module", () => {
    const module = { main: { $params: [], $return: deepArray(MAX_STRUCTURAL_DEPTH) } };
    expect(() => checkModule(module as Record<string, JSONType>)).toThrow(DEPTH_ERROR);
  });
});

describe("printer", () => {
  test("prints a tree at the limit", () => {
    expect(() => printExpression(deepArray(MAX_STRUCTURAL_DEPTH))).not.toThrow();
  });

  test("rejects a tree one past the limit", () => {
    expect(() => printExpression(deepArray(MAX_STRUCTURAL_DEPTH + 1))).toThrow(DEPTH_ERROR);
  });
});

describe("schema validation", () => {
  test("rejects over-deep schema fragments and definition tables", () => {
    expect(() => validateSchemaFragment(deepArray(MAX_STRUCTURAL_DEPTH + 1))).toThrow(DEPTH_ERROR);
    expect(() => validateDefinitionTable(deepObject(MAX_STRUCTURAL_DEPTH + 1))).toThrow(
      DEPTH_ERROR,
    );
  });
});

describe("serialization and hydration", () => {
  const deepJson =
    "[".repeat(MAX_STRUCTURAL_DEPTH + 1) + "1" + "]".repeat(MAX_STRUCTURAL_DEPTH + 1);

  test("serializeTask rejects over-deep task graphs before stringifying", () => {
    // A structurally valid `pure` task whose payload pushes the graph past
    // the limit (the task node itself adds one container level).
    const task = { "@task": "pure", value: deepArray(MAX_STRUCTURAL_DEPTH) };
    expect(() => serializeTask(task)).toThrow(DEPTH_ERROR);
  });

  test("hydrateTask rejects over-deep records before re-marking", () => {
    expect(() => hydrateTask(deepJson)).toThrow(DEPTH_ERROR);
  });

  test("hydrateWorkflowRecord rejects over-deep records before validation", () => {
    expect(() => hydrateWorkflowRecord(deepJson)).toThrow(DEPTH_ERROR);
  });
});

describe("closure capture growth", () => {
  // Capturing a value inside a returned closure embeds it one container level
  // deeper, so a capture at the limit pushes the closure past it.
  const capture: FunctionDeclaration = {
    $params: ["v"],
    $return: { $params: ["x"], $return: { $var: "v" } },
  };

  test("closures may capture values that stay within the limit", () => {
    const result = callFunction(capture, [deepArray(MAX_STRUCTURAL_DEPTH - 1)], stdlib);
    expect(typeof result).toBe("object");
  });

  test("a capture that pushes the closure past the limit fails deterministically", () => {
    expect(() => callFunction(capture, [deepArray(MAX_STRUCTURAL_DEPTH)], stdlib)).toThrow(
      DEPTH_ERROR,
    );
  });
});
