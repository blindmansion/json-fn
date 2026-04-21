import {
  callFunction,
  createStdlib,
  enablePerf,
  disablePerf,
  raw,
  type JSONType,
  type PerfStats,
} from "../src";
import type { FunctionDeclaration } from "../src/types";

const functions: Record<string, any> = createStdlib();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bench(label: string, fn: () => void, iterations = 1): { ms: number; opsPerSec: number } {
  for (let i = 0; i < Math.min(3, iterations); i++) fn();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;
  const opsPerSec = iterations / (elapsed / 1000);
  console.log(
    `  ${label}: ${elapsed.toFixed(1)}ms total, ${iterations} iters, ${opsPerSec.toFixed(0)} ops/s`,
  );
  return { ms: elapsed, opsPerSec };
}

function printPerfStats(stats: PerfStats) {
  console.log(`  evaluateExpression:   ${stats.evaluateExpression.toLocaleString()}`);
  console.log(`  getExpressionType:    ${stats.getExpressionType.toLocaleString()}`);
  console.log(`  replaceVars:          ${stats.replaceVars.toLocaleString()}`);
  console.log(`  rawSkips:             ${stats.rawSkips.toLocaleString()}`);
}

function generateRecords(n: number): JSONType[] {
  const cities = ["NYC", "LA", "Chicago", "Houston", "Phoenix"];
  const states = ["NY", "CA", "IL", "TX", "AZ"];
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    age: 20 + (i % 50),
    email: `user_${i}@example.com`,
    address: {
      street: `${100 + i} Main St`,
      city: cities[i % 5]!,
      state: states[i % 5]!,
      zip: `${10000 + i}`,
    },
    tags: [`tag_${i % 10}`, `tag_${(i * 3) % 7}`, `tag_${(i * 7) % 13}`],
    scores: [i % 100, (i * 7) % 100, (i * 13) % 100],
    active: i % 3 !== 0,
  }));
}

// ===========================================================================
// 1. Closure captures large dataset — callback references full array
//
// map over records where each callback captures the full dataset to compute
// a data-relative field (the total count). The callback is called N times,
// and each time the captured array would be walked without raw().
// ===========================================================================
console.log("═══ 1. Closure captures large dataset (map with captured array) ═══\n");

const closureCapture: JSONType = {
  $params: ["records"],
  $return: {
    $fn: "map",
    $args: [
      {
        $params: ["record"],
        $return: {
          name: { $var: "record", $get: "name" },
          totalRecords: { $fn: "length", $args: [{ $var: "records" }] },
        },
      },
      { $var: "records" },
    ],
  },
};

for (const size of [100, 500, 1000]) {
  const data = generateRecords(size);

  console.log(`  --- size=${size}, without raw() ---`);
  let stats = enablePerf();
  bench(`plain`, () => callFunction(closureCapture as FunctionDeclaration, [data], functions), 5);
  disablePerf();
  printPerfStats(stats);

  const rawData = raw(structuredClone(data)) as JSONType[];
  console.log(`  --- size=${size}, with raw() ---`);
  stats = enablePerf();
  bench(
    `raw()`,
    () => callFunction(closureCapture as FunctionDeclaration, [rawData], functions),
    5,
  );
  disablePerf();
  printPerfStats(stats);

  console.log();
}

// ===========================================================================
// 2. Multi-step pipeline — each step's callback captures the original data
//
// Simulates a real pipeline where multiple transformations need to reference
// the original dataset (e.g., for lookups, percentile calculations, etc.)
// ===========================================================================
console.log("═══ 2. Multi-step pipeline with repeated capture ═══\n");

functions.pipelineProcess = {
  $params: ["records"],
  filtered: {
    $fn: "filter",
    $args: [
      {
        $params: ["r"],
        $return: { $var: "r", $get: "active" },
      },
      { $var: "records" },
    ],
  },
  withCount: {
    $fn: "map",
    $args: [
      {
        $params: ["r"],
        $return: {
          name: { $var: "r", $get: "name" },
          age: { $var: "r", $get: "age" },
          totalInDataset: { $fn: "length", $args: [{ $var: "records" }] },
        },
      },
      { $var: "filtered" },
    ],
  },
  sorted: {
    $fn: "sortBy",
    $args: [{ $params: ["r"], $return: { $var: "r", $get: "age" } }, { $var: "withCount" }],
  },
  $return: { $var: "sorted" },
};

for (const size of [100, 500, 1000]) {
  const data = generateRecords(size);

  console.log(`  --- size=${size}, without raw() ---`);
  let stats = enablePerf();
  bench(
    `plain`,
    () => callFunction({ $return: { $fn: "pipelineProcess", $args: [data] } }, [], functions),
    5,
  );
  disablePerf();
  printPerfStats(stats);

  const rawData = raw(structuredClone(data)) as JSONType[];
  console.log(`  --- size=${size}, with raw() ---`);
  stats = enablePerf();
  bench(
    `raw()`,
    () => callFunction({ $return: { $fn: "pipelineProcess", $args: [rawData] } }, [], functions),
    5,
  );
  disablePerf();
  printPerfStats(stats);

  console.log();
}

// ===========================================================================
// 3. Worst case — nested map where inner callback captures large outer data
//
// For each record, map over its tags and produce an object that includes
// a lookup against the full dataset. This means the full dataset is captured
// into the inner callback and walked once per tag per record.
// ===========================================================================
console.log("═══ 3. Nested closure capture (inner callback captures outer data) ═══\n");

const nestedCapture: JSONType = {
  $params: ["records"],
  $return: {
    $fn: "flatMap",
    $args: [
      {
        $params: ["record"],
        $return: {
          $fn: "map",
          $args: [
            {
              $params: ["tag"],
              $return: {
                tag: { $var: "tag" },
                owner: { $var: "record", $get: "name" },
                datasetSize: { $fn: "length", $args: [{ $var: "records" }] },
              },
            },
            { $var: "record", $get: "tags" },
          ],
        },
      },
      { $var: "records" },
    ],
  },
};

for (const size of [50, 200, 500]) {
  const data = generateRecords(size);

  console.log(`  --- size=${size} (${size * 3} inner iterations), without raw() ---`);
  let stats = enablePerf();
  bench(`plain`, () => callFunction(nestedCapture as FunctionDeclaration, [data], functions), 3);
  disablePerf();
  printPerfStats(stats);

  const rawData = raw(structuredClone(data)) as JSONType[];
  console.log(`  --- size=${size} (${size * 3} inner iterations), with raw() ---`);
  stats = enablePerf();
  bench(`raw()`, () => callFunction(nestedCapture as FunctionDeclaration, [rawData], functions), 3);
  disablePerf();
  printPerfStats(stats);

  console.log();
}

// ===========================================================================
// 4. $literal in JSON — same as test 1 but using $literal instead of raw()
// ===========================================================================
console.log("═══ 4. $literal (JSON-level escape) ═══\n");

{
  const size = 500;
  const data = generateRecords(size);

  const withoutLiteral: JSONType = {
    $return: {
      $fn: "map",
      $args: [
        {
          $params: ["record"],
          $return: {
            name: { $var: "record", $get: "name" },
            totalRecords: { $fn: "length", $args: [{ $var: "records" }] },
          },
        },
        { $var: "records" },
      ],
    },
    records: data,
  };

  const withLiteral: JSONType = {
    $return: {
      $fn: "map",
      $args: [
        {
          $params: ["record"],
          $return: {
            name: { $var: "record", $get: "name" },
            totalRecords: { $fn: "length", $args: [{ $var: "records" }] },
          },
        },
        { $var: "records" },
      ],
    },
    records: { $literal: data },
  };

  console.log(`  --- size=${size}, without $literal ---`);
  let stats = enablePerf();
  bench(`plain`, () => callFunction(withoutLiteral as FunctionDeclaration, [], functions), 5);
  disablePerf();
  printPerfStats(stats);

  console.log(`  --- size=${size}, with $literal ---`);
  stats = enablePerf();
  bench(`$literal`, () => callFunction(withLiteral as FunctionDeclaration, [], functions), 5);
  disablePerf();
  printPerfStats(stats);
}

console.log("\n═══ Done ═══");
