/**
 * Suite 2: large values crossing the language boundary.
 *
 * Covers plain argument passing into `callFunction`, external JS functions
 * (pure = by reference vs impure = structuredClone), and the effects kernel
 * via `runTask` (entry argument validation, effect result contracts, and
 * per-hop trampoline overhead with large payloads in flight).
 */

import { callFunction, createStdlib, pure, raw, runTask } from "../../src";
import type {
  Environment,
  FunctionDeclaration,
  FunctionRegistry,
  JSONType,
  Schema,
} from "../../src";
import type { BenchDef, Mode, Suite } from "../harness";
import { withMetrics } from "../harness";
import { call, callExpr, fn, get, iff, makeRecords, v } from "../data";

const registry = createStdlib();

const recordSchema: Schema = {
  type: "object",
  required: ["id", "name", "score", "active", "tags", "meta"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    score: { type: "number" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    meta: { type: "object" },
  },
  additionalProperties: false,
} as Schema;

const looseArray: Schema = { type: "array" } as Schema;
const strictArray: Schema = { type: "array", items: recordSchema } as Schema;

function taskEnvironment(
  effects: Record<string, { params: Schema[]; returns: Schema }>,
  required: Schema[] = [],
): Environment {
  return {
    functions: {},
    effects,
    entry: {
      name: "main",
      required,
      optional: [],
      returns: { task: { type: "integer" } as Schema },
    },
  };
}

/** `effects.<name>(...)` in canonical JSON. */
function effectCall(name: string, ...args: JSONType[]): JSONType {
  return callExpr(get(name, v("effects")), ...args);
}

export function makeSuite(mode: Mode): Suite {
  const pick = <T>(full: T[], quick: T[]): T[] => (mode === "quick" ? quick : full);
  const benches: BenchDef[] = [];

  // -- 1. Big argument in, O(1) guest work. -----------------------------------
  // Flat timings mean the argument crosses by reference.
  const lengthProgram = fn(["xs"], call("length", v("xs"))) as FunctionDeclaration;
  const identityProgram = fn(["xs"], v("xs")) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000, 100_000], [1_000, 10_000])) {
    for (const marked of [false, true]) {
      const arg = marked ? raw(makeRecords(n) as JSONType) : (makeRecords(n) as JSONType);
      benches.push({
        name: "arg-length",
        params: { records: n, raw: marked },
        ...withMetrics((limits) => () => callFunction(lengthProgram, [arg], registry, limits)),
      });
    }
    const arg = raw(makeRecords(n) as JSONType);
    benches.push({
      name: "arg-identity",
      params: { records: n },
      ...withMetrics((limits) => () => callFunction(identityProgram, [arg], registry, limits)),
    });
  }

  // -- 2. Argument captured into a closure, then invoked. ---------------------
  // Substitution inlines the value by reference and auto-marks data values.
  // The unmarked case should therefore match the explicit raw control.
  const captureProgram = fn(
    ["xs"],
    call("sum", call("map", fn(["i"], get("score", get(v("i"), v("xs")))), call("range", 50))),
  ) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000], [1_000])) {
    for (const marked of [false, true]) {
      const arg = marked ? raw(makeRecords(n) as JSONType) : (makeRecords(n) as JSONType);
      benches.push({
        name: "capture-then-invoke",
        params: { records: n, raw: marked, invocations: 50 },
        ...withMetrics((limits) => () => callFunction(captureProgram, [arg], registry, limits)),
      });
    }
  }

  // -- 3. External JS functions: pure (by reference) vs impure (cloned). ------
  const consumeProgram = fn(["xs"], call("consume", v("xs"))) as FunctionDeclaration;
  const echoProgram = fn(["xs"], call("length", call("echo", v("xs")))) as FunctionDeclaration;
  for (const n of pick([1_000, 10_000, 100_000], [1_000, 10_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    for (const isPure of [false, true]) {
      const consume = (xs: JSONType): number => (xs as JSONType[]).length;
      const withConsume: FunctionRegistry = {
        ...registry,
        consume: (isPure ? pure(consume) : consume) as FunctionRegistry[string],
      };
      benches.push({
        name: "external-consume",
        params: { records: n, pure: isPure },
        ...withMetrics((limits) => () => callFunction(consumeProgram, [arg], withConsume, limits)),
      });

      const echo = (xs: JSONType): JSONType => xs;
      const withEcho: FunctionRegistry = {
        ...registry,
        echo: (isPure ? pure(echo) : echo) as FunctionRegistry[string],
      };
      benches.push({
        name: "external-echo",
        params: { records: n, pure: isPure },
        ...withMetrics((limits) => () => callFunction(echoProgram, [arg], withEcho, limits)),
      });
    }
  }

  // -- 4. runTask fixed overhead (module prep, env validation, one pure step).
  const noopModule = { main: fn([], call("pure", 0)) } as Record<string, JSONType>;
  const noopEnv = taskEnvironment({});
  benches.push({
    name: "runtask-noop",
    params: {},
    ...withMetrics(
      (limits) => () => runTask(noopModule, noopEnv, [], { registry, capabilities: {} }, limits),
    ),
  });

  // -- 5. Effect result contracts: loose vs strict schema over a big payload. -
  // Loose is O(1) validation; strict walks every record on delivery.
  const fetchModule = {
    main: fn(
      [],
      call("bind", effectCall("fetch"), fn(["p"], call("pure", call("length", v("p"))))),
    ),
  } as Record<string, JSONType>;
  for (const n of pick([1_000, 10_000, 100_000], [1_000])) {
    const payload = makeRecords(n) as JSONType;
    for (const strict of [false, true]) {
      const env = taskEnvironment({
        fetch: { params: [], returns: strict ? strictArray : looseArray },
      });
      const host = { registry, capabilities: { fetch: () => payload } };
      benches.push({
        name: "effect-result",
        params: { records: n, strict },
        ...withMetrics((limits) => () => runTask(fetchModule, env, [], host, limits)),
      });
    }
  }

  // -- 6. Trampoline hops: per-suspension overhead, small and large payloads. -
  const hopModule = {
    loop: fn(
      ["k"],
      iff(
        call("lte", v("k"), 0),
        call("pure", 0),
        call("bind", effectCall("fetch"), fn(["p"], call("loop", call("sub", v("k"), 1)))),
      ),
    ),
    main: fn(["k"], call("loop", v("k"))),
  } as Record<string, JSONType>;
  for (const hops of pick([10, 100], [10])) {
    for (const n of pick([0, 10_000], [0])) {
      const payload = (n === 0 ? null : makeRecords(n)) as JSONType;
      const env = taskEnvironment(
        { fetch: { params: [], returns: n === 0 ? ({ type: "null" } as Schema) : looseArray } },
        [{ type: "integer" } as Schema],
      );
      const host = { registry, capabilities: { fetch: () => payload } };
      benches.push({
        name: "trampoline-hops",
        params: { hops, payloadRecords: n },
        ...withMetrics((limits) => () => runTask(hopModule, env, [hops], host, limits)),
      });
    }
  }

  // -- 7. Entry argument validation: loose vs strict schema on a big argument.
  const entryModule = {
    main: fn(["xs"], call("pure", call("length", v("xs")))),
  } as Record<string, JSONType>;
  for (const n of pick([1_000, 10_000, 100_000], [1_000])) {
    const arg = raw(makeRecords(n) as JSONType);
    for (const strict of [false, true]) {
      const env = taskEnvironment({}, [strict ? strictArray : looseArray]);
      const host = { registry, capabilities: {} };
      benches.push({
        name: "entry-arg-validation",
        params: { records: n, strict },
        ...withMetrics((limits) => () => runTask(entryModule, env, [arg], host, limits)),
      });
    }
  }

  return { name: "boundary", benches };
}
