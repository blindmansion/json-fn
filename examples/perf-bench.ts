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
  $return: {
    $fn: "map",
    $args: [{ $return: { $fn: "add", $args: [{ $arg: 0 }, 1] } }, { $arg: 0 }],
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
  $return: {
    $fn: "map",
    $args: [
      {
        $return: {
          $fn: "map",
          $args: [{ $return: { $fn: "add", $args: [{ $arg: 0 }, 1] } }, { $arg: 0 }],
        },
      },
      { $arg: 0 },
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
  $return: {
    $fn: "reduce",
    $args: [{ $return: { $fn: "add", $args: [{ $arg: 0 }, { $arg: 1 }] } }, 0, { $arg: 0 }],
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
  body["v0"] = { $arg: 0 };
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
  n: { $arg: 0 },
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
    $return: { $fn: "add", $args: [{ $arg: 0 }, { $var: "c0" }] },
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
  $return: {
    $if: { $fn: "eq", $args: [{ $arg: 0 }, "X"] },
    $then: "O",
    $else: "X",
  },
};

functions.validMove = {
  board: { $arg: 0 },
  pos: { $arg: 1 },
  $return: {
    $fn: "eq",
    $args: [{ $get: { $var: "pos" }, $from: { $var: "board" } }, null],
  },
};

functions.makeMove = {
  board: { $arg: 0 },
  pos: { $arg: 1 },
  player: { $arg: 2 },
  $return: {
    $fn: "map",
    $args: [
      {
        $return: {
          $if: { $fn: "eq", $args: [{ $arg: 1 }, { $var: "pos" }] },
          $then: { $var: "player" },
          $else: { $arg: 0 },
        },
      },
      { $var: "board" },
    ],
  },
};

functions.checkLine = {
  board: { $arg: 0 },
  player: { $arg: 1 },
  line: { $arg: 2 },
  $return: {
    $fn: "every",
    $args: [
      {
        $return: {
          $fn: "eq",
          $args: [{ $get: { $arg: 0 }, $from: { $var: "board" } }, { $var: "player" }],
        },
      },
      { $var: "line" },
    ],
  },
};

functions.checkWin = {
  board: { $arg: 0 },
  player: { $arg: 1 },
  lines: [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ],
  $return: {
    $fn: "some",
    $args: [
      {
        $return: {
          $fn: "checkLine",
          $args: [{ $var: "board" }, { $var: "player" }, { $arg: 0 }],
        },
      },
      { $var: "lines" },
    ],
  },
};

functions.isBoardFull = {
  board: { $arg: 0 },
  $return: {
    $fn: "every",
    $args: [{ $return: { $fn: "neq", $args: [{ $arg: 0 }, null] } }, { $var: "board" }],
  },
};

functions.getStatus = {
  board: { $arg: 0 },
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
  board: { $arg: 0 },
  depth: { $arg: 1 },
  isMaximizing: { $arg: 2 },
  aiPlayer: { $arg: 3 },
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
        $return: {
          $fn: "validMove",
          $args: [{ $var: "board" }, { $arg: 0 }],
        },
      },
      { $fn: "range", $args: [9] },
    ],
  },
  scores: {
    $fn: "map",
    $args: [
      {
        $return: {
          $fn: "minimax",
          $args: [
            {
              $fn: "makeMove",
              $args: [{ $var: "board" }, { $arg: 0 }, { $var: "currentPlayer" }],
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
  board: { $arg: 0 },
  aiPlayer: { $arg: 1 },
  emptyPos: {
    $fn: "filter",
    $args: [
      {
        $return: {
          $fn: "validMove",
          $args: [{ $var: "board" }, { $arg: 0 }],
        },
      },
      { $fn: "range", $args: [9] },
    ],
  },
  best: {
    $fn: "reduce",
    $args: [
      {
        newBoard: {
          $fn: "makeMove",
          $args: [{ $var: "board" }, { $arg: 1 }, { $var: "aiPlayer" }],
        },
        score: {
          $fn: "minimax",
          $args: [{ $var: "newBoard" }, 1, false, { $var: "aiPlayer" }],
        },
        bestScore: { $get: "score", $from: { $arg: 0 } },
        $return: {
          $if: { $fn: "gt", $args: [{ $var: "score" }, { $var: "bestScore" }] },
          $then: { score: { $var: "score" }, pos: { $arg: 1 } },
          $else: { $arg: 0 },
        },
      },
      { score: -100, pos: -1 },
      { $var: "emptyPos" },
    ],
  },
  $return: { $get: "pos", $from: { $var: "best" } },
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
    $return: {
      $fn: "map",
      $args: [{ $return: { $fn: "add", $args: [{ $arg: 0 }, 1] } }, { $arg: 0 }],
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
