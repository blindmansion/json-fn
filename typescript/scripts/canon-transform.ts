// Core migration utility: rewrite legacy property-access spellings in canonical
// json-fn JSON into the single orthogonal `$get`/`$from` form.
//
// Legacy forms removed from the language:
//   1. dotted/bracket path strings on `$var`  ->  { "$var": "a.b[0]" }
//   2. the `$var` + `$get` combo              ->  { "$var": "a", "$get": <key> }
//
// Both are folded onto `$get`/`$from`, with `{ "$var": name }` as the base
// expression. Static path segments keep folding into an array path (the one
// concise-access affordance we're keeping); a single segment stays a scalar.
//
// `$raw` payloads are literal data, not expressions, so they are never rewritten.

import type { JSONType } from "../src/types";

/** Thrown when a legacy `$var` path string can't be parsed (e.g. `"obj[0"`,
 * `"obj."`, `"obj[]"`). Callers use this to drop now-obsolete error-cases. */
export class LegacyPathError extends Error {}

type ParsedPath = { name: string; path: (string | number)[] };

/** Parse a legacy `$var` path string into its base name + static segments.
 * Mirrors the (now-deleted) evaluator `parsePath`, throwing `LegacyPathError`
 * on the same malformed inputs. */
export function parseLegacyPath(str: string): ParsedPath {
  const dotIdx = str.indexOf(".");
  const bracketIdx = str.indexOf("[");

  if (dotIdx === -1 && bracketIdx === -1) {
    return { name: str, path: [] };
  }

  let splitIdx: number;
  if (dotIdx === -1) splitIdx = bracketIdx;
  else if (bracketIdx === -1) splitIdx = dotIdx;
  else splitIdx = Math.min(dotIdx, bracketIdx);

  const name = str.slice(0, splitIdx);
  if (name === "") {
    throw new LegacyPathError(`variable name cannot be empty in "${str}"`);
  }

  const path: (string | number)[] = [];
  let i = splitIdx;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ".") {
      i++;
      let end = i;
      while (end < str.length && str[end] !== "." && str[end] !== "[") end++;
      if (end === i) throw new LegacyPathError(`empty segment after "." in "${str}"`);
      path.push(str.slice(i, end));
      i = end;
    } else if (ch === "[") {
      i++;
      const closeIdx = str.indexOf("]", i);
      if (closeIdx === -1) throw new LegacyPathError(`unclosed "[" in "${str}"`);
      const inner = str.slice(i, closeIdx);
      if (inner === "") throw new LegacyPathError(`empty "[]" in "${str}"`);
      const num = Number(inner);
      path.push(Number.isInteger(num) && String(num) === inner ? num : inner);
      i = closeIdx + 1;
    } else {
      throw new LegacyPathError(`unexpected character "${ch}" in "${str}"`);
    }
  }
  return { name, path };
}

/** A single static segment stays a scalar `$get`; several fold into an array. */
function foldPath(path: (string | number)[]): JSONType {
  return path.length === 1 ? path[0]! : path;
}

function isPlainObject(value: JSONType): value is { [key: string]: JSONType } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True if `value` (or anything nested in it, outside `$raw`) is a legacy
 * `$var` access: a dotted/bracket path string or a `$var`+`$get` combo. Used by
 * migration scripts to spot error-cases that test now-removed behavior. */
export function hasLegacyVarAccess(value: JSONType): boolean {
  if (Array.isArray(value)) return value.some(hasLegacyVarAccess);
  if (!isPlainObject(value)) return false;
  if ("$raw" in value) return false;
  if (typeof value.$var === "string") {
    if ("$get" in value) return true;
    if (value.$var.includes(".") || value.$var.includes("[")) return true;
  }
  return Object.values(value).some(hasLegacyVarAccess);
}

/** Deep-rewrite every legacy property-access node in `value` to `$get`/`$from`
 * canon. Leaves everything else (including `$raw` payloads) untouched. */
export function toNewCanon(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(toNewCanon);
  if (!isPlainObject(value)) return value;

  // `$raw` wraps literal data — never an expression, so never rewritten.
  if ("$raw" in value) return value;

  // A legacy `$var` node has only `$var` (a string), optionally `$get`, and an
  // optional `$comment`. Anything else with a `$var` key is malformed/unrelated;
  // fall through to a generic recurse rather than reinterpret it.
  if (typeof value.$var === "string") {
    const others = Object.keys(value).filter(
      (k) => k !== "$var" && k !== "$get" && k !== "$comment",
    );
    if (others.length === 0) {
      const { name, path } = parseLegacyPath(value.$var);
      let node: JSONType = { $var: name };
      if (path.length > 0) node = { $get: foldPath(path), $from: node };
      if ("$get" in value) node = { $get: toNewCanon(value.$get), $from: node };
      // Carry a `$comment` sibling onto the rewritten node ($comment is a
      // no-op keyword stripped at eval, allowed alongside any expression form).
      if (typeof value.$comment === "string" && isPlainObject(node)) {
        node = { $comment: value.$comment, ...node };
      }
      return node;
    }
  }

  const out: { [key: string]: JSONType } = {};
  for (const [key, v] of Object.entries(value)) out[key] = toNewCanon(v);
  return out;
}
