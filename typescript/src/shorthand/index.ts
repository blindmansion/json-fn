/**
 * `.jfn` shorthand: a bidirectional surface over canonical json-fn JSON.
 *
 * This module is a pure surface layer. `parse` lowers shorthand source text to
 * the same JSON value the interpreter consumes, so a host can feed the result
 * straight into `callFunction`. The interpreter itself never sees shorthand.
 *
 * Only the parse (lower) direction is implemented so far; printing (raising
 * canonical JSON back to shorthand) is tracked separately.
 */

export { parse } from "./parser";
export { ParseError } from "./error";
