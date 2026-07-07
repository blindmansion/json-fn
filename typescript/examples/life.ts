// life.ts — Thin host shell for the json-fn Conway's Life example.
//
// Unlike chess.ts (which imports canonical JSON directly), this loads the
// `.jfn` shorthand at examples/life.jfn, parses it to canonical json-fn JSON,
// and runs it. The host only does what JSON cannot: read argv, load/save the
// state file, and print to stdout/stderr.

import { callFunction, createStdlib, parseShorthand, type JSONType } from "../src";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

/** Inverse of print-chess.ts's rename: shorthand emits `$raw`, but the
 * interpreter consumes inert data as `$literal`. */
function rawToLiteral(node: JSONType): JSONType {
  if (Array.isArray(node)) return node.map(rawToLiteral);
  if (node !== null && typeof node === "object") {
    if ("$raw" in node) return { $literal: (node as Record<string, JSONType>).$raw! };
    const out: Record<string, JSONType> = {};
    for (const [k, v] of Object.entries(node)) out[k] = rawToLiteral(v);
    return out;
  }
  return node;
}

const source = readFileSync(join(import.meta.dir, "../../examples/life.jfn"), "utf-8");
const lifeFunctions = rawToLiteral(parseShorthand(source)) as Record<string, JSONType>;

const functions: Record<string, any> = { ...createStdlib(), ...lifeFunctions };
const STATE_FILE = join(import.meta.dir, ".life-state.json");

const state: JSONType = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf-8"))
  : (callFunction(functions.newWorld, [], functions) as JSONType);

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
