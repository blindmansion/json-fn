// life.ts — Thin host shell for the json-fn Conway's Life example.
//
// Unlike chess.ts (which imports canonical JSON directly), this loads the
// `.jfn` shorthand at examples/life.jfn, parses it to canonical json-fn JSON,
// and runs it. The host only does what JSON cannot: read argv, load/save the
// state file, and print to stdout/stderr.

import { callProgram, createStdlib, parseShorthand, type JSONType } from "../src";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "../../examples/life.jfn"), "utf-8");
const lifeFunctions = parseShorthand(source) as Record<string, JSONType>;

const stdlib = createStdlib();
const STATE_FILE = join(import.meta.dir, ".life-state.json");

const state: JSONType = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
  : (callProgram(lifeFunctions, "newWorld", [], stdlib) as JSONType);

const result = callProgram(
  lifeFunctions,
  "handleCommand",
  [state, process.argv.slice(2)],
  stdlib,
) as {
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
