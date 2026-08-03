/**
 * Suite 3: closure creation and escape.
 *
 * Closure capture is `replaceVars` — a walk of the escaping lambda's body AST
 * substituting free variables. These benchmarks scale the inputs that walk is
 * sensitive to: body size, number of captured bindings, captured value size
 * (should be O(1) — values are inlined by reference), closures created per
 * element, curried nesting depth (repeated re-capture of the remaining body),
 * and transitive local-function attachment.
 */

import { callFunction, callProgram, createStdlib } from "../../src";
import { markRuntimeValue } from "../../src/runtime-values";
import type { FunctionDeclaration, JSONType } from "../../src";
import type { BenchDef, Mode, Suite } from "../harness";
import { withMetrics } from "../harness";
import { addChain, call, fn, get, makeRecords, v } from "../data";

const registry = createStdlib();

export function makeSuite(mode: Mode): Suite {
  const pick = <T>(full: T[], quick: T[]): T[] => (mode === "quick" ? quick : full);
  const benches: BenchDef[] = [];

  // -- 1. Escape cost scales with the lambda body size. -----------------------
  // Each chain link adds two container levels, so the structural-depth limit
  // (512) allows ~250 links; 1_024 records the deterministic limit error.
  for (const nodes of pick([16, 128, 250, 1_024], [16, 128])) {
    const program = fn([], {
      $params: ["y"],
      $return: addChain("y", nodes),
    }) as FunctionDeclaration;
    benches.push({
      name: "escape-body-size",
      params: { bodyCalls: nodes },
      ...withMetrics((limits) => () => callFunction(program, [], registry, limits)),
    });
  }

  // -- 2. Escape cost vs number of captured bindings. --------------------------
  // The summing chain nests one call per binding (two container levels), so
  // the structural-depth limit keeps the series at or below 250 bindings.
  for (const vars of pick([8, 64, 250], [8, 64])) {
    const bindings: Record<string, JSONType> = {};
    let chain: JSONType = 0;
    for (let i = 0; i < vars; i++) {
      bindings[`c${i}`] = i;
      chain = call("add", v(`c${i}`), chain);
    }
    const program = fn([], { $params: ["y"], $return: chain }, bindings) as FunctionDeclaration;
    benches.push({
      name: "escape-capture-count",
      params: { vars },
      ...withMetrics((limits) => () => callFunction(program, [], registry, limits)),
    });
  }

  // -- 3. Capturing a big value should be O(1) (inlined by reference). --------
  const captureProgram = fn(["xs"], {
    $params: ["i"],
    $return: get(v("i"), v("xs")),
  }) as FunctionDeclaration;
  for (const n of pick([1_000, 100_000], [1_000])) {
    for (const marked of [false, true]) {
      const arg = marked
        ? markRuntimeValue(makeRecords(n) as JSONType)
        : (makeRecords(n) as JSONType);
      benches.push({
        name: "capture-big-value",
        params: { records: n, raw: marked },
        ...withMetrics((limits) => () => callFunction(captureProgram, [arg], registry, limits)),
      });
    }
  }

  // -- 4. Invoking a closure that holds a big captured value. ------------------
  // The captured array sits in expression position. Substitution should
  // auto-mark the unmarked case, keeping both variants flat per invocation.
  const invokeProgram = fn(["xs"], call("sum", call("map", v("f"), call("range", 50))), {
    f: { $params: ["i"], $return: get("score", get(v("i"), v("xs"))) },
  }) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000], [1_000])) {
    for (const marked of [false, true]) {
      const arg = marked
        ? markRuntimeValue(makeRecords(n) as JSONType)
        : (makeRecords(n) as JSONType);
      benches.push({
        name: "invoke-big-capture",
        params: { records: n, raw: marked, invocations: 50 },
        ...withMetrics((limits) => () => callFunction(invokeProgram, [arg], registry, limits)),
      });
    }
  }

  // -- 5. Host applies an escaped closure repeatedly. --------------------------
  {
    const arg = markRuntimeValue(makeRecords(10_000) as JSONType);
    const closure = callFunction(captureProgram, [arg], registry) as FunctionDeclaration;
    benches.push({
      name: "apply-escaped-closure",
      params: { records: 10_000 },
      ...withMetrics((limits) => () => callFunction(closure, [7], registry, limits)),
    });
  }

  // -- 6. One small closure created per array element. --------------------------
  for (const n of pick([100, 1_000, 10_000], [100, 1_000])) {
    const program = fn(
      [],
      call(
        "length",
        call(
          "map",
          fn(["i"], { $params: ["y"], $return: call("add", v("i"), v("y")) }),
          call("range", n),
        ),
      ),
    ) as FunctionDeclaration;
    benches.push({
      name: "closure-per-element",
      params: { closures: n },
      ...withMetrics((limits) => () => callFunction(program, [], registry, limits)),
      native: () => {
        const fns: ((y: number) => number)[] = [];
        for (let i = 0; i < n; i++) fns.push((y: number) => i + y);
        return fns.length;
      },
    });
  }

  // -- 7. Curried application: each application re-captures the remaining body.
  // Expected O(depth^2) overall; anything worse than quadratic is a bug this
  // baseline should surface.
  for (const depth of pick([4, 16, 64, 128], [4, 16])) {
    let inner: JSONType = 0;
    for (let i = 0; i < depth; i++) inner = call("add", v(`x${i}`), inner);
    let lambda: JSONType = inner;
    for (let i = depth - 1; i >= 0; i--) lambda = { $params: [`x${i}`], $return: lambda };
    const module = { main: fn([], lambda) } as Record<string, JSONType>;
    benches.push({
      name: "curried-apply",
      params: { depth },
      ...withMetrics((limits) => () => {
        let value = callProgram(module, "main", [], registry, limits);
        for (let i = 0; i < depth; i++) {
          value = callFunction(value as FunctionDeclaration, [1], registry, limits);
        }
        return value;
      }),
    });
  }

  // -- 8. Transitive attachment of local functions on escape. ------------------
  // The escaping lambda calls h0, which calls h1, ... — the whole chain is
  // re-attached into the escaping body.
  function attachChainModule(k: number): Record<string, JSONType> {
    const bindings: Record<string, JSONType> = {};
    for (let i = 0; i < k; i++) {
      bindings[`h${i}`] = fn(["y"], i === k - 1 ? v("y") : call(`h${i + 1}`, v("y")));
    }
    return {
      main: fn([], { $params: ["y"], $return: call("h0", v("y")) }, bindings),
    };
  }
  for (const k of pick([4, 32, 128, 512], [4, 32])) {
    const module = attachChainModule(k);
    benches.push({
      name: "attach-local-fns",
      params: { localFns: k },
      ...withMetrics((limits) => () => callProgram(module, "main", [], registry, limits)),
    });
  }

  // -- 9. Attachment repeated once per escaping element. ------------------------
  function attachPerElementModule(k: number, escapes: number): Record<string, JSONType> {
    const bindings: Record<string, JSONType> = {};
    for (let i = 0; i < k; i++) {
      bindings[`h${i}`] = fn(["y"], i === k - 1 ? v("y") : call(`h${i + 1}`, v("y")));
    }
    return {
      main: fn(
        [],
        call(
          "length",
          call(
            "map",
            fn(["j"], { $params: ["y"], $return: call("h0", v("y")) }),
            call("range", escapes),
          ),
        ),
        bindings,
      ),
    };
  }
  for (const k of pick([4, 32, 128], [4])) {
    const module = attachPerElementModule(k, 100);
    benches.push({
      name: "attach-per-escape",
      params: { localFns: k, escapes: 100 },
      ...withMetrics((limits) => () => callProgram(module, "main", [], registry, limits)),
    });
  }

  return { name: "closures", benches };
}
