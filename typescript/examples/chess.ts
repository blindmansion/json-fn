// chess.ts — Thin host shell for the json-fn chess engine.
//
// All chess rules, parsing, rendering, and user-facing messaging live in
// examples/chess.jsonc. This file does only what JSON cannot: read argv,
// load/save the state file, and print to stdout/stderr.

import { callFunction, createStdlib, type JSONType } from "../src";
import gameFunctions from "../../examples/chess.jsonc";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const functions: Record<string, any> = { ...createStdlib(), ...gameFunctions };
const STATE_FILE = join(import.meta.dir, ".chess-state.json");

const state: JSONType = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
  : (callFunction(functions.newGame, [], functions) as JSONType);

const result = callFunction(functions.handleCommand, [state, process.argv.slice(2)], functions) as {
  output: string;
  stderr: string;
  newState: JSONType;
  reset: boolean;
  exitCode: number;
};

if (result.reset && existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
if (result.newState !== null) writeFileSync(STATE_FILE, JSON.stringify(result.newState));

if (result.output) console.log(result.output);
if (result.stderr) console.error(result.stderr);

process.exit(result.exitCode);
