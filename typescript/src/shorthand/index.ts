/**
 * `.jfn` shorthand: a bidirectional surface over canonical json-fn JSON.
 *
 * This module is a pure surface layer. A `.jfn` source is an implicit module;
 * standalone expressions use the explicit `parseExpression` entry point. Both
 * lower directly to the canonical JSON consumed by the interpreter.
 *
 * Each matching pair is bijective by normal form:
 * `parseModule(printModule(module))` and
 * `parseExpression(printExpression(expression))`.
 */

export { parse, parseExpression, parseModule } from "./parser";
export { print, printExpression, printModule } from "./printer";
export { ParseError } from "./error";
