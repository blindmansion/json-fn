// Loader for the canonical, language-agnostic builtin signature table
// (`spec/builtins.json`). The table is the shared source of truth for builtin
// types across implementations; the TypeScript checker's Section F reads it via
// `CheckContext.builtins`. See docs/builtin-signatures.md for the format.
//
// For now this reads the JSON off disk at runtime, mirroring how the spec-case
// harness loads `spec/cases`. Bundling / codegen is a later concern.

import { readFileSync } from "fs";
import { join } from "path";
import type { BuiltinTable } from "./check";

const DEFAULT_PATH = join(import.meta.dir, "../../spec/builtins.json");

export function loadBuiltinTable(path: string = DEFAULT_PATH): BuiltinTable {
  return JSON.parse(readFileSync(path, "utf-8")) as BuiltinTable;
}
