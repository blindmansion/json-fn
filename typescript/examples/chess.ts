import { callFunction, createStdlib, type JSONType } from "../src";
import gameFunctions from "../../examples/chess.jsonc";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const functions: Record<string, any> = { ...createStdlib(), ...gameFunctions };

function call(name: string, ...args: JSONType[]): JSONType {
  return callFunction(functions[name], args, functions);
}

const PIECE_CHARS: Record<string, string> = {
  K: "\u2654",
  Q: "\u2655",
  R: "\u2656",
  B: "\u2657",
  N: "\u2658",
  P: "\u2659",
  k: "\u265A",
  q: "\u265B",
  r: "\u265C",
  b: "\u265D",
  n: "\u265E",
  p: "\u265F",
};

function formatBoard(board: JSONType[]): string {
  const lines: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    const cells: string[] = [];
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      cells.push(piece === null ? "·" : (PIECE_CHARS[piece as string] ?? String(piece)));
    }
    lines.push(` ${rank + 1}  ${cells.join("  ")}`);
  }
  lines.push("");
  lines.push("    a  b  c  d  e  f  g  h");
  return lines.join("\n");
}

function parseSquare(s: string): number | null {
  if (s.length !== 2) return null;
  const file = s.charCodeAt(0) - "a".charCodeAt(0);
  const rank = parseInt(s[1]!, 10) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7 || isNaN(rank)) return null;
  return rank * 8 + file;
}

function parseMove(input: string): { from: number; to: number } | null {
  const trimmed = input.trim().toLowerCase();
  let fromStr: string | undefined;
  let toStr: string | undefined;

  if (trimmed.length === 4) {
    fromStr = trimmed.slice(0, 2);
    toStr = trimmed.slice(2, 4);
  } else if (trimmed.length === 5 && trimmed[2] === " ") {
    fromStr = trimmed.slice(0, 2);
    toStr = trimmed.slice(3, 5);
  } else {
    return null;
  }

  const from = parseSquare(fromStr);
  const to = parseSquare(toStr);
  if (from === null || to === null) return null;
  return { from, to };
}

function squareName(idx: number): string {
  const file = String.fromCharCode("a".charCodeAt(0) + (idx % 8));
  const rank = Math.floor(idx / 8) + 1;
  return `${file}${rank}`;
}

const INITIAL_BOARD: JSONType = [
  "R",
  "N",
  "B",
  "Q",
  "K",
  "B",
  "N",
  "R",
  "P",
  "P",
  "P",
  "P",
  "P",
  "P",
  "P",
  "P",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  "p",
  "p",
  "p",
  "p",
  "p",
  "p",
  "p",
  "p",
  "r",
  "n",
  "b",
  "q",
  "k",
  "b",
  "n",
  "r",
];

const NEW_GAME: JSONType = { board: INITIAL_BOARD, turn: "w", status: "playing" };

const STATE_FILE = join(import.meta.dir, ".chess-state.json");

function loadState(): any {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return structuredClone(NEW_GAME);
}

function saveState(state: any): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

// ── Commands ────────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (!arg || arg === "show") {
  const state = loadState();
  const turnLabel = state.turn === "w" ? "White" : "Black";
  const inCheck = call("isInCheck", state.board, state.turn) as boolean;
  console.log();
  console.log(formatBoard(state.board));
  console.log();
  if (state.status === "checkmate") {
    const winner = state.turn === "w" ? "Black" : "White";
    console.log(`  Checkmate — ${winner} wins!`);
  } else if (state.status === "stalemate") {
    console.log("  Stalemate — draw!");
  } else {
    console.log(`  ${turnLabel} to move${inCheck ? "  [CHECK]" : ""}`);
  }
  console.log();
  process.exit(0);
}

if (arg === "reset") {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  console.log("  New game.");
  console.log();
  console.log(formatBoard((NEW_GAME as any).board));
  console.log();
  console.log("  White to move");
  console.log();
  process.exit(0);
}

if (arg === "help") {
  console.log(`
  Chess — json-fn edition

  Usage:  bun run typescript/examples/chess.ts <command>

  Commands:
    e2e4 / e2 e4    Make a move (algebraic notation)
    show             Display the current board (default)
    reset            Start a new game
    help             Show this message
`);
  process.exit(0);
}

// Treat arg (+ optional argv[3]) as a move
const moveInput = process.argv[3] ? `${arg} ${process.argv[3]}` : arg;
const move = parseMove(moveInput);
if (!move) {
  console.error(
    `  Invalid move format: "${moveInput}". Use algebraic notation like 'e2e4' or 'e2 e4'.`,
  );
  process.exit(1);
}

const state = loadState();

if (state.status !== "playing") {
  console.error(`  Game is over (${state.status}). Run 'reset' to start a new game.`);
  process.exit(1);
}

const turnLabel = state.turn === "w" ? "White" : "Black";
const t0 = performance.now();
const newState = call("playMove", state, move.from, move.to) as any;
const elapsed = (performance.now() - t0).toFixed(0);

if (newState.turn === state.turn) {
  console.error(`  Illegal move: ${squareName(move.from)} → ${squareName(move.to)}`);
  process.exit(1);
}

saveState(newState);

console.log(
  `  ${turnLabel} plays ${squareName(move.from)} → ${squareName(move.to)}  (${elapsed}ms)`,
);
console.log();
console.log(formatBoard(newState.board));
console.log();

if (newState.status === "checkmate") {
  console.log(`  Checkmate! ${turnLabel} wins!`);
} else if (newState.status === "stalemate") {
  console.log("  Stalemate — draw!");
} else {
  const nextLabel = newState.turn === "w" ? "White" : "Black";
  const inCheck = call("isInCheck", newState.board, newState.turn) as boolean;
  console.log(`  ${nextLabel} to move${inCheck ? "  [CHECK]" : ""}`);
}
console.log();
