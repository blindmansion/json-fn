// Ephemeral constant-expression metadata.
//
// A pure-data program subtree evaluates to itself, so once its complete
// deterministic cost is known, later evaluations can skip descendant
// classification and allocation while still charging the same fuel. This
// module owns that cache so both the evaluator (first-evaluation discovery)
// and the shorthand parser (preseeding proven static literals) can populate
// it without either owning the other's implementation.
//
// Properties of this metadata:
// - object-identity based (a `WeakMap` keyed by the AST node);
// - non-serializable — JSON round trips lose it;
// - safe to lose — the evaluator rediscovers costs on first evaluation;
// - affects traversal work only; and
// - never changes classification, results, errors, or deterministic fuel:
//   it stores the complete cost that must still be charged.
//
// This is distinct from both canonical `$raw` (a serializable value/syntax
// boundary) and runtime-value marking (`src/runtime-values.ts`, identity
// metadata for already-produced values). A node with a recorded static cost
// is still syntax; it must keep charging its full recorded cost even when it
// is also its own evaluation result.

import type { JSONType } from "./types";

type StaticNode = JSONType[] | { [key: string]: JSONType };

const staticCosts = new WeakMap<object, number>();

// Provenance for performance counters only: whether a recorded static cost
// was preseeded (parser-style) or discovered by the evaluator. Never affects
// fuel or results — both routes charge the identical recorded cost.
const preseededNodes = new WeakSet<object>();

/**
 * The deterministic static-literal cost of a pure-data JSON tree: one unit
 * per value node of the produced value (object keys are not separately
 * charged). This is the one normative node-count function shared by the
 * evaluator's cold constant discovery, parser-preseeded static literals, and
 * `$raw` payload charging — every ingestion route of the same value charges
 * the same fuel.
 *
 * Iterative: `$raw` payloads and preseeded literals are only bounded by the
 * portable structural-depth limit, not by evaluation nesting.
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

/**
 * Record the complete deterministic evaluation cost of a proven static
 * subtree. `cost` counts one unit per JSON value node of the produced value
 * (object keys are not separately charged), matching what first evaluation
 * of the equivalent plain constant literal charges.
 *
 * This is the parser-facing preseed operation for literals proven static
 * from grammar provenance. The evaluator's own first-evaluation discovery
 * uses `recordDiscoveredStaticCost` so performance counters can attribute a
 * later skip to its route; both record the same normative cost.
 */
export function rememberStaticCost(node: StaticNode, cost: number): void {
  staticCosts.set(node, cost);
  preseededNodes.add(node);
}

/**
 * Record a static cost the evaluator discovered by evaluating the literal
 * once. Identical semantics to `rememberStaticCost`; kept separate only so
 * skip counters can distinguish preseeded from discovered constants.
 */
export function recordDiscoveredStaticCost(node: StaticNode, cost: number): void {
  staticCosts.set(node, cost);
}

/** The recorded static cost of a node, or undefined when never proven. */
export function getStaticCost(node: object): number | undefined {
  return staticCosts.get(node);
}

/** True when the node has a recorded static cost. */
export function hasStaticCost(node: object): boolean {
  return staticCosts.has(node);
}

/** True when the node's static cost was preseeded rather than discovered. */
export function wasPreseeded(node: object): boolean {
  return preseededNodes.has(node);
}

// `$raw` payload costs, cached by payload identity. Kept separate from
// `staticCosts` on purpose: recording a static cost changes how the
// evaluator treats a node that re-enters expression position (a constant
// subtree must re-charge its full cost through the literal evaluators),
// while an evaluated `$raw` payload is a runtime value whose re-entry stays
// at the one-node cost. Only the `$raw` evaluation itself charges from this
// cache.
const rawPayloadCosts = new WeakMap<object, number>();

/**
 * The complete deterministic cost of evaluating a `$raw` boundary around
 * `payload` (`rawCost(payload) = staticLiteralCost(payload)`), computed on
 * first use and cached by payload identity. Losing the cache (fresh
 * identities after a JSON round trip) changes host work only, never fuel.
 */
export function rawPayloadCost(payload: JSONType): number {
  if (payload === null || typeof payload !== "object") return 1;
  let cost = rawPayloadCosts.get(payload);
  if (cost === undefined) {
    cost = staticLiteralCost(payload);
    rawPayloadCosts.set(payload, cost);
  }
  return cost;
}
