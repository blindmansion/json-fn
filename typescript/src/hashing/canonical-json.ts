/**
 * Canonical JSON bytes for accepted guest values (roadmap Phase 3; owning
 * plan: plans/content-addressing/content-addressed-values.md).
 *
 * One canonical byte encoding of an accepted JSON value, RFC 8785 (JCS)
 * style:
 *
 * - object keys sorted by UTF-16 code units;
 * - ECMAScript number-to-string formatting (`1.0` encodes as `1`, `-0` as
 *   `0`, JS exponent thresholds at `1e21`/`1e-7`);
 * - UTF-8 output with the standard JSON short escapes (`\"`, `\\`, `\b`,
 *   `\t`, `\n`, `\f`, `\r`) and lowercase `\u00xx` for other control
 *   characters; and
 * - no insignificant whitespace.
 *
 * The encoder owns the persistence/hash boundary validation: it rejects —
 * with structured, deterministic errors — cyclic values, non-finite numbers,
 * `undefined`, functions, symbols, bigints, non-plain host objects (`Date`,
 * `Map`, class instances, ...), symbol-keyed properties, named properties on
 * arrays, array holes, and strings containing unpaired surrogates. It never
 * relies on a host UTF-8 encoder's replacement behavior.
 *
 * This encoder operates on arbitrary JSON *values*. It must never apply the
 * program-AST normalization from `src/shorthand/normalize.ts`: guest data may
 * legitimately contain `$raw`-shaped or otherwise expression-shaped objects,
 * and value hashing preserves the exact structural value it receives.
 *
 * Depth policy: the walk enforces the portable structural-depth contract with
 * the shared counting rule and limit error from `src/structural-depth.ts`
 * (`docs/runtime/execution-limits.md`). Depth is checked before every descent, so the
 * bounded recursion can never reach the host stack limit; cycles are detected
 * by identity on the current path and fail before any depth unrolling.
 */

import { MAX_STRUCTURAL_DEPTH, structuralDepthError } from "../structural-depth";

export type CanonicalEncodingErrorCode = "UNSUPPORTED_VALUE" | "MALFORMED_STRING" | "CYCLIC_VALUE";

export class CanonicalEncodingError extends Error {
  constructor(
    readonly code: CanonicalEncodingErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CanonicalEncodingError";
  }
}

function fail(code: CanonicalEncodingErrorCode, path: string, message: string): never {
  throw new CanonicalEncodingError(code, path, message);
}

const encoder = new TextEncoder();

/** Canonical JCS-style text of an accepted JSON value. */
export function canonicalJsonText(value: unknown): string {
  const parts: string[] = [];
  writeValue(value, "$", 0, new Set(), parts);
  return parts.join("");
}

/** Canonical UTF-8 bytes of an accepted JSON value. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJsonText(value));
}

function writeValue(
  value: unknown,
  path: string,
  depth: number,
  onPath: Set<object>,
  parts: string[],
): void {
  if (value === null) {
    parts.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      parts.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        fail("UNSUPPORTED_VALUE", path, `non-finite number ${String(value)} is not encodable`);
      }
      // ECMAScript Number::toString(10); `String(-0)` is already "0".
      parts.push(String(value));
      return;
    case "string":
      writeString(value, path, parts);
      return;
    case "object":
      break;
    default:
      fail("UNSUPPORTED_VALUE", path, `${typeof value} values are not encodable`);
  }

  if (onPath.has(value)) {
    fail("CYCLIC_VALUE", path, "cyclic value cannot be canonically encoded");
  }
  if (depth + 1 > MAX_STRUCTURAL_DEPTH) throw structuralDepthError();
  onPath.add(value);
  if (Array.isArray(value)) {
    writeArray(value, path, depth + 1, onPath, parts);
  } else {
    writeObject(value as Record<string, unknown>, path, depth + 1, onPath, parts);
  }
  onPath.delete(value);
}

function writeString(value: string, path: string, parts: string[]): void {
  if (!value.isWellFormed()) {
    fail("MALFORMED_STRING", path, "string contains an unpaired surrogate");
  }
  // For well-formed strings, ECMAScript's QuoteJSONString is exactly the JCS
  // string serialization: short escapes for `"`, `\`, and the named control
  // characters, lowercase `\u00xx` for the rest, everything else literal.
  parts.push(JSON.stringify(value));
}

function writeArray(
  value: unknown[],
  path: string,
  depth: number,
  onPath: Set<object>,
  parts: string[],
): void {
  // Own enumerable keys beyond the indices (named properties) or missing
  // indices (holes) would be silently dropped by a plain JSON serializer;
  // reject them instead.
  if (Object.keys(value).length !== value.length) {
    fail("UNSUPPORTED_VALUE", path, "array has holes or named properties");
  }
  rejectSymbolKeys(value, path);
  parts.push("[");
  for (let index = 0; index < value.length; index++) {
    if (index > 0) parts.push(",");
    writeValue(value[index], `${path}[${index}]`, depth, onPath, parts);
  }
  parts.push("]");
}

function writeObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  onPath: Set<object>,
  parts: string[],
): void {
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    fail("UNSUPPORTED_VALUE", path, "non-plain object is not encodable");
  }
  rejectSymbolKeys(value, path);
  // JCS property ordering: sort keys by UTF-16 code units — the default
  // `Array.prototype.sort` string comparison.
  const keys = Object.keys(value).sort();
  parts.push("{");
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (index > 0) parts.push(",");
    writeString(key, `${path}.${key}`, parts);
    parts.push(":");
    // `key` comes from `Object.keys`, so the read hits the own property even
    // for special names like `__proto__`.
    writeValue(value[key], `${path}.${key}`, depth, onPath, parts);
  }
  parts.push("}");
}

function rejectSymbolKeys(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("UNSUPPORTED_VALUE", path, "symbol-keyed properties are not encodable");
  }
}
