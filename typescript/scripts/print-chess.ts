// print-chess.ts — Round-trip demo: load examples/chess.jsonc (Bun strips the
// JSONC comments on import), rename `$literal` -> `$raw` (the rename the
// shorthand spec assumes), and raise the whole registry to `.jfn` shorthand.

import { print } from "../src/shorthand";
import type { JSONType } from "../src/types";
import gameFunctions from "../../examples/chess.jsonc";

/** Rename `$literal` to `$raw` without descending into the inert payload. */
function literalToRaw(node: JSONType): JSONType {
  if (Array.isArray(node)) return node.map(literalToRaw);
  if (node !== null && typeof node === "object") {
    if ("$literal" in node) return { $raw: (node as Record<string, JSONType>).$literal! };
    const out: Record<string, JSONType> = {};
    for (const [k, v] of Object.entries(node)) out[k] = literalToRaw(v);
    return out;
  }
  return node;
}

console.log(print(literalToRaw(gameFunctions as JSONType)));
