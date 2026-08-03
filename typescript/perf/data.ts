/** Shared data and program generators for the perf suites. */

import type { JSONType } from "../src";

/**
 * An array of `n` realistic-ish records, roughly 12 JSON nodes each. Callers
 * that need both a raw-marked and an unmarked copy of the "same" data must
 * generate two separate instances: raw marking is by object identity in a
 * process-wide WeakSet, so a single instance cannot be both.
 */
export function makeRecords(n: number): JSONType[] {
  const records: JSONType[] = [];
  for (let i = 0; i < n; i++) {
    records.push({
      id: i,
      name: `record-${i}`,
      score: (i * 7919) % 1000,
      active: i % 3 === 0,
      tags: [`t${i % 5}`, `t${i % 11}`, `t${i % 17}`],
      meta: { region: `r${i % 8}`, weight: i * 0.5, parent: i === 0 ? null : i - 1 },
    });
  }
  return records;
}

/** Approximate JSON node count of one `makeRecords` record. */
export const RECORD_NODES = 12;

/**
 * Deterministic static-literal cost of a pure-data JSON tree: one unit per
 * value node (object keys are not separately charged). Matches what first
 * evaluation of an equivalent plain constant literal charges, so suites can
 * preseed `rememberStaticCost` the way the shorthand parser will.
 */
export function staticLiteralCost(node: JSONType): number {
  let cost = 0;
  const stack: JSONType[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    cost += 1;
    if (current !== null && typeof current === "object") {
      const children = Array.isArray(current) ? current : Object.values(current);
      for (const child of children) stack.push(child);
    }
  }
  return cost;
}

export function call(name: string, ...args: JSONType[]): JSONType {
  return { $call: name, $args: args };
}

/** Call with a non-identifier callee expression (e.g. `effects.fetch`). */
export function callExpr(callee: JSONType, ...args: JSONType[]): JSONType {
  return { $call: callee, $args: args };
}

export function iff(cond: JSONType, then: JSONType, els: JSONType): JSONType {
  return { $if: cond, $then: then, $else: els };
}

export function v(name: string): JSONType {
  return { $var: name };
}

export function get(key: JSONType, from: JSONType): JSONType {
  return { $get: key, $from: from };
}

/** Structural function body with optional `$let` bindings in its return. */
export function fn(
  params: string[],
  ret: JSONType,
  bindings: Record<string, JSONType> = {},
): Record<string, JSONType> {
  return {
    $params: params,
    $return: Object.keys(bindings).length === 0 ? ret : { $let: bindings, $in: ret },
  };
}

/** A right-leaning chain `add(x, add(x, ... add(x, 0)))` with `depth` calls. */
export function addChain(varName: string, depth: number): JSONType {
  let expr: JSONType = 0;
  for (let i = 0; i < depth; i++) {
    expr = call("add", v(varName), expr);
  }
  return expr;
}
