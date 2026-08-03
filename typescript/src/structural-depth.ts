/**
 * Portable structural-depth limit (see `docs/execution-limits.md` and
 * `plans/runtime-representation-gaps.md` section 2).
 *
 * One counting rule is shared by every traversal: the structural depth of a
 * JSON tree is the number of nested container (array/object) levels along its
 * deepest path — scalars have depth 0 and an array or object has depth
 * `1 + max(depth of children)`. Trees deeper than `MAX_STRUCTURAL_DEPTH` are
 * rejected with one deterministic limit error, fired consistently before any
 * host stack is at risk. The limit is a fixed language constant, not a
 * configurable execution limit.
 *
 * The evaluator additionally enforces `MAX_EVALUATION_NESTING`, a dynamic cap
 * on nested expression evaluations *including through guest function calls*.
 * The static per-tree limit bounds each artifact, but evaluation nesting
 * compounds across call frames (call depth multiplies with the expression
 * depth at each call site), so a separate deterministic cap is required to
 * keep the evaluator itself off the host stack limit.
 */

export const MAX_STRUCTURAL_DEPTH = 512;

export const MAX_EVALUATION_NESTING = 4096;

export function structuralDepthError(): Error {
  return new Error(`Maximum structural depth of ${MAX_STRUCTURAL_DEPTH} exceeded`);
}

export function evaluationNestingError(): Error {
  return new Error(`Maximum evaluation nesting of ${MAX_EVALUATION_NESTING} exceeded`);
}

// Exact structural depth per verified container, keyed by identity. Guest
// trees are treated as immutable after construction (the evaluator's
// constant-subtree cache relies on the same invariant), so a cached depth
// stays valid. The cache makes repeated verification of the same tree — hot
// paths re-checking a prepared program or a value crossing the host boundary
// several times — amortized O(1), and lets composed trees (e.g. closure
// bodies that embed already-verified subtrees) verify without re-walking the
// shared parts.
const depthCache = new WeakMap<object, number>();

type Frame = {
  node: object;
  children: unknown[];
  next: number;
  /** Max structural depth among the children visited so far. */
  max: number;
};

function frameFor(node: object): Frame {
  return {
    node,
    children: Array.isArray(node) ? node : Object.values(node),
    next: 0,
    max: 0,
  };
}

/**
 * Verify that `value` does not exceed the portable structural-depth limit,
 * throwing the canonical limit error when it does. The walk is iterative
 * (explicit work stack), so adversarially deep host input can never exhaust
 * the host call stack; cyclic host objects fail with the same limit error
 * once their unrolled depth passes the limit.
 */
export function assertStructuralDepth(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  // Cached depths are always within the limit: deeper trees throw before any
  // of their containers are cached.
  if (depthCache.has(value)) return;
  // `frames.length` is the container-nesting level of the frame currently on
  // top: the root container sits at level 1, so exceeding the limit during
  // descent proves the root's depth exceeds it too.
  const frames: Frame[] = [frameFor(value)];
  if (frames.length > MAX_STRUCTURAL_DEPTH) throw structuralDepthError();
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next++];
      if (child === null || typeof child !== "object") continue;
      const childCached = depthCache.get(child);
      if (childCached !== undefined) {
        // A verified subtree at nesting level `frames.length + 1` contributes
        // `frames.length + childCached` total levels along its deepest path.
        if (frames.length + childCached > MAX_STRUCTURAL_DEPTH) throw structuralDepthError();
        if (childCached > frame.max) frame.max = childCached;
        continue;
      }
      if (frames.length + 1 > MAX_STRUCTURAL_DEPTH) throw structuralDepthError();
      frames.push(frameFor(child));
      continue;
    }
    frames.pop();
    const depth = frame.max + 1;
    depthCache.set(frame.node, depth);
    const parent = frames[frames.length - 1];
    if (parent !== undefined && depth > parent.max) parent.max = depth;
  }
}
