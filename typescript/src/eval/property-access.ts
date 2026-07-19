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

const missing = Symbol("missing property");

function accessOne(target: JSONType, key: JSONType): JSONType | typeof missing {
  if (Array.isArray(target)) {
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new Error(
        `Cannot index an array with key ${JSON.stringify(key)}: array indices ` +
          `must be integers.${keyHint(key)}`,
      );
    }
    const value = target[key];
    return value === undefined ? missing : value;
  }

  if (typeof target === "string") {
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new Error(
        `Cannot index a string with key ${JSON.stringify(key)}: string indices ` +
          `must be integers.${keyHint(key)}`,
      );
    }
    const value = target[key];
    return value === undefined ? missing : value;
  }

  if (target !== null && typeof target === "object") {
    if (typeof key !== "string") {
      throw new Error(
        `Cannot index an object with key ${JSON.stringify(key)}: object keys ` +
          `must be strings.${keyHint(key)}`,
      );
    }
    return Object.hasOwn(target, key) ? target[key]! : missing;
  }

  throw new Error(
    `Cannot access property ${JSON.stringify(key)}: the target is ` +
      `${describeTarget(target)}, not an object, array, or string.`,
  );
}

export function accessProperty(evaluatedTarget: JSONType, evaluatedKey: JSONType): JSONType {
  if (Array.isArray(evaluatedKey)) {
    let current = evaluatedTarget;
    for (const segment of evaluatedKey) {
      const next = accessOne(current, segment);
      if (next === missing) return null;
      current = next;
    }
    return current;
  }

  const result = accessOne(evaluatedTarget, evaluatedKey);
  return result === missing ? null : result;
}
