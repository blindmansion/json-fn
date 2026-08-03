/**
 * Own-property helpers for objects with guest-controlled keys.
 *
 * Guest-object invariant: every JSON key is an own, enumerable, writable data
 * property. Plain assignment breaks this for the key `"__proto__"` — on an
 * ordinary object it invokes the inherited `Object.prototype.__proto__`
 * accessor instead of defining an own property, silently dropping the entry.
 * Plain reads and `in` checks break the complementary invariant by observing
 * inherited `Object.prototype` members (`constructor`, `toString`, ...) as if
 * they were entries.
 *
 * Every path that constructs or consults an object keyed by guest-controlled
 * strings (parser, evaluator, closure transforms, checker property maps,
 * stdlib transforms, environment/namespace construction, registries, codecs)
 * must use these helpers or an equivalent own-property operation
 * (`Object.hasOwn`, `Object.fromEntries`, spread, `Object.create(null)`).
 * See plans/runtime-representation-gaps.md §1.
 */

/** Set `key` on `target` as an own enumerable writable data property. */
export function setOwnProperty<T>(target: Record<string, T>, key: string, value: NoInfer<T>): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** Read `key` from `record` only when it is an own property. */
export function getOwnProperty<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
