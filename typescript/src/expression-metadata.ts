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

/**
 * Record the complete deterministic evaluation cost of a proven static
 * subtree. `cost` counts one unit per JSON value node of the produced value
 * (object keys are not separately charged), matching what first evaluation
 * of the equivalent plain constant literal charges.
 *
 * Called by the evaluator when first evaluation proves a literal constant by
 * identity, and by the shorthand parser to preseed literals it has proven
 * static from grammar provenance.
 */
export function rememberStaticCost(node: StaticNode, cost: number): void {
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
