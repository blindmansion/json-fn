// Shared checker conformance runner for the suites under a spec's `cases/check/`,
// documented by its `docs/conformance/checking.md`. Each case runs through
// the public `checkExpr`/`checkModule` entry points only — no checker
// internals. Inferred types are compared by exact canonical JSON equality and
// diagnostics as an unordered multiset: every expected matcher must consume
// exactly one actual diagnostic and every actual diagnostic must be consumed,
// so missing, duplicate, and additional diagnostics all fail.

import { describe, expect, test } from "bun:test";
import type { JSONType } from "../src/types";
import {
  checkExpr,
  checkModule,
  loadBuiltinTable,
  validateEnvironmentContract,
  type CallableTable,
  type CheckOptions,
} from "../src";
import {
  loadCheckSuites,
  type CheckCase,
  type CheckSuite,
  type DiagnosticMatcher,
} from "./check-case-fixtures";

export interface CheckRunnerOptions {
  standardBuiltinsPath?: string;
}

// The portable diagnostic shape, derived from the public entry point so the
// runner cannot drift from the checker's observable surface.
type Diagnostic = ReturnType<typeof checkExpr>["diagnostics"][number];

export function runAllCheckCases(dir: string, options: CheckRunnerOptions = {}): void {
  for (const suite of loadCheckSuites(dir, options)) runSuite(suite, options);
}

function runSuite(suite: CheckSuite, options: CheckRunnerOptions): void {
  describe(suite.description, () => {
    for (const tc of suite.cases) {
      test(tc.description, () => runCheckCase(tc, suite, options));
    }
  });
}

export function runCheckCase(
  tc: CheckCase,
  suite: CheckSuite,
  runnerOptions: CheckRunnerOptions = {},
): void {
  const selection = tc.builtins ?? suite.builtins;
  const builtins =
    selection === "standard" ? loadBuiltinTable(runnerOptions.standardBuiltinsPath) : undefined;
  const options: CheckOptions = { ...suite.options, ...tc.options };
  if (tc.module !== undefined && tc.contract !== undefined) {
    // Re-assert the loader's deep validation to type the contract, then pass
    // it through the ordinary checker/linker entry point.
    const contract: unknown = tc.contract;
    validateEnvironmentContract(contract, builtins ?? false);
    options.contract = contract;
  }

  if (tc.throws !== undefined) {
    expect(() => check(tc, builtins, options)).toThrow(tc.throws.messageIncludes);
    return;
  }

  const { type, diagnostics } = check(tc, builtins, options);
  if (tc.expected.type !== undefined) {
    expect(canonical(type)).toStrictEqual(canonical(tc.expected.type));
  }
  const mismatch = diagnosticMismatch(diagnostics, tc.expected.diagnostics);
  if (mismatch !== undefined) throw new Error(mismatch);
}

function check(
  tc: CheckCase,
  builtins: CallableTable | undefined,
  options: CheckOptions,
): { type?: JSONType; diagnostics: Diagnostic[] } {
  if (tc.module !== undefined) {
    return { diagnostics: checkModule(tc.module, builtins, options) };
  }
  return checkExpr(tc.expression, tc.defs ?? {}, builtins, options);
}

// Compare the actual diagnostics against the expected matchers as an
// unordered multiset. Returns a failure description, or undefined when a
// perfect one-to-one correspondence exists. Uses maximum bipartite matching
// (augmenting paths) so overlapping matchers cannot fail from an unlucky
// greedy assignment.
export function diagnosticMismatch(
  actualDiagnostics: Diagnostic[],
  matchers: DiagnosticMatcher[],
): string | undefined {
  const actual = actualDiagnostics.map((d) => canonical(d) as Diagnostic);
  if (actual.length !== matchers.length) {
    return (
      `expected ${matchers.length} diagnostic(s) but the checker produced ${actual.length}:` +
      `\n${describeAll(actual)}`
    );
  }

  // matcherFor[j] = index of the matcher consuming actual diagnostic j.
  const matcherFor: number[] = Array.from({ length: actual.length }, () => -1);
  const unmatched: number[] = [];
  for (let i = 0; i < matchers.length; i++) {
    if (!assign(i, matchers, actual, matcherFor, new Set())) unmatched.push(i);
  }
  if (unmatched.length === 0) return undefined;

  const unconsumed = actual.filter((_, j) => matcherFor[j] === -1);
  return (
    "diagnostics do not match the expected multiset." +
    `\nunmatched expected matcher(s):\n${describeAll(unmatched.map((i) => matchers[i]!))}` +
    `\nunconsumed actual diagnostic(s):\n${describeAll(unconsumed)}` +
    `\nall actual diagnostics:\n${describeAll(actual)}`
  );
}

// Try to give matcher `i` an actual diagnostic, displacing earlier
// assignments along an augmenting path when necessary.
function assign(
  i: number,
  matchers: DiagnosticMatcher[],
  actual: Diagnostic[],
  matcherFor: number[],
  visited: Set<number>,
): boolean {
  for (let j = 0; j < actual.length; j++) {
    if (visited.has(j) || !matcherAccepts(matchers[i]!, actual[j]!)) continue;
    visited.add(j);
    if (matcherFor[j] === -1 || assign(matcherFor[j]!, matchers, actual, matcherFor, visited)) {
      matcherFor[j] = i;
      return true;
    }
  }
  return false;
}

function matcherAccepts(matcher: DiagnosticMatcher, diagnostic: Diagnostic): boolean {
  if (diagnostic.severity !== matcher.severity) return false;
  if (!diagnostic.message.includes(matcher.messageIncludes)) return false;
  if (!Bun.deepEquals(diagnostic.path, matcher.path, true)) return false;
  if (
    matcher.expected !== undefined &&
    !Bun.deepEquals(diagnostic.expected, matcher.expected, true)
  )
    return false;
  if (matcher.actual !== undefined && !Bun.deepEquals(diagnostic.actual, matcher.actual, true))
    return false;
  return true;
}

// Exact canonical JSON equality: a JSON round trip drops undefined-valued
// members so host-representation artifacts cannot affect the comparison.
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function describeAll(items: unknown[]): string {
  if (items.length === 0) return "  (none)";
  return items.map((item) => `  ${JSON.stringify(item)}`).join("\n");
}
