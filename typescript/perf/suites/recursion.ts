/**
 * Suite 4: deep recursion.
 *
 * The interpreter is a recursive tree-walker: guest call depth and expression
 * nesting both consume JS stack. Depths that overflow are recorded as errors
 * in the results JSON — the set of depths that *succeed* is part of the
 * baseline, so gaining headroom (e.g. via trampolining) shows up as errors
 * turning into timings.
 */

import { callProgram, createStdlib, raw } from "../../src";
import type { ExecutionLimits, JSONType } from "../../src";
import type { BenchDef, Mode, Suite } from "../harness";
import { withMetrics } from "../harness";
import { call, fn, iff, makeRecords, v } from "../data";

const registry = createStdlib();

const module = {
  countdown: fn(["n"], iff(call("lte", v("n"), 0), 0, call("countdown", call("sub", v("n"), 1)))),
  sumTo: fn(
    ["n", "acc"],
    iff(
      call("lte", v("n"), 0),
      v("acc"),
      call("sumTo", call("sub", v("n"), 1), call("add", v("acc"), v("n"))),
    ),
  ),
  isEven: fn(["n"], iff(call("eq", v("n"), 0), true, call("isOdd", call("sub", v("n"), 1)))),
  isOdd: fn(["n"], iff(call("eq", v("n"), 0), false, call("isEven", call("sub", v("n"), 1)))),
  fib: fn(
    ["n"],
    iff(
      call("lte", v("n"), 1),
      v("n"),
      call("add", call("fib", call("sub", v("n"), 1)), call("fib", call("sub", v("n"), 2))),
    ),
  ),
  deepCarry: fn(
    ["n", "xs"],
    iff(
      call("lte", v("n"), 0),
      call("length", v("xs")),
      call("deepCarry", call("sub", v("n"), 1), v("xs")),
    ),
  ),
} as Record<string, JSONType>;

// Each guest recursion level currently consumes 2 interpreter call-depth
// units (the recursive call plus the builtin call in its arguments), so the
// limit needs 2x headroom. If that per-level cost changes, the recorded
// `maxCallDepth` metric will show it.
function depthLimits(depth: number, limits: ExecutionLimits): ExecutionLimits {
  return { maxCallDepth: depth * 2 + 64, ...limits };
}

export function makeSuite(mode: Mode): Suite {
  const pick = <T>(full: T[], quick: T[]): T[] => (mode === "quick" ? quick : full);
  const benches: BenchDef[] = [];

  // -- 1. Linear self-recursion. ------------------------------------------------
  // Currently scales superlinearly with depth, so the depth list stays modest;
  // extend it once per-frame cost is flat.
  for (const depth of pick([1_000, 2_500, 5_000, 10_000], [1_000, 2_500])) {
    const nativeCountdown = (n: number): number => (n <= 0 ? 0 : nativeCountdown(n - 1));
    benches.push({
      name: "countdown",
      params: { depth },
      ...withMetrics(
        (limits) => () =>
          callProgram(module, "countdown", [depth], registry, depthLimits(depth, limits)),
      ),
      native: () => nativeCountdown(depth),
    });
  }

  // -- 2. Linear recursion with an accumulator. ----------------------------------
  for (const depth of pick([1_000, 5_000], [1_000])) {
    benches.push({
      name: "sum-accumulator",
      params: { depth },
      ...withMetrics(
        (limits) => () =>
          callProgram(module, "sumTo", [depth, 0], registry, depthLimits(depth, limits)),
      ),
    });
  }

  // -- 3. Mutual recursion. -------------------------------------------------------
  for (const depth of pick([1_000, 5_000], [1_000])) {
    benches.push({
      name: "mutual-even-odd",
      params: { depth },
      ...withMetrics(
        (limits) => () =>
          callProgram(module, "isEven", [depth], registry, depthLimits(depth, limits)),
      ),
    });
  }

  // -- 4. Tree recursion (per-call overhead under branching). ----------------------
  for (const n of pick([16, 20, 22], [16])) {
    const nativeFib = (k: number): number => (k <= 1 ? k : nativeFib(k - 1) + nativeFib(k - 2));
    benches.push({
      name: "fib",
      params: { n },
      ...withMetrics((limits) => () => callProgram(module, "fib", [n], registry, limits)),
      native: () => nativeFib(n),
    });
  }

  // -- 5. Deep recursion carrying a big raw value. ----------------------------------
  // Flat in payload size expected (reference passing through call frames).
  for (const n of pick([1_000, 100_000], [1_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    const depth = 2_000;
    benches.push({
      name: "deep-carry-payload",
      params: { depth, records: n },
      ...withMetrics(
        (limits) => () =>
          callProgram(module, "deepCarry", [depth, arg], registry, depthLimits(depth, limits)),
      ),
    });
  }

  // -- 6. Deep expression nesting without calls. --------------------------------------
  // Stresses the interpreter's own JS-stack recursion (evaluateExpression /
  // replaceVars). Depths that overflow the JS stack are recorded as errors.
  for (const depth of pick([1_000, 5_000, 10_000, 30_000], [1_000])) {
    let expr: JSONType = 0;
    for (let i = 0; i < depth; i++) expr = call("add", 1, expr);
    const nested = { main: fn([], expr) } as Record<string, JSONType>;
    benches.push({
      name: "deep-expression",
      params: { depth },
      ...withMetrics((limits) => () => callProgram(nested, "main", [], registry, limits)),
      native: () => {
        let total = 0;
        for (let i = 0; i < depth; i++) total += 1;
        return total;
      },
    });
  }

  return { name: "recursion", benches };
}
