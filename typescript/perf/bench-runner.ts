#!/usr/bin/env bun
// Benchmark runner for the JSON expression language (TypeScript port of
// bench_runner.zig).
//
// Usage: bun bench-runner.ts [bench-dir] [filter ...] [--iters N]
//
// Loads every *.json file in the bench directory whose name contains one
// of the filter substrings (all files when no filter is given). Each file
// is a single case-style wrapper:
//   { description, body, args?, functions?, limits?, expected }
//
// For each file the runner parses the JSON once, evaluates once as a
// warmup and verifies the result against `expected`, then times `--iters`
// further evaluations (default 5). Only evaluation is timed, never JSON
// parsing. Reports min and mean wall time per file and exits nonzero if
// any benchmark produced a wrong result or an error.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { callFunction, createStdlib } from "../src";
import type { ExecutionLimits, FunctionRegistry, JSONType } from "../src";

interface BenchCase {
  description: string;
  body: JSONType;
  args?: JSONType[];
  functions?: Record<string, JSONType>;
  limits?: ExecutionLimits;
  expected: JSONType;
}

function matchesFilters(name: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => name.includes(f));
}

const argv = process.argv.slice(2);
let dirPath = "bench";
let sawDir = false;
const filters: string[] = [];
let iters = 5;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--iters") {
    const v = argv[++i];
    if (v === undefined) {
      console.error("--iters requires a value");
      process.exit(1);
    }
    iters = Number.parseInt(v, 10);
    if (!Number.isFinite(iters) || iters <= 0) {
      console.error(`invalid --iters value "${v}"`);
      process.exit(1);
    }
  } else if (!sawDir) {
    dirPath = arg;
    sawDir = true;
  } else {
    filters.push(arg);
  }
}

const names = readdirSync(dirPath)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => matchesFilters(f, filters))
  .sort();

if (names.length === 0) {
  console.log("no bench files match the given filters");
  process.exit(1);
}

const stdlib = createStdlib();
let anyFail = false;

for (const name of names) {
  const bench: BenchCase = JSON.parse(readFileSync(join(dirPath, name), "utf-8"));
  const functions = { ...stdlib, ...bench.functions } as FunctionRegistry;
  const args = bench.args ?? [];
  const body = bench.body as Parameters<typeof callFunction>[0];

  // Warmup run that also verifies the result; a benchmark that computes
  // the wrong value measures nothing.
  let result: JSONType;
  try {
    result = callFunction(body, args, functions, bench.limits);
  } catch (err) {
    console.log(`${name}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    anyFail = true;
    continue;
  }
  if (!Bun.deepEquals(result, bench.expected, true)) {
    console.log(`${name}: WRONG RESULT (does not match "expected")`);
    anyFail = true;
    continue;
  }

  let minMs = Infinity;
  let totalMs = 0;
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    callFunction(body, args, functions, bench.limits);
    const elapsed = performance.now() - start;
    if (elapsed < minMs) minMs = elapsed;
    totalMs += elapsed;
  }

  const meanMs = totalMs / iters;
  console.log(
    `${name.padEnd(20)} min ${minMs.toFixed(2).padStart(8)} ms   ` +
      `mean ${meanMs.toFixed(2).padStart(8)} ms   (${iters} iters)`,
  );
}

if (anyFail) process.exit(1);
