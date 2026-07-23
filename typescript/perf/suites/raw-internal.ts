/**
 * Suite 1: large objects and raw marking inside the interpreter.
 *
 * These benchmarks scale the size of the data while holding the amount of
 * guest work fixed. Where the interpreter handles big values by reference
 * (raw-marked or plain argument passing) the timings should stay flat as the
 * data grows; a linear slope means the value is being re-walked or rebuilt.
 */

import { callFunction, callProgram, createStdlib, raw } from "../../src";
import type { FunctionDeclaration, JSONType } from "../../src";
import type { BenchDef, Mode, Suite } from "../harness";
import { withMetrics } from "../harness";
import { call, fn, get, iff, makeRecords, v } from "../data";

const registry = createStdlib();

export function makeSuite(mode: Mode): Suite {
  const pick = <T>(full: T[], quick: T[]): T[] => (mode === "quick" ? quick : full);
  const benches: BenchDef[] = [];

  // -- 1. Large literal embedded in the program body, raw vs unmarked. -------
  // The first unmarked evaluation discovers and caches a constant subtree;
  // warmed calls should then be as flat as the explicit `$raw` control.
  for (const n of pick([100, 1_000, 10_000], [100, 1_000])) {
    for (const marked of [false, true]) {
      // Separate instances: `$raw` marking is permanent (identity WeakSet).
      const records = makeRecords(n);
      const program = fn([], call("length", v("data")), {
        data: marked ? { $raw: records } : (records as JSONType),
      }) as FunctionDeclaration;
      benches.push({
        name: "body-literal",
        params: { records: n, raw: marked },
        ...withMetrics((limits) => () => callFunction(program, [], registry, limits)),
      });
    }
  }

  // -- 2. Big value threaded through a chain of guest calls. -----------------
  // 100 calls each pass the array along; time should be flat in array size.
  const passModule = {
    loop: fn(
      ["obj", "k"],
      iff(
        call("lte", v("k"), 0),
        call("length", v("obj")),
        call("loop", v("obj"), call("sub", v("k"), 1)),
      ),
    ),
    main: fn(["obj"], call("loop", v("obj"), 100)),
  } as Record<string, JSONType>;
  const nativePass = (obj: unknown[], k: number): number =>
    k <= 0 ? obj.length : nativePass(obj, k - 1);
  for (const n of pick([100, 1_000, 10_000, 100_000], [100, 1_000])) {
    for (const marked of [false, true]) {
      const records = makeRecords(n);
      const arg = marked ? raw(records as JSONType) : (records as JSONType);
      const nativeArg = makeRecords(n) as unknown[];
      benches.push({
        name: "pass-through-calls",
        params: { records: n, raw: marked, calls: 100 },
        ...withMetrics((limits) => () => callProgram(passModule, "main", [arg], registry, limits)),
        native: () => nativePass(nativeArg, 100),
      });
    }
  }

  // -- 3. Big accumulator carried through reduce. -----------------------------
  // The callback returns the accumulator unchanged 500 times; flat expected.
  const carryProgram = fn(
    ["xs"],
    call("length", call("reduce", fn(["acc", "i"], v("acc")), v("xs"), call("range", 500))),
  ) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000, 100_000], [1_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    const nativeArg = makeRecords(n) as unknown[];
    benches.push({
      name: "reduce-carry-big-acc",
      params: { records: n, steps: 500 },
      ...withMetrics((limits) => () => callFunction(carryProgram, [arg], registry, limits)),
      native: () => {
        // The callback returns the accumulator untouched, like the guest code.
        const keep = (accumulator: unknown[]): unknown[] => accumulator;
        let acc = nativeArg;
        for (let i = 0; i < 500; i++) acc = keep(acc);
        return acc.length;
      },
    });
  }

  // -- 4. Indexed reads into a big raw array. ---------------------------------
  // 200 `$get` accesses; flat in array size expected.
  const readProgram = fn(
    ["xs"],
    call("sum", call("map", fn(["i"], get("score", get(v("i"), v("xs")))), call("range", 200))),
  ) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000, 100_000], [1_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    const nativeArg = makeRecords(n) as { score: number }[];
    benches.push({
      name: "indexed-get",
      params: { records: n, reads: 200 },
      ...withMetrics((limits) => () => callFunction(readProgram, [arg], registry, limits)),
      native: () => {
        let total = 0;
        for (let i = 0; i < 200; i++) total += nativeArg[i]!.score;
        return total;
      },
    });
  }

  // -- 5. Immutable updates on a big array (setAt copies). --------------------
  // 50 updates, each a full-array copy: expect ~linear in size. This is the
  // semantic copy cost, kept in the baseline so improvements (e.g. structural
  // sharing) would show up.
  const updateProgram = fn(
    ["xs"],
    call(
      "length",
      call(
        "reduce",
        fn(["acc", "i"], call("setAt", v("acc"), v("i"), 0)),
        v("xs"),
        call("range", 50),
      ),
    ),
  ) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000, 50_000], [1_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    const nativeArg = makeRecords(n) as unknown[];
    benches.push({
      name: "setat-copies",
      params: { records: n, updates: 50 },
      ...withMetrics((limits) => () => callFunction(updateProgram, [arg], registry, limits)),
      native: () => {
        let acc = nativeArg;
        for (let i = 0; i < 50; i++) {
          const copy = acc.slice();
          copy[i] = 0;
          acc = copy;
        }
        return acc.length;
      },
    });
  }

  return { name: "raw-internal", benches };
}
