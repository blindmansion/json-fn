import type { JSONType, BuiltinFunction, FunctionRegistry, Meter, RuntimeContext } from "./types";
import { BUILTIN_MARKER, PURE_MARKER, ARITY_MARKER } from "./types";

export function exprError(expr: JSONType, message: string): never {
  throw new Error(`Invalid JSON expression: ${JSON.stringify(expr, null, 2)}. ${message}`);
}

export function objectKeyCount(obj: Record<string, unknown>): number {
  let n = 0;
  for (const _ in obj) n++;
  return n;
}

export function isCommentKey(obj: Record<string, unknown>): boolean {
  return typeof (obj as { $comment?: unknown }).$comment === "string";
}

export function expressionKeyCount(obj: Record<string, unknown>): number {
  return objectKeyCount(obj) - (isCommentKey(obj) ? 1 : 0);
}

export function isPure(fn: unknown): boolean {
  return typeof fn === "function" && PURE_MARKER in fn;
}

export function pure(fn: Function): Function {
  (fn as any)[PURE_MARKER] = true;
  return fn;
}

export function builtin(
  fn: (
    args: JSONType[],
    call: (fn: JSONType, args: JSONType[]) => JSONType,
    functions: FunctionRegistry,
    meter: Meter,
    runtime: RuntimeContext,
  ) => JSONType,
  arity?: number,
): BuiltinFunction {
  (fn as any)[BUILTIN_MARKER] = true;
  if (arity !== undefined) (fn as any)[ARITY_MARKER] = arity;
  return fn as BuiltinFunction;
}

export function isBuiltin(fn: unknown): fn is BuiltinFunction {
  return typeof fn === "function" && BUILTIN_MARKER in fn;
}

export function raw(value: JSONType): JSONType {
  if (typeof value === "object" && value !== null) {
    _rawValues.add(value as object);
  }
  return value;
}

export function isRaw(value: unknown): boolean {
  return typeof value === "object" && value !== null && _rawValues.has(value as object);
}

const _rawValues = new WeakSet<object>();

export function getArity(fn: unknown, registry?: FunctionRegistry): number | null {
  if (typeof fn === "object" && fn !== null && !Array.isArray(fn) && "$return" in fn) {
    const params = (fn as any).$params as (string | { $fields: string[] })[] | undefined;
    if (!params || params.length === 0) return 0;
    const last = params[params.length - 1]!;
    const hasRest = typeof last === "string" && last.startsWith("...");
    return hasRest ? params.length - 1 : params.length;
  }

  if (typeof fn === "string" && registry) {
    const entry = registry[fn];
    if (entry === undefined) return null;
    return getArity(entry, registry);
  }

  if (typeof fn === "function" && ARITY_MARKER in fn) {
    return (fn as any)[ARITY_MARKER] as number;
  }

  if (typeof fn === "function") {
    return fn.length;
  }

  return null;
}
