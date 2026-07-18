import type { JSONType } from "./types";

export function exprError(expr: JSONType, message: string): never {
  throw new Error(`Invalid JSON expression: ${JSON.stringify(expr, null, 2)}. ${message}`);
}
