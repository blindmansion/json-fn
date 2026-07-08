// life-effects.ts — the capability-driven twin of life.ts.
//
// life.ts is a *pure* shell: `handleCommand` returns a result record and the
// host imperatively does the I/O. Here the guest instead *performs effects* —
// reading argv and state, printing, saving, exiting — and this host answers
// them through a capability table via `runTask`. The pure Life logic in
// examples/life.jfn is reused verbatim; only a tiny effectful `main`/`orNew`
// pair is added on top. This is the sketch's "degenerate case" made literal: a
// straight-line request/response workflow expressed as a task.

import { runTask, createStdlib, parseShorthand, type JSONType } from "../src";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "../../examples/life.jfn"), "utf-8");
const lifeFunctions = parseShorthand(source) as Record<string, JSONType>;

// The effectful driver. Kept out of the shared, pure life.jfn and merged in
// here so the example .jfn stays a plain library. `main` sequences the same
// steps life.ts performs by hand, but as effects the host answers below.
const driver = parseShorthand(`{
  orNew: (s) => if isNull(s) then newWorld() else s,

  main: () => do {
    argv   <- perform("args", []),
    loaded <- perform("loadState", []),
    state:  orNew(loaded),
    result: handleCommand(state, argv),
    _ <- perform("print", [result.output]),
    _ <- perform("printErr", [result.stderr]),
    _ <- if result.reset then perform("clearState", []) else pure(null),
    _ <- if isNull(result.newState) then pure(null) else perform("saveState", [result.newState]),
    perform("exit", [result.exitCode])
  }
}`) as Record<string, JSONType>;

Object.assign(lifeFunctions, driver);

const STATE_FILE = join(import.meta.dir, ".life-state.json");

const capabilities = {
  args: () => process.argv.slice(2),
  loadState: (): JSONType =>
    existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf-8")) as JSONType) : null,
  print: (text: JSONType) => {
    if (text) console.log(text as string);
    return null;
  },
  printErr: (text: JSONType) => {
    if (text) console.error(text as string);
    return null;
  },
  saveState: (state: JSONType) => {
    writeFileSync(STATE_FILE, JSON.stringify(state));
    return null;
  },
  clearState: () => {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    return null;
  },
  exit: (code: JSONType): JSONType => {
    process.exit((code as number) ?? 0);
  },
};

await runTask(lifeFunctions, "main", [], createStdlib(), capabilities);
