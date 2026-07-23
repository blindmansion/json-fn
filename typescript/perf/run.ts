/**
 * Perf suite runner. From `typescript/`:
 *
 *   bun run perf/run.ts                        # all suites, full sizes
 *   bun run perf/run.ts --quick                # smaller sizes, faster sampling
 *   bun run perf/run.ts --suite closures       # one suite (comma-separate for more)
 *   bun run perf/run.ts --save-baseline        # also write perf/baselines/baseline.json
 *   bun run perf/run.ts --baseline perf/baselines/baseline.json   # compare after running
 *   bun run perf/run.ts --out my-results.json  # custom output path
 *
 * Results always go to a JSON file (default perf/results/latest.json) so any
 * run can serve as a baseline for later comparisons via perf/compare.ts.
 */

import { gitCommit, runSuite } from "./harness";
import type { BenchResult, MeasureOptions, Mode, ResultsFile, Suite } from "./harness";
import { compareResults, printComparison } from "./compare";
import { makeSuite as makeRawInternal } from "./suites/raw-internal";
import { makeSuite as makeBoundary } from "./suites/boundary";
import { makeSuite as makeClosures } from "./suites/closures";
import { makeSuite as makeEffects } from "./suites/effects";
import { makeSuite as makeRecursion } from "./suites/recursion";

const SUITE_FACTORIES: Record<string, (mode: Mode) => Suite> = {
  "raw-internal": makeRawInternal,
  boundary: makeBoundary,
  closures: makeClosures,
  effects: makeEffects,
  recursion: makeRecursion,
};

type CliOptions = {
  suites: string[];
  mode: Mode;
  out: string;
  baseline: string | null;
  saveBaseline: boolean;
};

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    suites: Object.keys(SUITE_FACTORIES),
    mode: "full",
    out: `${import.meta.dir}/results/latest.json`,
    baseline: null,
    saveBaseline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--suite": {
        const value = argv[++i];
        if (value === undefined) fail("--suite requires a value");
        options.suites = value.split(",").map((s) => s.trim());
        break;
      }
      case "--quick":
        options.mode = "quick";
        break;
      case "--out": {
        const value = argv[++i];
        if (value === undefined) fail("--out requires a value");
        options.out = value;
        break;
      }
      case "--baseline": {
        const value = argv[++i];
        if (value === undefined) fail("--baseline requires a value");
        options.baseline = value;
        break;
      }
      case "--save-baseline":
        options.saveBaseline = true;
        break;
      case "--list":
        console.log(Object.keys(SUITE_FACTORIES).join("\n"));
        process.exit(0);
        break;
      case "--help":
        console.log(
          "usage: bun run perf/run.ts [--suite a,b] [--quick] [--out path] [--baseline path] [--save-baseline] [--list]",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  for (const name of options.suites) {
    if (SUITE_FACTORIES[name] === undefined) {
      fail(`unknown suite "${name}" (available: ${Object.keys(SUITE_FACTORIES).join(", ")})`);
    }
  }
  return options;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const MEASURE_DEFAULTS: Record<Mode, MeasureOptions> = {
  full: { targetMs: 250, maxSamples: 120, minSamples: 5, warmupMs: 50 },
  quick: { targetMs: 60, maxSamples: 25, minSamples: 3, warmupMs: 15 },
};

const options = parseCli(Bun.argv.slice(2));
const startedAt = performance.now();
const results: BenchResult[] = [];

for (const name of options.suites) {
  const suite = SUITE_FACTORIES[name]!(options.mode);
  results.push(...(await runSuite(suite, options.mode, MEASURE_DEFAULTS[options.mode])));
}

const output: ResultsFile = {
  version: 1,
  meta: {
    createdAt: new Date().toISOString(),
    mode: options.mode,
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    gitCommit: gitCommit(),
  },
  results,
};

await Bun.write(options.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`\nwrote ${results.length} results to ${options.out}`);

if (options.saveBaseline) {
  const baselinePath = `${import.meta.dir}/baselines/baseline.json`;
  await Bun.write(baselinePath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`saved baseline to ${baselinePath}`);
}

const errored = results.filter((r) => r.error !== null);
if (errored.length > 0) {
  console.log(`\n${errored.length} benchmark(s) errored (expected for over-limit depths):`);
  for (const result of errored) console.log(`  ${result.id}: ${result.error}`);
}

if (options.baseline !== null) {
  const file = Bun.file(options.baseline);
  if (!(await file.exists())) {
    fail(`baseline file not found: ${options.baseline}`);
  }
  const baseline = (await file.json()) as ResultsFile;
  if (baseline.meta.mode !== options.mode) {
    console.warn(
      `warning: baseline mode "${baseline.meta.mode}" differs from current mode "${options.mode}"`,
    );
  }
  printComparison(compareResults(baseline, output));
}

console.log(`\ntotal time: ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
