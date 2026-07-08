// Core migration utility: rewrite the first-class comparator nodes
// ($eq/$neq/$lt/$lte/$gt/$gte) and the unary $not node into stdlib function
// calls, matching the parser's new lowering (exactly as `+`→`add`).
//
// Legacy forms removed from the language:
//   { "$eq":  [a, b] }  ->  { "$call": "eq",  "$args": [a, b] }
//   { "$neq": [a, b] }  ->  { "$call": "neq", "$args": [a, b] }
//   { "$lt":  [a, b] }  ->  { "$call": "lt",  "$args": [a, b] }
//   { "$lte": [a, b] }  ->  { "$call": "lte", "$args": [a, b] }
//   { "$gt":  [a, b] }  ->  { "$call": "gt",  "$args": [a, b] }
//   { "$gte": [a, b] }  ->  { "$call": "gte", "$args": [a, b] }
//   { "$not": x }       ->  { "$call": "not", "$args": [x] }
//
// These nodes only ever duplicated the eager stdlib eq/neq/lt/lte/gt/gte/not
// functions — there is no laziness to preserve (unlike short-circuit $and/$or),
// so the rewrite removes no behavior for well-formed nodes. It DOES remove the
// node-specific validation errors (wrong arity, sibling properties); the eval
// driver drops those now-obsolete error cases.
//
// $raw payloads are literal data, not expressions, so they are never rewritten.

import type { JSONType } from "../src/types";

/** Legacy comparator keys → their stdlib function name. */
const COMPARATORS: Record<string, string> = {
  $eq: "eq",
  $neq: "neq",
  $lt: "lt",
  $lte: "lte",
  $gt: "gt",
  $gte: "gte",
};

function isPlainObject(value: JSONType): value is { [key: string]: JSONType } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The comparator key of a legacy node: a single, array-valued $eq/$neq/…/$gte
 * key with no siblings other than $comment. Anything else (extra keys, a
 * non-array value) is malformed/unrelated and left to a generic recurse rather
 * than reinterpreted. Returns undefined when `value` is not such a node. */
function legacyComparatorKey(value: JSONType): string | undefined {
  if (!isPlainObject(value) || "$raw" in value) return undefined;
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  if (!(key in COMPARATORS)) return undefined;
  return Array.isArray(value[key]) ? key : undefined;
}

/** A legacy unary $not node: only $not (+ optional $comment). Its operand is a
 * single expression, not an array. */
function isLegacyNot(value: JSONType): boolean {
  if (!isPlainObject(value) || "$raw" in value || !("$not" in value)) return false;
  const others = Object.keys(value).filter((k) => k !== "$not" && k !== "$comment");
  return others.length === 0;
}

/** True if `value` itself is a legacy comparator or $not node (non-recursive).
 * Used by the examples validator to skip the nodes that are meant to change. */
export function isLegacyComparison(value: JSONType): boolean {
  return legacyComparatorKey(value) !== undefined || isLegacyNot(value);
}

/** True if `value` (or anything nested in it, outside $raw) is a legacy
 * comparator or $not node. Drives "would migrate" detection and the
 * post-transform "none remain" check. */
export function hasLegacyComparison(value: JSONType): boolean {
  if (Array.isArray(value)) return value.some(hasLegacyComparison);
  if (!isPlainObject(value)) return false;
  if ("$raw" in value) return false;
  if (isLegacyComparison(value)) return true;
  return Object.values(value).some(hasLegacyComparison);
}

/** Deep-rewrite every legacy comparator/$not node in `value` into $call/$args
 * form. Leaves everything else (including $raw payloads) untouched. */
export function toCallForm(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(toCallForm);
  if (!isPlainObject(value)) return value;

  // $raw wraps literal data — never an expression, so never rewritten.
  if ("$raw" in value) return value;

  const cmpKey = legacyComparatorKey(value);
  if (cmpKey !== undefined) {
    const args = (value[cmpKey] as JSONType[]).map(toCallForm);
    return withComment(value, { $call: COMPARATORS[cmpKey]!, $args: args });
  }

  if (isLegacyNot(value)) {
    return withComment(value, { $call: "not", $args: [toCallForm(value.$not!)] });
  }

  const out: { [key: string]: JSONType } = {};
  for (const [key, v] of Object.entries(value)) out[key] = toCallForm(v);
  return out;
}

/** Carry a $comment sibling verbatim onto the rewritten node. A string $comment
 * is a no-op keyword allowed alongside any expression form; preserving a
 * non-string one keeps its "extra property" error case intact across the shape
 * change. */
function withComment(
  from: { [key: string]: JSONType },
  node: { [key: string]: JSONType },
): JSONType {
  return "$comment" in from ? { $comment: from.$comment!, ...node } : node;
}
