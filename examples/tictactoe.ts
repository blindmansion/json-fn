// ---------------------------------------------------------------------------
// tictactoe.ts — Tic-tac-toe in json-fn-v2
//
// Implements full game logic + minimax AI entirely as JSON function
// definitions, stress-testing: closures, higher-order functions, recursion,
// property access, conditionals, and lazy variable evaluation.
// ---------------------------------------------------------------------------

import { callFunction, createStdlib, type JSONType } from "../src";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const functions: Record<string, any> = createStdlib();

function run(label: string, body: any, args: JSONType[] = []): JSONType {
  const result = callFunction(body, args, functions);
  console.log(`  ${label}  →  ${JSON.stringify(result)}`);
  return result;
}

// ===========================================================================
// Game logic — all defined as JSON functions
//
// Board: flat 9-element array, indexed 0–8 (row-major).
//   0 | 1 | 2
//   ---------
//   3 | 4 | 5
//   ---------
//   6 | 7 | 8
//
// Cells are "X", "O", or null (empty).
//
// Game state: { board: [...], turn: "X"|"O", status: "playing"|"X"|"O"|"draw" }
// ===========================================================================

// otherPlayer("X") → "O",  otherPlayer("O") → "X"
functions.otherPlayer = {
  $return: {
    $if: { $fn: "eq", $args: [{ $arg: 0 }, "X"] },
    $then: "O",
    $else: "X",
  },
};

// validMove(board, pos) — is the cell at pos empty?
functions.validMove = {
  board: { $arg: 0 },
  pos: { $arg: 1 },
  $return: {
    $fn: "eq",
    $args: [{ $get: { $var: "pos" }, $from: { $var: "board" } }, null],
  },
};

// makeMove(board, pos, player) — return a new board with player's mark at pos.
// Uses map: for each (cell, index), if index === pos return player, else cell.
// The map callback closes over `pos` and `player` via replaceVars.
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

// checkLine(board, player, line) — do all positions in `line` contain `player`?
// Uses every: for each position index in the line, board[pos] === player.
// The every callback closes over `board` and `player`.
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

// checkWin(board, player) — does player have three in a row?
// Uses some: is any of the 8 win lines fully owned by player?
// The some callback closes over `board` and `player`.
functions.checkWin = {
  board: { $arg: 0 },
  player: { $arg: 1 },
  lines: [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8], // rows
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8], // cols
    [0, 4, 8],
    [2, 4, 6], // diagonals
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

// isBoardFull(board) — are all 9 cells occupied?
functions.isBoardFull = {
  board: { $arg: 0 },
  $return: {
    $fn: "every",
    $args: [{ $return: { $fn: "neq", $args: [{ $arg: 0 }, null] } }, { $var: "board" }],
  },
};

// getStatus(board) → "X" | "O" | "draw" | "playing"
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

// playMove(state, pos) — apply a move and return the new game state.
// Validates that the game is still playing and the cell is empty.
// Thanks to lazy evaluation, newBoard/newStatus/nextTurn are only
// computed when the move is actually valid.
functions.playMove = {
  state: { $arg: 0 },
  pos: { $arg: 1 },
  board: { $get: "board", $from: { $var: "state" } },
  turn: { $get: "turn", $from: { $var: "state" } },
  currentStatus: { $get: "status", $from: { $var: "state" } },
  stillPlaying: { $fn: "eq", $args: [{ $var: "currentStatus" }, "playing"] },
  valid: { $fn: "validMove", $args: [{ $var: "board" }, { $var: "pos" }] },
  canMove: { $fn: "and", $args: [{ $var: "stillPlaying" }, { $var: "valid" }] },
  newBoard: {
    $fn: "makeMove",
    $args: [{ $var: "board" }, { $var: "pos" }, { $var: "turn" }],
  },
  newStatus: { $fn: "getStatus", $args: [{ $var: "newBoard" }] },
  nextTurn: { $fn: "otherPlayer", $args: [{ $var: "turn" }] },
  $return: {
    $if: { $var: "canMove" },
    $then: {
      board: { $var: "newBoard" },
      turn: { $var: "nextTurn" },
      status: { $var: "newStatus" },
    },
    $else: { $var: "state" },
  },
};

// ===========================================================================
// Minimax AI
//
// minimax(board, depth, isMaximizing, aiPlayer) → score
//
// All variables are lazily evaluated, so the recursive-case variables
// (emptyPos, scores, maxScore, minScore) are never computed when the
// game is already over — the conditional short-circuits past them.
//
// The map callback that recurses into minimax closes over board,
// currentPlayer, depth, isMaximizing, and aiPlayer. When the callback
// FunctionBody is evaluated as a value, replaceVars bakes the current
// values into the closure. Inner local variables (like $args references)
// are left untouched for the callback's own scope.
// ===========================================================================
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

  // Recursive case (lazy — only evaluated if game is not over)
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

// bestMove(board, aiPlayer) → position index (0–8)
// Reduces over empty positions, tracking { score, pos } of the best option.
// The reduce callback has its own local variables (newBoard, score) that
// are NOT in the outer scope, so replaceVars correctly leaves them alone.
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

// ===========================================================================
// Display helper (external, just for pretty-printing)
// ===========================================================================
function formatBoard(board: JSONType[]): string {
  const cell = (v: JSONType) => (v === null ? "·" : String(v));
  return [
    ` ${cell(board[0]!)} │ ${cell(board[1]!)} │ ${cell(board[2]!)}`,
    `───┼───┼───`,
    ` ${cell(board[3]!)} │ ${cell(board[4]!)} │ ${cell(board[5]!)}`,
    `───┼───┼───`,
    ` ${cell(board[6]!)} │ ${cell(board[7]!)} │ ${cell(board[8]!)}`,
  ].join("\n");
}

// ===========================================================================
//  DEMOS
// ===========================================================================

const EMPTY_BOARD: JSONType = [null, null, null, null, null, null, null, null, null];
const NEW_GAME: JSONType = { board: EMPTY_BOARD, turn: "X", status: "playing" };

// ── Demo 1: Basic game logic ──────────────────────────────────────────────
console.log("═══ 1. Basic game logic ═══\n");

console.log("otherPlayer:");
run('  otherPlayer("X")', { $return: { $fn: "otherPlayer", $args: ["X"] } });
run('  otherPlayer("O")', { $return: { $fn: "otherPlayer", $args: ["O"] } });

console.log("\nmakeMove (place X at position 4):");
const board1 = run("  makeMove(empty, 4, X)", {
  $return: { $fn: "makeMove", $args: [EMPTY_BOARD, 4, "X"] },
});
console.log(formatBoard(board1 as JSONType[]));

console.log("\nvalidMove:");
run("  validMove(board, 4) [occupied]", {
  $return: { $fn: "validMove", $args: [board1, 4] },
});
run("  validMove(board, 0) [empty]", {
  $return: { $fn: "validMove", $args: [board1, 0] },
});

// ── Demo 2: Win detection ─────────────────────────────────────────────────
console.log("\n═══ 2. Win detection ═══\n");

const xWinsBoard: JSONType = ["X", "X", "X", "O", "O", null, null, null, null];
const noWinBoard: JSONType = ["X", "O", "X", "O", null, null, null, null, null];
const drawBoard: JSONType = ["X", "O", "X", "X", "X", "O", "O", "X", "O"];

console.log("X wins (top row):");
console.log(formatBoard(xWinsBoard as JSONType[]));
run("  checkWin(board, X)", {
  $return: { $fn: "checkWin", $args: [xWinsBoard, "X"] },
});
run("  getStatus(board)", {
  $return: { $fn: "getStatus", $args: [xWinsBoard] },
});

console.log("\nNo winner yet:");
console.log(formatBoard(noWinBoard as JSONType[]));
run("  checkWin(board, X)", {
  $return: { $fn: "checkWin", $args: [noWinBoard, "X"] },
});
run("  checkWin(board, O)", {
  $return: { $fn: "checkWin", $args: [noWinBoard, "O"] },
});
run("  getStatus(board)", {
  $return: { $fn: "getStatus", $args: [noWinBoard] },
});

console.log("\nDraw:");
console.log(formatBoard(drawBoard as JSONType[]));
run("  getStatus(board)", {
  $return: { $fn: "getStatus", $args: [drawBoard] },
});

// ── Demo 3: Playing a full game via reduce ────────────────────────────────
console.log("\n═══ 3. Scripted game (X wins top row) ═══\n");

// X@0, O@3, X@1, O@4, X@2  →  X wins (top row 0-1-2)
const moves: JSONType = [0, 3, 1, 4, 2];

// Use reduce to fold playMove over the move list:
// reduce(playMove, initialState, moves)
const gameResult = run("  Play moves [0, 3, 1, 4, 2]", {
  $return: {
    $fn: "reduce",
    $args: [{ $fn: "playMove" }, NEW_GAME, moves],
  },
});

const finalBoard = (gameResult as any).board;
const finalStatus = (gameResult as any).status;
console.log(`\n  Final board:`);
console.log(formatBoard(finalBoard));
console.log(`  Status: ${finalStatus}\n`);

// ── Demo 4: Step-by-step game with board at each turn ─────────────────────
console.log("═══ 4. Step-by-step game ═══\n");

const stepMoves = [0, 3, 1, 4, 2];
let state: any = NEW_GAME;
for (const move of stepMoves) {
  const player = state.turn;
  state = callFunction(functions.playMove, [state, move], functions);
  console.log(`  ${player} plays position ${move}:`);
  console.log(formatBoard(state.board));
  if (state.status !== "playing") {
    console.log(`  → ${state.status === "draw" ? "Draw!" : state.status + " wins!"}\n`);
    break;
  }
  console.log();
}

// ── Demo 5: Minimax AI ───────────────────────────────────────────────────
console.log("═══ 5. Minimax AI ═══\n");

// Start with a board that has several moves already played (to keep
// the search space manageable given the interpreter's overhead).
//
//  O │ · │ X
// ───┼───┼───
//  · │ X │ ·
// ───┼───┼───
//  O │ · │ ·
//
// It's O's turn. Where should O play?
const aiBoard: JSONType = ["O", null, "X", null, "X", null, "O", null, null];
console.log("Board state (O to move):");
console.log(formatBoard(aiBoard as JSONType[]));

console.log("\nFinding best move for O...");
const t0 = performance.now();
const bestPos = run("  bestMove(board, O)", {
  $return: { $fn: "bestMove", $args: [aiBoard, "O"] },
});
const elapsed = (performance.now() - t0).toFixed(0);
console.log(`  (computed in ${elapsed}ms)`);

const afterAI = callFunction(functions.makeMove, [aiBoard, bestPos, "O"], functions);
console.log(`\n  O plays position ${bestPos}:`);
console.log(formatBoard(afterAI as JSONType[]));

// ── Demo 6: AI vs AI full game ───────────────────────────────────────────
console.log("\n═══ 6. AI vs AI (from mid-game) ═══\n");

// Start from a board with 3 moves played:
//  X │ · │ ·
// ───┼───┼───
//  · │ X │ ·
// ───┼───┼───
//  · │ · │ O
let aiState: any = {
  board: ["X", null, null, null, "X", null, null, null, "O"],
  turn: "O",
  status: "playing",
};
console.log("Starting position:");
console.log(formatBoard(aiState.board));
console.log();

const t1 = performance.now();
let moveCount = 0;
while (aiState.status === "playing") {
  const pos = callFunction(functions.bestMove, [aiState.board, aiState.turn], functions);
  const player = aiState.turn;
  aiState = callFunction(functions.playMove, [aiState, pos], functions);
  moveCount++;
  console.log(`  ${player} plays position ${pos}:`);
  console.log(formatBoard(aiState.board));
  if (aiState.status !== "playing") {
    console.log(`  → ${aiState.status === "draw" ? "Draw!" : aiState.status + " wins!"}`);
  }
  console.log();
}
const totalMs = (performance.now() - t1).toFixed(0);
console.log(`  AI vs AI finished in ${moveCount} moves, ${totalMs}ms total.`);

console.log("\n✓ All demos complete.");
