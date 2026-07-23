/**
 * Compare two perf results files (e.g. a saved baseline vs a fresh run).
 *
 *   bun run perf/compare.ts perf/baselines/baseline.json perf/results/latest.json
 *
 * Also used by run.ts when invoked with --baseline.
 */

import { formatUs } from "./harness";
import type { BenchResult, ResultsFile } from "./harness";

export type ComparisonRow = {
  id: string;
  baselineUs: number | null;
  currentUs: number | null;
  ratio: number | null;
  note: string | null;
};

const REGRESSION_RATIO = 1.25;
const IMPROVEMENT_RATIO = 0.8;

export function compareResults(baseline: ResultsFile, current: ResultsFile): ComparisonRow[] {
  const baselineById = new Map<string, BenchResult>(baseline.results.map((r) => [r.id, r]));
  const rows: ComparisonRow[] = [];

  for (const result of current.results) {
    const before = baselineById.get(result.id);
    baselineById.delete(result.id);
    const currentUs = result.stats?.medianUs ?? null;
    const baselineUs = before?.stats?.medianUs ?? null;
    let note: string | null = null;
    if (before === undefined) note = "new benchmark (not in baseline)";
    else if (before.error !== null && result.error !== null) note = "errors in both runs";
    else if (before.error !== null) note = `baseline errored: ${before.error}`;
    else if (result.error !== null) note = `now errors: ${result.error}`;
    rows.push({
      id: result.id,
      baselineUs,
      currentUs,
      ratio: baselineUs !== null && currentUs !== null ? currentUs / baselineUs : null,
      note,
    });
  }
  for (const [id, before] of baselineById) {
    rows.push({
      id,
      baselineUs: before.stats?.medianUs ?? null,
      currentUs: null,
      ratio: null,
      note: "missing from current run",
    });
  }
  return rows;
}

export function printComparison(rows: ComparisonRow[]): { regressions: number } {
  const sorted = [...rows].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  let regressions = 0;
  let improvements = 0;

  console.log("\n== comparison vs baseline (current / baseline, by median) ==");
  for (const row of sorted) {
    let marker = " ";
    if (row.ratio !== null && row.ratio >= REGRESSION_RATIO) {
      marker = "▲";
      regressions++;
    } else if (row.ratio !== null && row.ratio <= IMPROVEMENT_RATIO) {
      marker = "▼";
      improvements++;
    }
    const ratioText = row.ratio === null ? "  n/a" : `${row.ratio.toFixed(2)}x`;
    const baselineText = row.baselineUs === null ? "n/a" : formatUs(row.baselineUs);
    const currentText = row.currentUs === null ? "n/a" : formatUs(row.currentUs);
    const noteText = row.note === null ? "" : `  [${row.note}]`;
    console.log(
      `  ${marker} ${ratioText.padStart(7)}  ${baselineText.padStart(10)} → ${currentText.padStart(10)}  ${row.id}${noteText}`,
    );
  }
  console.log(
    `\n  ${regressions} regression(s) ≥ ${REGRESSION_RATIO}x, ${improvements} improvement(s) ≤ ${IMPROVEMENT_RATIO}x, ${rows.length} benchmarks compared`,
  );
  return { regressions };
}

async function loadResults(path: string): Promise<ResultsFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`results file not found: ${path}`);
  }
  return (await file.json()) as ResultsFile;
}

if (import.meta.main) {
  const [baselinePath, currentPath] = Bun.argv.slice(2);
  if (baselinePath === undefined || currentPath === undefined) {
    console.error("usage: bun run perf/compare.ts <baseline.json> <current.json>");
    process.exit(2);
  }
  const baseline = await loadResults(baselinePath);
  const current = await loadResults(currentPath);
  console.log(
    `baseline: ${baselinePath} (${baseline.meta.createdAt}, ${baseline.meta.gitCommit ?? "no commit"})`,
  );
  console.log(
    `current:  ${currentPath} (${current.meta.createdAt}, ${current.meta.gitCommit ?? "no commit"})`,
  );
  const { regressions } = printComparison(compareResults(baseline, current));
  process.exit(regressions > 0 ? 1 : 0);
}
