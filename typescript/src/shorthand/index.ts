/**
 * `.jfn` shorthand: a bidirectional surface over canonical json-fn JSON.
 *
 * This module is a pure surface layer. `parse` lowers shorthand source text to
 * the same JSON value the interpreter consumes, so a host can feed the result
 * straight into `callFunction`. The interpreter itself never sees shorthand.
 * `print` is the inverse: it raises canonical JSON back to shorthand source.
 *
 * The two directions are bijective by normal form: `parse(print(json))`
 * deep-equals any canonical `json`, though `print` normalizes rather than
 * byte-exactly recovering arbitrary hand-written source.
 */

export { parse } from "./parser";
export { print } from "./printer";
export { ParseError } from "./error";
