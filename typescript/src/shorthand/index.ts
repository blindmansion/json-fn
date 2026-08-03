/**
 * `.jfn` shorthand: a bidirectional surface over canonical json-fn JSON.
 *
 * This module is a pure surface layer. A `.jfn` source is an implicit module;
 * standalone expressions use the explicit `parseExpression` entry point. Both
 * lower directly to the canonical JSON consumed by the interpreter.
 *
 * Each matching pair is bijective by normal form:
 * `parseModule(printModule(module)) = normalizeModule(module)` and
 * `parseExpression(printExpression(expression)) = normalizeExpression(expression)`.
 * Redundant `$raw` wrappers normalize away; see `./normalize`.
 */

export {
  parse,
  parseExpression,
  parseExpressionWithPositions,
  parseModule,
  parseModuleWithPositions,
} from "./parser";
export type { ParsedWithPositions, SourcePos } from "./parser";
export { resolvePathPosition } from "./positions";
export { print, printExpression, printModule } from "./printer";
export { normalizeExpression, normalizeModule } from "./normalize";
export { ParseError } from "./error";
