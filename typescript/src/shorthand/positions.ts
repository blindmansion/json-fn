/**
 * Resolve checker diagnostic paths back to `.jfn` source positions.
 *
 * The checker reports locations as paths into the canonical JSON encoding
 * (`["coreSheet", "D2", "$args[0]", "$args[1]"]`). Given the parsed root and
 * the position side table produced by `parseModuleWithPositions` /
 * `parseExpressionWithPositions`, this walks the canonical tree along the
 * path and returns the position of the deepest node the parser recorded —
 * falling back to the nearest recorded ancestor when the path ends on a
 * scalar leaf or on a node the checker synthesized.
 */

import type { JSONType } from "../types";
import type { SourcePos } from "./parser";

// One path segment: an optional leading object key followed by zero or more
// `[i]` index steps (`$args[0]`, `[1]`, `$cases[0][0]`, plain keys).
const SEGMENT = /^([^[]*)((?:\[\d+\])*)$/;

function positionOf(node: JSONType, positions: WeakMap<object, SourcePos>): SourcePos | undefined {
  if (node === null || typeof node !== "object") return undefined;
  return positions.get(node);
}

/** Walk `root` along a diagnostic `path`, returning the source position of
 * the deepest recorded node on the way (or `undefined` when nothing on the
 * path was recorded). Unresolvable segments stop the walk gracefully. */
export function resolvePathPosition(
  root: JSONType,
  positions: WeakMap<object, SourcePos>,
  path: string[],
): SourcePos | undefined {
  let node: JSONType = root;
  let best = positionOf(node, positions);
  for (const segment of path) {
    const m = SEGMENT.exec(segment);
    if (m === null) return best;
    const steps: (string | number)[] = [];
    if (m[1] !== "") steps.push(m[1]!);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) steps.push(Number(idx[1]));
    for (const step of steps) {
      if (typeof step === "string") {
        if (
          node === null ||
          typeof node !== "object" ||
          Array.isArray(node) ||
          !Object.prototype.hasOwnProperty.call(node, step)
        ) {
          return best;
        }
        node = (node as Record<string, JSONType>)[step]!;
      } else {
        if (!Array.isArray(node) || step >= node.length) return best;
        node = node[step]!;
      }
      best = positionOf(node, positions) ?? best;
    }
  }
  return best;
}
