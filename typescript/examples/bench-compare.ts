import { callFunction, createStdlib, type JSONType } from "../src";
import type { FunctionDeclaration } from "../src/types";

const functions: Record<string, any> = createStdlib();

function bench(label: string, fn: () => void, iterations: number): void {
  for (let i = 0; i < Math.min(3, iterations); i++) fn();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;
  const nsPerOp = (elapsed * 1e6) / iterations;
  console.log(
    `BENCH\t${label}\t${nsPerOp.toFixed(0)} ns/op\t(${elapsed.toFixed(1)}ms, ${iterations} iters)`,
  );
}

// ---------------------------------------------------------------------------
// 1. Deep arithmetic chain
// ---------------------------------------------------------------------------
function makeDeepAdd(depth: number): JSONType {
  let expr: JSONType = 0;
  for (let i = 0; i < depth; i++) expr = { $fn: ["add", expr, 1] };
  return { $return: expr };
}

console.log("--- DeepArithmetic ---");
for (const depth of [100, 500, 1000, 5000]) {
  const program = makeDeepAdd(depth);
  bench(
    `DeepArithmetic/depth=${depth}`,
    () => {
      callFunction(program as FunctionDeclaration, [], functions);
    },
    depth <= 1000 ? 200 : 50,
  );
}

// ---------------------------------------------------------------------------
// 2. Map over large arrays
// ---------------------------------------------------------------------------
console.log("--- MapOverArrays ---");
const mapProgram: JSONType = {
  $params: ["arr"],
  $return: {
    $fn: ["map", { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 1] } }, { $var: "arr" }],
  },
};

for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  bench(
    `MapOverArrays/size=${size}`,
    () => {
      callFunction(mapProgram as FunctionDeclaration, [arr], functions);
    },
    size <= 1000 ? 100 : 10,
  );
}

// ---------------------------------------------------------------------------
// 3. Nested map (closure stress)
// ---------------------------------------------------------------------------
console.log("--- NestedMap ---");
const nestedMapProgram: JSONType = {
  $params: ["grid"],
  $return: {
    $fn: [
      "map",
      {
        $params: ["row"],
        $return: {
          $fn: [
            "map",
            { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 1] } },
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
  bench(
    `NestedMap/${size}x${size}`,
    () => {
      callFunction(nestedMapProgram as FunctionDeclaration, [grid], functions);
    },
    size <= 50 ? 50 : 10,
  );
}

// ---------------------------------------------------------------------------
// 4. Reduce
// ---------------------------------------------------------------------------
console.log("--- Reduce ---");
const sumProgram: JSONType = {
  $params: ["arr"],
  $return: {
    $fn: [
      "reduce",
      { $params: ["acc", "item"], $return: { $fn: ["add", { $var: "acc" }, { $var: "item" }] } },
      0,
      { $var: "arr" },
    ],
  },
};

for (const size of [100, 1000, 5000, 10000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  bench(
    `Reduce/size=${size}`,
    () => {
      callFunction(sumProgram as FunctionDeclaration, [arr], functions);
    },
    size <= 1000 ? 100 : 10,
  );
}

// ---------------------------------------------------------------------------
// 5. Variable-heavy function bodies
// ---------------------------------------------------------------------------
console.log("--- ManyVars ---");
function makeManyVarsProgram(numVars: number): JSONType {
  const body: Record<string, JSONType> = { $params: ["v0"] };
  for (let i = 1; i < numVars; i++) body[`v${i}`] = { $fn: ["add", { $var: `v${i - 1}` }, 1] };
  body.$return = { $var: `v${numVars - 1}` };
  return body;
}

for (const numVars of [10, 50, 100, 500]) {
  const program = makeManyVarsProgram(numVars);
  bench(
    `ManyVars/vars=${numVars}`,
    () => {
      callFunction(program as FunctionDeclaration, [0], functions);
    },
    numVars <= 100 ? 200 : 50,
  );
}

// ---------------------------------------------------------------------------
// 6. Recursive fibonacci
// ---------------------------------------------------------------------------
console.log("--- Fibonacci ---");
functions.fib = {
  $params: ["n"],
  $return: {
    $if: { $fn: ["lte", { $var: "n" }, 1] },
    $then: { $var: "n" },
    $else: {
      $fn: [
        "add",
        { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 1] }] },
        { $fn: ["fib", { $fn: ["sub", { $var: "n" }, 2] }] },
      ],
    },
  },
};

for (const n of [10, 15, 20]) {
  bench(
    `Fibonacci/n=${n}`,
    () => {
      callFunction({ $return: { $fn: ["fib", n] } }, [], functions);
    },
    n <= 15 ? 20 : 3,
  );
}

// ---------------------------------------------------------------------------
// 7. Closure capture stress
// ---------------------------------------------------------------------------
console.log("--- ClosureCapture ---");
function makeClosureStress(capturedVars: number, arraySize: number): JSONType {
  const body: Record<string, JSONType> = {};
  for (let i = 0; i < capturedVars; i++) body[`c${i}`] = i;
  body.$return = {
    $fn: [
      "map",
      { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, { $var: "c0" }] } },
      { $fn: ["range", arraySize] },
    ],
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
  bench(`ClosureCapture/vars=${vars}_arr=${size}`, () => {
    callFunction(program as FunctionDeclaration, [], functions);
  }, 10);
}

// ---------------------------------------------------------------------------
// 8. Tic-tac-toe minimax
// ---------------------------------------------------------------------------
console.log("--- TicTacToe ---");
functions.otherPlayer = {
  $params: ["player"],
  $return: { $if: { $fn: ["eq", { $var: "player" }, "X"] }, $then: "O", $else: "X" },
};
functions.validMove = {
  $params: ["board", "pos"],
  $return: { $fn: ["eq", { $var: "board", $get: { $var: "pos" } }, null] },
};
functions.makeMove = {
  $params: ["board", "pos", "player"],
  $return: {
    $fn: [
      "map",
      {
        $params: ["cell", "idx"],
        $return: {
          $if: { $fn: ["eq", { $var: "idx" }, { $var: "pos" }] },
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
    $fn: [
      "every",
      {
        $params: ["pos"],
        $return: { $fn: ["eq", { $var: "board", $get: { $var: "pos" } }, { $var: "player" }] },
      },
      { $var: "line" },
    ],
  },
};
functions.checkWin = {
  $params: ["board", "player"],
  lines: {
    $raw: [
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
    $fn: [
      "some",
      {
        $params: ["line"],
        $return: { $fn: ["checkLine", { $var: "board" }, { $var: "player" }, { $var: "line" }] },
      },
      { $var: "lines" },
    ],
  },
};
functions.isBoardFull = {
  $params: ["board"],
  $return: {
    $fn: [
      "every",
      { $params: ["cell"], $return: { $fn: ["neq", { $var: "cell" }, null] } },
      { $var: "board" },
    ],
  },
};
functions.getStatus = {
  $params: ["board"],
  xWins: { $fn: ["checkWin", { $var: "board" }, "X"] },
  oWins: { $fn: ["checkWin", { $var: "board" }, "O"] },
  full: { $fn: ["isBoardFull", { $var: "board" }] },
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
  opponent: { $fn: ["otherPlayer", { $var: "aiPlayer" }] },
  status: { $fn: ["getStatus", { $var: "board" }] },
  gameOver: { $fn: ["neq", { $var: "status" }, "playing"] },
  aiWins: {
    $fn: ["and", { $var: "gameOver" }, { $fn: ["eq", { $var: "status" }, { $var: "aiPlayer" }] }],
  },
  opponentWins: {
    $fn: ["and", { $var: "gameOver" }, { $fn: ["eq", { $var: "status" }, { $var: "opponent" }] }],
  },
  currentPlayer: {
    $if: { $var: "isMaximizing" },
    $then: { $var: "aiPlayer" },
    $else: { $var: "opponent" },
  },
  emptyPos: {
    $fn: [
      "filter",
      { $params: ["pos"], $return: { $fn: ["validMove", { $var: "board" }, { $var: "pos" }] } },
      { $fn: ["range", 9] },
    ],
  },
  scores: {
    $fn: [
      "map",
      {
        $params: ["pos"],
        $return: {
          $fn: [
            "minimax",
            { $fn: ["makeMove", { $var: "board" }, { $var: "pos" }, { $var: "currentPlayer" }] },
            { $fn: ["add", { $var: "depth" }, 1] },
            { $fn: ["not", { $var: "isMaximizing" }] },
            { $var: "aiPlayer" },
          ],
        },
      },
      { $var: "emptyPos" },
    ],
  },
  maxScore: { $fn: ["max", { $var: "scores" }] },
  minScore: { $fn: ["min", { $var: "scores" }] },
  $return: {
    $cond: [
      [{ $var: "aiWins" }, { $fn: ["sub", 10, { $var: "depth" }] }],
      [{ $var: "opponentWins" }, { $fn: ["sub", { $var: "depth" }, 10] }],
      [{ $var: "gameOver" }, 0],
      [{ $var: "isMaximizing" }, { $var: "maxScore" }],
      [true, { $var: "minScore" }],
    ],
  },
};
functions.bestMove = {
  $params: ["board", "aiPlayer"],
  emptyPos: {
    $fn: [
      "filter",
      { $params: ["pos"], $return: { $fn: ["validMove", { $var: "board" }, { $var: "pos" }] } },
      { $fn: ["range", 9] },
    ],
  },
  best: {
    $fn: [
      "reduce",
      {
        $params: ["acc", "pos"],
        newBoard: { $fn: ["makeMove", { $var: "board" }, { $var: "pos" }, { $var: "aiPlayer" }] },
        score: { $fn: ["minimax", { $var: "newBoard" }, 1, false, { $var: "aiPlayer" }] },
        bestScore: { $var: "acc", $get: "score" },
        $return: {
          $if: { $fn: ["gt", { $var: "score" }, { $var: "bestScore" }] },
          $then: { score: { $var: "score" }, pos: { $var: "pos" } },
          $else: { $var: "acc" },
        },
      },
      { $raw: { score: -100, pos: -1 } },
      { $var: "emptyPos" },
    ],
  },
  $return: { $var: "best", $get: "pos" },
};

const board5: JSONType = ["O", null, "X", null, "X", null, "O", null, null];
bench("TicTacToe5Empty", () => {
  callFunction({ $return: { $fn: ["bestMove", board5, "O"] } }, [], functions);
}, 3);

const board7: JSONType = ["X", null, null, null, null, null, null, null, "O"];
bench("TicTacToe7Empty", () => {
  callFunction({ $return: { $fn: ["bestMove", board7, "O"] } }, [], functions);
}, 1);

// ---------------------------------------------------------------------------
// 9. Pipeline (map + pipe)
// ---------------------------------------------------------------------------
console.log("--- Pipeline ---");
functions.double = { $params: ["x"], $return: { $fn: ["mul", { $var: "x" }, 2] } };
functions.addTen = { $params: ["x"], $return: { $fn: ["add", { $var: "x" }, 10] } };
functions.square = { $params: ["x"], $return: { $fn: ["mul", { $var: "x" }, { $var: "x" }] } };

const pipeProgram: JSONType = {
  $params: ["arr"],
  $return: {
    $fn: [
      "map",
      {
        $params: ["x"],
        $return: { $fn: ["pipe", ["double", "addTen", "square"], { $var: "x" }] },
      },
      { $var: "arr" },
    ],
  },
};

for (const size of [100, 1000, 5000]) {
  const arr = Array.from({ length: size }, (_, i) => i);
  bench(
    `Pipeline/size=${size}`,
    () => {
      callFunction(pipeProgram as FunctionDeclaration, [arr], functions);
    },
    size <= 1000 ? 50 : 10,
  );
}

console.log("--- Done ---");
