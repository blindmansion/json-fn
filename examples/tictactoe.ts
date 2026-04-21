// ---------------------------------------------------------------------------
// tictactoe.ts — Tic-tac-toe in json-fn-v2
//
// Implements full game logic + minimax AI entirely as JSON function
// definitions, stress-testing: closures, higher-order functions, recursion,
// property access, conditionals, and lazy variable evaluation.
// ---------------------------------------------------------------------------

import { callFunction, createStdlib, enablePerf, disablePerf, type JSONType } from "../src";
import gameFunctions from "./tictactoe.jsonc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const functions: Record<string, any> = { ...createStdlib(), ...gameFunctions };

function call(name: string, ...args: JSONType[]): JSONType {
  return callFunction(functions[name], args, functions);
}

function log(label: string, result: JSONType): JSONType {
  console.log(`  ${label}  →  ${JSON.stringify(result)}`);
  return result;
}

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
log('  otherPlayer("X")', call("otherPlayer", "X"));
log('  otherPlayer("O")', call("otherPlayer", "O"));

console.log("\nmakeMove (place X at position 4):");
const board1 = log("  makeMove(empty, 4, X)", call("makeMove", EMPTY_BOARD, 4, "X"));
console.log(formatBoard(board1 as JSONType[]));

console.log("\nvalidMove:");
log("  validMove(board, 4) [occupied]", call("validMove", board1, 4));
log("  validMove(board, 0) [empty]", call("validMove", board1, 0));

// ── Demo 2: Win detection ─────────────────────────────────────────────────
console.log("\n═══ 2. Win detection ═══\n");

const xWinsBoard: JSONType = ["X", "X", "X", "O", "O", null, null, null, null];
const noWinBoard: JSONType = ["X", "O", "X", "O", null, null, null, null, null];
const drawBoard: JSONType = ["X", "O", "X", "X", "X", "O", "O", "X", "O"];

console.log("X wins (top row):");
console.log(formatBoard(xWinsBoard as JSONType[]));
log("  checkWin(board, X)", call("checkWin", xWinsBoard, "X"));
log("  getStatus(board)", call("getStatus", xWinsBoard));

console.log("\nNo winner yet:");
console.log(formatBoard(noWinBoard as JSONType[]));
log("  checkWin(board, X)", call("checkWin", noWinBoard, "X"));
log("  checkWin(board, O)", call("checkWin", noWinBoard, "O"));
log("  getStatus(board)", call("getStatus", noWinBoard));

console.log("\nDraw:");
console.log(formatBoard(drawBoard as JSONType[]));
log("  getStatus(board)", call("getStatus", drawBoard));

// ── Demo 3: Playing a full game via reduce ────────────────────────────────
console.log("\n═══ 3. Scripted game (X wins top row) ═══\n");

// X@0, O@3, X@1, O@4, X@2  →  X wins (top row 0-1-2)
const moves = [0, 3, 1, 4, 2];

const gameResult = moves.reduce<JSONType>((st, pos) => call("playMove", st, pos), NEW_GAME);
log("  Play moves [0, 3, 1, 4, 2]", gameResult);

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
  state = call("playMove", state, move);
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
const perfStats = enablePerf();
const t0 = performance.now();
const bestPos = log("  bestMove(board, O)", call("bestMove", aiBoard, "O"));
const elapsed = (performance.now() - t0).toFixed(0);
disablePerf();
console.log(`  (computed in ${elapsed}ms)`);
console.log(`  evaluateExpression: ${perfStats.evaluateExpression.toLocaleString()}`);
console.log(`  rawSkips:           ${perfStats.rawSkips.toLocaleString()}`);

const afterAI = call("makeMove", aiBoard, bestPos, "O");
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
  board: ["X", null, null, null, "X", null, null, null, "O"] as JSONType,
  turn: "O",
  status: "playing",
};
console.log("Starting position:");
console.log(formatBoard(aiState.board));
console.log();

const t1 = performance.now();
let moveCount = 0;
while (aiState.status === "playing") {
  const pos = call("bestMove", aiState.board, aiState.turn);
  const player = aiState.turn;
  aiState = call("playMove", aiState, pos);
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
