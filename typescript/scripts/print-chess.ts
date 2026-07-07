// print-chess.ts — Round-trip demo: load examples/chess.jsonc (Bun strips the
// JSONC comments on import) and raise the whole registry to `.jfn` shorthand.

import { print } from "../src/shorthand";
import type { JSONType } from "../src/types";
import gameFunctions from "../../examples/chess.jsonc";

console.log(print(gameFunctions as JSONType));
