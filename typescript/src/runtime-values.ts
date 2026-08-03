/**
 * Runtime-value identity marking (plans/raw-semantics-cleanup.md).
 *
 * A runtime value is an object or array that has already crossed from
 * expression syntax into value space: an evaluated `$raw` payload, a public
 * entry argument, a substituted binding, a call result, a task node, or a
 * rehydrated continuation. If it later appears in expression position, the
 * evaluator must return it as a value rather than classify it from its keys.
 *
 * The mark is ephemeral object-identity metadata: it never serializes, and it
 * must never change results, errors, or deterministic fuel — only the
 * traversal work needed to reach them. Serialization loses the mark;
 * hydration restores it from stable structural tags on validated shapes.
 */
import type { JSONType } from "./types";

const runtimeValues = new WeakSet<object>();

/** Mark an already-produced value so it is never reinterpreted as syntax. */
export function markRuntimeValue(value: JSONType): JSONType {
  if (typeof value === "object" && value !== null) {
    runtimeValues.add(value);
  }
  return value;
}

/** True when the value has crossed a value boundary and must stay inert. */
export function isRuntimeValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && runtimeValues.has(value);
}
