# Performance suites

Standalone perf scripts for the TypeScript interpreter. These are **not** bun
tests (no `.test.ts` files) and never run as part of the regular suite; run
them explicitly from `typescript/`:

```bash
bun run perf/run.ts                    # all suites, full sizes (~1–2 min)
bun run perf/run.ts --quick            # smaller sizes, fast smoke run
bun run perf/run.ts --suite closures   # one suite (comma-separate for more)
bun run perf/run.ts --list             # list suite names
```

Every run writes `perf/results/latest.json` (override with `--out`). The
workflow for tracking improvements:

```bash
# 1. Record a baseline (writes perf/baselines/baseline.json)
bun run perf/run.ts --save-baseline

# 2. ...make interpreter changes...

# 3. Re-run and compare
bun run perf/run.ts --baseline perf/baselines/baseline.json
# or compare any two results files:
bun run perf/compare.ts perf/baselines/baseline.json perf/results/latest.json
```

The comparison flags medians ≥1.25x as regressions (▲) and ≤0.8x as
improvements (▼). `compare.ts` exits non-zero when regressions are present.

## What is measured

Benchmarks are grouped into four suites, one file each under `suites/`:

- **`raw-internal`** — large objects and raw marking inside the interpreter:
  unmarked vs `$raw` literals in program bodies, big values threaded through
  call chains and `reduce`, indexed reads, and `setAt` copy costs. Most
  benchmarks scale data size while holding guest work fixed, so a flat series
  means by-reference handling and a linear slope means re-walking/copying.
- **`boundary`** — large values crossing the host boundary: argument passing
  into `callFunction`, closure capture of unmarked vs raw arguments, pure vs
  impure external functions (impure ones are `structuredClone`d both ways),
  and the effects kernel via `runTask`: fixed trampoline overhead, per-hop
  cost, and loose vs strict runtime contracts over big payloads.
- **`closures`** — capture/escape costs: body size, captured-binding count,
  big captured values (creation should be O(1); invocation is where unmarked
  captures hurt), one-closure-per-element, curried application (expected
  O(depth²) today — anything worse is a bug), and transitive local-function
  attachment.
- **`recursion`** — deep guest recursion (self, mutual, accumulator, tree),
  recursion carrying a big payload, and deep expression nesting. Depths that
  exceed limits or overflow the JS stack are recorded as `error` in the
  results JSON; the set of depths that succeed is part of the baseline.

Some benchmarks include a `native` timing — the same logic hand-written in
JS — as a floor for interpretation overhead.

## Result format

`results/*.json` and `baselines/*.json` share one shape (`ResultsFile` in
`harness.ts`): run metadata (bun version, git commit, mode) plus one entry per
benchmark with median/mean/p95/min µs-per-op, optional native stats, and — for
one untimed instrumented run — interpreter counters (`evaluateExpression`,
`replaceVars`, `rawSkips`, `structuredClones`, `maxCallDepth`, `fuel`). The
counters make timing changes attributable: e.g. a regression with a jump in
`replaceVars` points at closure capture, not GC noise.

Timings are median-of-samples with warmup and batching for sub-millisecond
workloads; treat small deltas (<10–15%) as noise, and trust direction and
scaling shape (flat vs linear vs quadratic across a size series) over absolute
numbers.
