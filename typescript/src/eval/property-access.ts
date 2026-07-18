import type { JSONType } from "../types";

/**
 * A short, human-readable description of a `$get` target, used only to make
 * property-access errors actionable (which shape, what keys were available).
 * Object key lists are truncated so the message stays readable on wide records.
 */
function describeTarget(value: JSONType): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "an empty object";
    const shown = keys.slice(0, 8).map((key) => JSON.stringify(key));
    const suffix = keys.length > shown.length ? `, … (${keys.length} keys)` : "";
    return `an object with keys ${shown.join(", ")}${suffix}`;
  }
  if (typeof value === "string") return `a string of length ${value.length}`;
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/**
 * The likely-cause hint for a key that is neither a string nor a number. A
 * `null` key is almost always a lookup expression that evaluated to nothing
 * (an out-of-range index, a missing field, an unmatched branch), so we call
 * that out explicitly — it's the single most common property-access mistake.
 */
function keyHint(key: JSONType): string {
  if (key === null) {
    return (
      " A null key usually means a lookup expression produced no value " +
      "(e.g. an out-of-range index or a missing field); guard it before indexing."
    );
  }
  return "";
}

export function accessProperty(evaluatedTarget: JSONType, evaluatedKey: JSONType): JSONType {
  if (
    evaluatedTarget === null ||
    (typeof evaluatedTarget !== "object" && typeof evaluatedTarget !== "string")
  ) {
    throw new Error(
      `Cannot access property ${JSON.stringify(evaluatedKey)}: the target is ` +
        `${describeTarget(evaluatedTarget)}, not an object, array, or string.`,
    );
  }

  if (typeof evaluatedTarget === "string") {
    if (typeof evaluatedKey === "number") {
      return evaluatedTarget[evaluatedKey] ?? null;
    }
    throw new Error(
      `Cannot index a string with key ${JSON.stringify(evaluatedKey)}: string ` +
        `indices must be numbers.${keyHint(evaluatedKey)}`,
    );
  }

  if (Array.isArray(evaluatedKey)) {
    // Walk a folded static path one segment at a time, with the same per-step
    // semantics as a single `$get`: index into strings by number, return null
    // for a missing object key, and throw on a non-object/non-string target.
    // Keeping this in lockstep with the scalar case makes static-segment
    // folding purely an optimization (it never changes results).
    let current: JSONType = evaluatedTarget;
    for (const segment of evaluatedKey) {
      if (typeof current === "string") {
        if (typeof segment !== "number") {
          throw new Error(
            `Invalid $get key for string: expected number, got ${JSON.stringify(segment)}`,
          );
        }
        const character: JSONType | undefined = current[segment];
        if (character === undefined) return null;
        current = character;
      } else if (current === null || typeof current !== "object") {
        throw new Error(
          `Cannot access property ${JSON.stringify(segment)} partway through a ` +
            `path: the value at that point is ${describeTarget(current)}, not an ` +
            `object, array, or string.`,
        );
      } else {
        const next: JSONType | undefined = (current as any)[segment as string | number];
        if (next === undefined) return null;
        current = next;
      }
    }
    return current;
  }

  if (typeof evaluatedKey === "string" || typeof evaluatedKey === "number") {
    const result = (evaluatedTarget as any)[evaluatedKey];
    return result === undefined ? null : result;
  }

  throw new Error(
    `Invalid property key ${JSON.stringify(evaluatedKey)}: a key must be a ` +
      `string, number, or array of strings/numbers. Target is ` +
      `${describeTarget(evaluatedTarget)}.${keyHint(evaluatedKey)}`,
  );
}
