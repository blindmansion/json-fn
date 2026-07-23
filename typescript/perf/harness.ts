/**
 * Shared benchmarking harness for the perf scripts.
 *
 * These are plain scripts (not bun tests) so they never run as part of the
 * regular suite. Results are emitted as JSON so a run can be saved as a
 * baseline and later runs compared against it (see compare.ts / run.ts).
 */

import { createPerfStats } from "../src";
import type { ExecutionLimits } from "../src";

export type Params = Record<string, string | number | boolean>;

export type BenchStats = {
  samples: number;
  batch: number;
  meanUs: number;
  medianUs: number;
  p95Us: number;
  minUs: number;
  totalMs: number;
};

export type MeasureOptions = {
  /** Total sampling time budget per benchmark (ms). */
  targetMs: number;
  maxSamples: number;
  minSamples: number;
  warmupMs: number;
};

export type BenchDef = {
  name: string;
  params: Params;
  run: () => unknown;
  /** Optional native-JS implementation of the same logic, for a floor comparison. */
  native?: () => unknown;
  /** Optional single untimed instrumented run collecting interpreter counters. */
  metrics?: () => Record<string, number> | Promise<Record<string, number>>;
  measure?: Partial<MeasureOptions>;
};

export type Suite = { name: string; benches: BenchDef[] };

export type Mode = "full" | "quick";

export type BenchResult = {
  id: string;
  suite: string;
  name: string;
  params: Params;
  stats: BenchStats | null;
  error: string | null;
  native: BenchStats | null;
  nativeError: string | null;
  metrics: Record<string, number> | null;
};

export type ResultsFile = {
  version: 1;
  meta: {
    createdAt: string;
    mode: Mode;
    bunVersion: string;
    platform: string;
    arch: string;
    gitCommit: string | null;
  };
  results: BenchResult[];
};

export function benchId(suite: string, name: string, params: Params): string {
  const parts = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`);
  return parts.length === 0 ? `${suite}/${name}` : `${suite}/${name}?${parts.join("&")}`;
}

const nowMs = (): number => Bun.nanoseconds() / 1e6;

async function callBatch(fn: () => unknown, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const result = fn();
    if (result instanceof Promise) await result;
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export async function measure(fn: () => unknown, options: MeasureOptions): Promise<BenchStats> {
  // Warmup: at least one run, then keep going until the warmup budget expires.
  const warmupStart = nowMs();
  let warmupRuns = 0;
  do {
    await callBatch(fn, 1);
    warmupRuns++;
  } while (nowMs() - warmupStart < options.warmupMs && warmupRuns < 1000);

  // Calibrate a batch size so each timed sample lasts at least ~1ms; per-op
  // timer overhead would otherwise dominate for microsecond-scale workloads.
  const calibrationStart = nowMs();
  await callBatch(fn, 1);
  const singleMs = nowMs() - calibrationStart;
  const minBatchMs = 1;
  const batch =
    singleMs >= minBatchMs ? 1 : Math.min(10_000, Math.ceil(minBatchMs / Math.max(singleMs, 1e-6)));

  const perOpUs: number[] = [];
  const samplingStart = nowMs();
  for (;;) {
    const sampleStart = nowMs();
    await callBatch(fn, batch);
    const sampleMs = nowMs() - sampleStart;
    perOpUs.push((sampleMs / batch) * 1000);
    const elapsed = nowMs() - samplingStart;
    if (perOpUs.length >= options.maxSamples) break;
    if (elapsed >= options.targetMs && perOpUs.length >= options.minSamples) break;
    // Hard cap so a single slow benchmark (seconds per op) settles for fewer
    // samples instead of stalling the whole run on minSamples.
    if (elapsed >= options.targetMs * 10) break;
  }
  const totalMs = nowMs() - samplingStart;

  const sorted = [...perOpUs].sort((a, b) => a - b);
  const mean = perOpUs.reduce((acc, value) => acc + value, 0) / perOpUs.length;
  return {
    samples: perOpUs.length,
    batch,
    meanUs: mean,
    medianUs: quantile(sorted, 0.5),
    p95Us: quantile(sorted, 0.95),
    minUs: sorted[0]!,
    totalMs,
  };
}

export function formatUs(us: number): string {
  if (!Number.isFinite(us)) return "n/a";
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)}s`;
  if (us >= 1_000) return `${(us / 1_000).toFixed(2)}ms`;
  if (us >= 10) return `${us.toFixed(1)}µs`;
  return `${us.toFixed(2)}µs`;
}

export async function runSuite(
  suite: Suite,
  mode: Mode,
  measureDefaults: MeasureOptions,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  console.log(`\n== suite: ${suite.name} (${mode}) ==`);
  for (const bench of suite.benches) {
    const options = { ...measureDefaults, ...bench.measure };
    const result: BenchResult = {
      id: benchId(suite.name, bench.name, bench.params),
      suite: suite.name,
      name: bench.name,
      params: bench.params,
      stats: null,
      error: null,
      native: null,
      nativeError: null,
      metrics: null,
    };

    if (typeof Bun.gc === "function") Bun.gc(true);
    try {
      result.stats = await measure(bench.run, options);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    if (bench.native !== undefined) {
      if (typeof Bun.gc === "function") Bun.gc(true);
      try {
        result.native = await measure(bench.native, options);
      } catch (error) {
        result.nativeError = error instanceof Error ? error.message : String(error);
      }
    }

    if (bench.metrics !== undefined && result.error === null) {
      try {
        result.metrics = await bench.metrics();
      } catch (error) {
        result.metrics = null;
        if (result.error === null) {
          result.error = `metrics: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    logResult(result);
    results.push(result);
  }
  return results;
}

function logResult(result: BenchResult): void {
  const label = result.id.padEnd(72);
  if (result.error !== null && result.stats === null) {
    console.log(`  ${label} ERROR: ${result.error}`);
    return;
  }
  const median = result.stats ? formatUs(result.stats.medianUs).padStart(10) : "n/a".padStart(10);
  let nativePart = "";
  if (result.native !== null && result.stats !== null) {
    const ratio = result.stats.medianUs / result.native.medianUs;
    nativePart = `  native ${formatUs(result.native.medianUs).padStart(10)}  (${ratio.toFixed(1)}x)`;
  } else if (result.nativeError !== null) {
    nativePart = `  native ERROR: ${result.nativeError}`;
  }
  console.log(`  ${label} ${median}${nativePart}`);
}

/**
 * Wire a benchmark's `run` and `metrics` from a single factory that accepts
 * execution limits. The metrics run executes once, untimed, with perf counters
 * and fuel tracking enabled — counter values (replaceVars, rawSkips,
 * structuredClones, ...) are the diagnostic companion to the timings.
 */
export function withMetrics(
  makeRun: (limits: ExecutionLimits) => () => unknown,
): Pick<BenchDef, "run" | "metrics"> {
  return {
    run: makeRun({}),
    metrics: async () => {
      const perf = createPerfStats();
      const usage = { fuel: 0 };
      const result = makeRun({ perf, usage })();
      if (result instanceof Promise) await result;
      return {
        evaluateExpression: perf.evaluateExpression,
        callFunctionInternal: perf.callFunctionInternal,
        replaceVars: perf.replaceVars,
        rawSkips: perf.rawSkips,
        structuredClones: perf.structuredClones,
        maxCallDepth: perf.maxCallDepth,
        fuel: usage.fuel,
      };
    },
  };
}

export function gitCommit(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}
