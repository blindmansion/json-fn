import type { FunctionBody, FunctionDeclaration } from "./types";

export function isFunctionBody(value: unknown): value is FunctionBody {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "$return" in value;
}

export function isFunctionDeclaration(value: unknown): value is FunctionDeclaration {
  return typeof value === "string" || isFunctionBody(value);
}
