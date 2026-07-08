// report-workflow.ts — host driver for examples/report-workflow.jfn.
//
// The effects system end to end: "import" the guest standard library
// (effects-lib.jfn) by merging its combinators into the module, add the app,
// statically inspect what the app could ever ask for (`requiredCapabilities`),
// then drive `main` with `runTask` against a set of mock host capabilities.
//
// The HTTP capability is deliberately *flaky* (transient 503s, one missing
// user) so the in-language `retry` and `orElse` combinators from the library do
// real work: retries recover the transient failures, and the cache fallback
// covers the user the live API never returns. The host answers only raw I/O;
// every failure decision is made in-language over the `raise` effect.
//
// Run it:
//   bun run typescript/examples/report-workflow.ts

import {
  runTask,
  requiredCapabilities,
  createStdlib,
  parseShorthand,
  TaskRaiseError,
  type JSONType,
} from "../src";
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), "utf-8");

// "Import" the guest effects library and the app, then merge into one module.
// This is what a module system would do for you; for now it is a record spread.
const lib = parseShorthand(read("../../examples/effects-lib.jfn")) as Record<string, JSONType>;
const app = parseShorthand(read("../../examples/report-workflow.jfn")) as Record<string, JSONType>;
const module = { ...lib, ...app };

// ----- mock host capabilities -----

// Live user directory. User 3 is intentionally absent: the live API 404s, so
// the workflow falls back to the cache below.
const liveUsers: Record<string, { name: string }> = {
  "/users/1": { name: "Ada Lovelace" },
  "/users/2": { name: "Alan Turing" },
};

// The cache happens to hold the user the live API is missing.
const cache: Record<string, { name: string }> = {
  "/users/3": { name: "Grace Hopper" },
};

// Flaky endpoint: the first two GETs for any live URL return 503, the third
// succeeds. Missing URLs always 404. The per-URL attempt counter lives here in
// the host, so re-running the same task value (what `retry` does) really does
// hit the network again.
const attempts = new Map<string, number>();

const capabilities = {
  "db.userIds": (): JSONType => [1, 2, 3],

  "http.get": (url: JSONType): JSONType => {
    const key = url as string;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    if (!(key in liveUsers)) {
      console.log(`  GET ${key} -> 404`);
      return { status: 404, body: null };
    }
    if (n < 3) {
      console.log(`  GET ${key} -> 503 (attempt ${n}, transient)`);
      return { status: 503, body: null };
    }
    console.log(`  GET ${key} -> 200 (attempt ${n})`);
    return { status: 200, body: liveUsers[key]! };
  },

  "http.post": (url: JSONType, body: JSONType): JSONType => {
    console.log(`  POST ${url as string} <- ${JSON.stringify(body)}`);
    return "report-2026-07-08";
  },

  "cache.get": (url: JSONType): JSONType => {
    const hit = cache[url as string] ?? null;
    console.log(`  CACHE ${url as string} -> ${hit ? "hit" : "miss"}`);
    return hit;
  },

  log: (msg: JSONType): JSONType => {
    console.log(`  LOG: ${msg as string}`);
    return null;
  },
};

// ----- admission check: what could the app ever ask for? -----
// A pure static walk over the app JSON. "raise" appears because the walk cannot
// prove retry/orElse discharge it in-language — the over-approximation is
// deliberate. A real host would compare `required.names` against the
// capabilities it is willing to grant and reject before running.
const required = requiredCapabilities(app);
console.log(`required capabilities: ${required.names.join(", ")}`);
console.log(`dynamic effect names?  ${required.dynamic}\n`);

// ----- run it -----
console.log("running workflow:");
try {
  const result = await runTask(module, "main", [], createStdlib(), capabilities);
  console.log("\nresult:");
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  // An uncaught in-language `raise` carries a structured payload; any other
  // evaluator error (bad property key, fuel/depth limit, …) is a program bug.
  // Present both cleanly rather than dumping the host stack trace.
  if (err instanceof TaskRaiseError) {
    console.error("\nworkflow raised (uncaught):", JSON.stringify(err.payload));
  } else {
    console.error("\nworkflow failed (evaluator error):", (err as Error).message);
  }
  process.exit(1);
}
