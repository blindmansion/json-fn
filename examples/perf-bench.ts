import {
  callFunction,
  createStdlib,
  enablePerf,
  disablePerf,
  type JSONType,
  type PerfStats,
} from "../src";
import type { FunctionDeclaration } from "../src/types";

const functions: Record<string, any> = createStdlib();

// ---------------------------------------------------------------------------
// Micro-benchmarks
// ---------------------------------------------------------------------------

function bench(label: string, fn: () => void, iterations = 1): { ms: number; opsPerSec: number } {
  // Warmup
  for (let i = 0; i < Math.min(3, iterations); i++) fn();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;
  const opsPerSec = iterations / (elapsed / 1000);
  console.log(
    `  ${label}: ${elapsed.toFixed(1)}ms total, ${iterations} iters, ${opsPerSec.toFixed(0)} ops/s`,
  );
  return { ms: elapsed, opsPerSec };
}

function printPerfStats(stats: PerfStats) {
  console.log("\n  ── Perf counters ──");
  console.log(`  evaluateExpression:   ${stats.evaluateExpression.toLocaleString()}`);
  console.log(`  getExpressionType:    ${stats.getExpressionType.toLocaleString()}`);
  console.log(`  callFunctionInternal: ${stats.callFunctionInternal.toLocaleString()}`);
  console.log(`  callJSONFunction:     ${stats.callJSONFunction.toLocaleString()}`);
  console.log(`  callExternalFunction: ${stats.callExternalFunction.toLocaleString()}`);
  console.log(`  replaceVars:          ${stats.replaceVars.toLocaleString()}`);
  console.log(`  cloneIfNeeded:        ${stats.cloneIfNeeded.toLocaleString()}`);
  console.log(`  structuredClones:     ${stats.structuredClones.toLocaleString()}`);
  console.log(`  rawSkips:             ${stats.rawSkips.toLocaleString()}`);
  console.log(`  maxCallDepth:         ${stats.maxCallDepth}`);

  const sortedTypes = Object.entries(stats.exprTypeCounts).sort((a, b) => b[1] - a[1]);
  console.log("\n  ── Expression type distribution ──");
  for (const [type, count] of sortedTypes) {
    const pct = ((count / stats.evaluateExpression) * 100).toFixed(1);
    console.log(`  ${type.padEnd(20)} ${count.toLocaleString().padStart(10)}  (${pct}%)`);
  }

  const sortedFns = Object.entries(stats.functionCallCounts).sort((a, b) => b[1] - a[1]);
  console.log("\n  ── Function call distribution ──");
  for (const [fn, count] of sortedFns) {
    console.log(`  ${fn.padEnd(20)} ${count.toLocaleString().padStart(10)}`);
  }
}

// ===========================================================================
// 1. Deep arithmetic chain: add(add(add(...)))
// ===========================================================================
console.log("═══ 1. Deep arithmetic chain ═══");

function makeDeepAdd(depth: number): JSONType {
  let expr: JSONType = 0;
  for (let i = 0; i < depth; i++) {
    expr = { $fn: "add", $args: [expr, 1] };
  }
  return { $return: expr };
}

for (const depth of [100, 500, 1000, 5000]) {
  const program = makeDeepAdd(depth);
  const stats = enablePerf();
  bench(`depth=${depth}`, () => callFunction(program as FunctionDeclaration, [], functions), 50);
  disablePerf();
  if (depth === 5000) printPerfStats(stats);
}

// ===========================================================================
// 2. Map over large arrays
// ===========================================================================
console.log("\n═══ 2. Map over large arrays ═══");

const mapProgram: JSONType = {
  $params: ["arr"],
  $return: {
    $fn: "map",
    $args: [
      { $params: ["x"], $return: { $fn: "add", $args: [{ $var: "x" }, 1] } },
      { $var: "arr" },
    ],
  },
};

for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  const stats = enablePerf();
  bench(
    `size=${size}`,
    () => callFunction(mapProgram as FunctionDeclaration, [arr], functions),
    10,
  );
  disablePerf();
  if (size === 10000) printPerfStats(stats);
}

// ===========================================================================
// 3. Nested map (map of map) — closure stress test
// ===========================================================================
console.log("\n═══ 3. Nested map (closure stress) ═══");

functions.inc = (x: number) => x + 1;

const nestedMapProgram: JSONType = {
  $params: ["grid"],
  $return: {
    $fn: "map",
    $args: [
      {
        $params: ["row"],
        $return: {
          $fn: "map",
          $args: [
            { $params: ["x"], $return: { $fn: "add", $args: [{ $var: "x" }, 1] } },
            { $var: "row" },
          ],
        },
      },
      { $var: "grid" },
    ],
  },
};

for (const size of [10, 50, 100]) {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, (_, i) => i));
  const stats = enablePerf();
  bench(
    `${size}x${size}`,
    () => callFunction(nestedMapProgram as FunctionDeclaration, [grid], functions),
    5,
  );
  disablePerf();
  if (size === 100) printPerfStats(stats);
}

// ===========================================================================
// 4. Reduce — accumulator cloning stress
// ===========================================================================
console.log("\n═══ 4. Reduce (accumulator cloning) ═══");

const sumProgram: JSONType = {
  $params: ["arr"],
  $return: {
    $fn: "reduce",
    $args: [
      {
        $params: ["acc", "item"],
        $return: { $fn: "add", $args: [{ $var: "acc" }, { $var: "item" }] },
      },
      0,
      { $var: "arr" },
    ],
  },
};

for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  const stats = enablePerf();
  bench(
    `size=${size}`,
    () => callFunction(sumProgram as FunctionDeclaration, [arr], functions),
    10,
  );
  disablePerf();
  if (size === 10000) printPerfStats(stats);
}

// ===========================================================================
// 5. Variable-heavy: lots of lazy vars in one function body
// ===========================================================================
console.log("\n═══ 5. Variable-heavy function bodies ═══");

function makeManyVarsProgram(numVars: number): JSONType {
  const body: Record<string, JSONType> = {};
  body["$params"] = ["v0"];
  for (let i = 1; i < numVars; i++) {
    body[`v${i}`] = { $fn: "add", $args: [{ $var: `v${i - 1}` }, 1] };
  }
  body.$return = { $var: `v${numVars - 1}` };
  return body;
}

for (const numVars of [10, 50, 100, 500]) {
  const program = makeManyVarsProgram(numVars);
  const stats = enablePerf();
  bench(`vars=${numVars}`, () => callFunction(program as FunctionDeclaration, [0], functions), 100);
  disablePerf();
  if (numVars === 500) printPerfStats(stats);
}

// ===========================================================================
// 6. Recursive fibonacci — deep recursion + repeated work
// ===========================================================================
console.log("\n═══ 6. Recursive fibonacci ═══");

functions.fib = {
  $params: ["n"],
  $return: {
    $if: { $fn: "lte", $args: [{ $var: "n" }, 1] },
    $then: { $var: "n" },
    $else: {
      $fn: "add",
      $args: [
        { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 1] }] },
        { $fn: "fib", $args: [{ $fn: "sub", $args: [{ $var: "n" }, 2] }] },
      ],
    },
  },
};

for (const n of [10, 15, 20, 22]) {
  const stats = enablePerf();
  const t0 = performance.now();
  const result = callFunction({ $return: { $fn: "fib", $args: [n] } }, [], functions);
  const elapsed = performance.now() - t0;
  disablePerf();
  console.log(`  fib(${n}) = ${result}  (${elapsed.toFixed(1)}ms)`);
  if (n === 20) printPerfStats(stats);
}

// ===========================================================================
// 7. replaceVars stress — closures with large captured environments
// ===========================================================================
console.log("\n═══ 7. replaceVars / closure capture ═══");

function makeClosureStress(capturedVars: number, arraySize: number): JSONType {
  const body: Record<string, JSONType> = {};
  for (let i = 0; i < capturedVars; i++) {
    body[`c${i}`] = i;
  }
  const innerBody: Record<string, JSONType> = {
    $params: ["x"],
    $return: { $fn: "add", $args: [{ $var: "x" }, { $var: "c0" }] },
  };
  body.$return = {
    $fn: "map",
    $args: [innerBody, { $fn: "range", $args: [arraySize] }],
  };
  return body;
}

for (const [vars, size] of [
  [5, 1000],
  [50, 1000],
  [200, 1000],
  [5, 10000],
  [50, 10000],
] as [number, number][]) {
  const program = makeClosureStress(vars, size);
  const stats = enablePerf();
  bench(
    `vars=${vars}, arr=${size}`,
    () => callFunction(program as FunctionDeclaration, [], functions),
    10,
  );
  disablePerf();
  if (vars === 50 && size === 10000) printPerfStats(stats);
}

// ===========================================================================
// 8. Tic-tac-toe minimax — the real-world benchmark
// ===========================================================================
console.log("\n═══ 8. Tic-tac-toe minimax ═══");

functions.otherPlayer = {
  $params: ["player"],
  $return: {
    $if: { $fn: "eq", $args: [{ $var: "player" }, "X"] },
    $then: "O",
    $else: "X",
  },
};

functions.validMove = {
  $params: ["board", "pos"],
  $return: {
    $fn: "eq",
    $args: [{ $var: "board", $get: { $var: "pos" } }, null],
  },
};

functions.makeMove = {
  $params: ["board", "pos", "player"],
  $return: {
    $fn: "map",
    $args: [
      {
        $params: ["cell", "idx"],
        $return: {
          $if: { $fn: "eq", $args: [{ $var: "idx" }, { $var: "pos" }] },
          $then: { $var: "player" },
          $else: { $var: "cell" },
        },
      },
      { $var: "board" },
    ],
  },
};

functions.checkLine = {
  $params: ["board", "player", "line"],
  $return: {
    $fn: "every",
    $args: [
      {
        $params: ["pos"],
        $return: {
          $fn: "eq",
          $args: [{ $var: "board", $get: { $var: "pos" } }, { $var: "player" }],
        },
      },
      { $var: "line" },
    ],
  },
};

functions.checkWin = {
  $params: ["board", "player"],
  lines: {
    $literal: [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ],
  },
  $return: {
    $fn: "some",
    $args: [
      {
        $params: ["line"],
        $return: {
          $fn: "checkLine",
          $args: [{ $var: "board" }, { $var: "player" }, { $var: "line" }],
        },
      },
      { $var: "lines" },
    ],
  },
};

functions.isBoardFull = {
  $params: ["board"],
  $return: {
    $fn: "every",
    $args: [
      { $params: ["cell"], $return: { $fn: "neq", $args: [{ $var: "cell" }, null] } },
      { $var: "board" },
    ],
  },
};

functions.getStatus = {
  $params: ["board"],
  xWins: { $fn: "checkWin", $args: [{ $var: "board" }, "X"] },
  oWins: { $fn: "checkWin", $args: [{ $var: "board" }, "O"] },
  full: { $fn: "isBoardFull", $args: [{ $var: "board" }] },
  $return: {
    $cond: [
      [{ $var: "xWins" }, "X"],
      [{ $var: "oWins" }, "O"],
      [{ $var: "full" }, "draw"],
      [true, "playing"],
    ],
  },
};

functions.minimax = {
  $params: ["board", "depth", "isMaximizing", "aiPlayer"],
  opponent: { $fn: "otherPlayer", $args: [{ $var: "aiPlayer" }] },
  status: { $fn: "getStatus", $args: [{ $var: "board" }] },
  gameOver: { $fn: "neq", $args: [{ $var: "status" }, "playing"] },
  aiWins: {
    $fn: "and",
    $args: [{ $var: "gameOver" }, { $fn: "eq", $args: [{ $var: "status" }, { $var: "aiPlayer" }] }],
  },
  opponentWins: {
    $fn: "and",
    $args: [{ $var: "gameOver" }, { $fn: "eq", $args: [{ $var: "status" }, { $var: "opponent" }] }],
  },
  currentPlayer: {
    $if: { $var: "isMaximizing" },
    $then: { $var: "aiPlayer" },
    $else: { $var: "opponent" },
  },
  emptyPos: {
    $fn: "filter",
    $args: [
      {
        $params: ["pos"],
        $return: {
          $fn: "validMove",
          $args: [{ $var: "board" }, { $var: "pos" }],
        },
      },
      { $fn: "range", $args: [9] },
    ],
  },
  scores: {
    $fn: "map",
    $args: [
      {
        $params: ["pos"],
        $return: {
          $fn: "minimax",
          $args: [
            {
              $fn: "makeMove",
              $args: [{ $var: "board" }, { $var: "pos" }, { $var: "currentPlayer" }],
            },
            { $fn: "add", $args: [{ $var: "depth" }, 1] },
            { $fn: "not", $args: [{ $var: "isMaximizing" }] },
            { $var: "aiPlayer" },
          ],
        },
      },
      { $var: "emptyPos" },
    ],
  },
  maxScore: { $fn: "max", $args: [{ $var: "scores" }] },
  minScore: { $fn: "min", $args: [{ $var: "scores" }] },
  $return: {
    $cond: [
      [{ $var: "aiWins" }, { $fn: "sub", $args: [10, { $var: "depth" }] }],
      [{ $var: "opponentWins" }, { $fn: "sub", $args: [{ $var: "depth" }, 10] }],
      [{ $var: "gameOver" }, 0],
      [{ $var: "isMaximizing" }, { $var: "maxScore" }],
      [true, { $var: "minScore" }],
    ],
  },
};

functions.bestMove = {
  $params: ["board", "aiPlayer"],
  emptyPos: {
    $fn: "filter",
    $args: [
      {
        $params: ["pos"],
        $return: {
          $fn: "validMove",
          $args: [{ $var: "board" }, { $var: "pos" }],
        },
      },
      { $fn: "range", $args: [9] },
    ],
  },
  best: {
    $fn: "reduce",
    $args: [
      {
        $params: ["acc", "pos"],
        newBoard: {
          $fn: "makeMove",
          $args: [{ $var: "board" }, { $var: "pos" }, { $var: "aiPlayer" }],
        },
        score: {
          $fn: "minimax",
          $args: [{ $var: "newBoard" }, 1, false, { $var: "aiPlayer" }],
        },
        bestScore: { $var: "acc", $get: "score" },
        $return: {
          $if: { $fn: "gt", $args: [{ $var: "score" }, { $var: "bestScore" }] },
          $then: { score: { $var: "score" }, pos: { $var: "pos" } },
          $else: { $var: "acc" },
        },
      },
      { $literal: { score: -100, pos: -1 } },
      { $var: "emptyPos" },
    ],
  },
  $return: { $var: "best", $get: "pos" },
};

// Board with 5 empty cells — expensive enough to profile
const aiBoard5: JSONType = ["O", null, "X", null, "X", null, "O", null, null];
console.log("  Board with 5 empty cells:");
{
  const stats = enablePerf();
  bench("bestMove (5 empty)", () => {
    callFunction({ $return: { $fn: "bestMove", $args: [aiBoard5, "O"] } }, [], functions);
  }, 3);
  disablePerf();
  printPerfStats(stats);
}

// Board with 7 empty cells — much larger search space
const aiBoard7: JSONType = ["X", null, null, null, null, null, null, null, "O"];
console.log("\n  Board with 7 empty cells:");
{
  const stats = enablePerf();
  bench("bestMove (7 empty)", () => {
    callFunction({ $return: { $fn: "bestMove", $args: [aiBoard7, "O"] } }, [], functions);
  }, 1);
  disablePerf();
  printPerfStats(stats);
}

// ===========================================================================
// 9. Object.keys cost in getExpressionType — isolated measurement
// ===========================================================================
console.log("\n═══ 9. getExpressionType overhead (isolated) ═══");

{
  const bigObject: JSONType = {};
  for (let i = 0; i < 100; i++) {
    (bigObject as any)[`key${i}`] = i;
  }
  const program: JSONType = {
    $params: ["arr"],
    $return: {
      $fn: "map",
      $args: [
        { $params: ["x"], $return: { $fn: "add", $args: [{ $var: "x" }, 1] } },
        { $var: "arr" },
      ],
    },
  };
  const smallArr = Array.from({ length: 100 }, () => bigObject);
  const stats = enablePerf();
  bench(
    "map over 100 large objects",
    () => callFunction(program as FunctionDeclaration, [smallArr], functions),
    100,
  );
  disablePerf();
  printPerfStats(stats);
}

// ===========================================================================
// Summary
// ===========================================================================
console.log("\n═══ Done ═══");
