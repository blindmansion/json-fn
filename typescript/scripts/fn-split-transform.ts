// Core migration utility: split the overloaded value-shape `$fn` form into two
// key-dispatched nodes.
//
// Legacy form removed from the language:
//   call       { "$fn": [callee, ...args] }  ->  { "$call": callee, "$args": [...args] }
//   reference  { "$fn": <non-array> }         ->  { "$fn": <non-array> }   (key kept)
//
// The array-valued `$fn` (callee in slot 0, args in slots 1..) was the only
// discriminant between a call and a reference. After the split, node kind is a
// pure key dispatch: `$call` marks a call, `$fn` a reference.
//
// `$raw` payloads are literal data, not expressions, so they are never rewritten.

import type { JSONType } from "../src/types";

function isPlainObject(value: JSONType): value is { [key: string]: JSONType } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A legacy call node: `$fn` array-valued, with only `$fn` (+ optional
 * `$comment`). Anything else with an array `$fn` is malformed/unrelated and is
 * left to a generic recurse rather than reinterpreted. */
export function isLegacyFnCall(value: JSONType): boolean {
  if (!isPlainObject(value) || "$raw" in value) return false;
  if (!Array.isArray(value.$fn)) return false;
  const others = Object.keys(value).filter((k) => k !== "$fn" && k !== "$comment");
  return others.length === 0;
}

/** True if `value` (or anything nested in it, outside `$raw`) is a legacy
 * array-valued `$fn` call node. Drives "would migrate" detection and the
 * post-transform "none remain" check. */
export function hasLegacyFnCall(value: JSONType): boolean {
  if (Array.isArray(value)) return value.some(hasLegacyFnCall);
  if (!isPlainObject(value)) return false;
  if ("$raw" in value) return false;
  if (Array.isArray(value.$fn)) return true;
  return Object.values(value).some(hasLegacyFnCall);
}

/** Deep-rewrite every legacy array-`$fn` call node in `value` into the split
 * `$call`/`$args` form. References (`$fn` non-array) keep their key; the callee
 * value is still recursed. Leaves everything else (including `$raw` payloads)
 * untouched. */
export function toSplitForm(value: JSONType): JSONType {
  if (Array.isArray(value)) return value.map(toSplitForm);
  if (!isPlainObject(value)) return value;

  // `$raw` wraps literal data — never an expression, so never rewritten.
  if ("$raw" in value) return value;

  if (isLegacyFnCall(value)) {
    const fnArr = value.$fn as JSONType[];
    const [callee, ...args] = fnArr;
    let node: JSONType = {
      $call: toSplitForm(callee as JSONType),
      $args: args.map(toSplitForm),
    };
    // Carry a `$comment` sibling verbatim onto the rewritten node. A string
    // `$comment` is a no-op keyword allowed alongside any expression form; a
    // non-string `$comment` is an extra property the evaluator rejects, and
    // preserving it keeps that error case intact across the shape change.
    if ("$comment" in value) {
      node = { $comment: value.$comment, ...(node as { [k: string]: JSONType }) };
    }
    return node;
  }

  const out: { [key: string]: JSONType } = {};
  for (const [key, v] of Object.entries(value)) out[key] = toSplitForm(v);
  return out;
}
