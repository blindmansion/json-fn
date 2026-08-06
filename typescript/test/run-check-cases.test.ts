// Unit tests for the checker conformance runner's matching semantics: exact
// inferred-type equality and exact unordered multiset diagnostic matching.
// These guard the exit criteria that additional, missing, and duplicate
// diagnostics all cause failures.

import { describe, expect, test } from "bun:test";
import { diagnosticMismatch, runCheckCase } from "./run-check-cases";
import type { CheckCase, CheckSuite, DiagnosticMatcher } from "./check-case-fixtures";

type Diagnostic = Parameters<typeof diagnosticMismatch>[0][number];

const mismatchError: Diagnostic = {
  path: ["main", "$return"],
  message: '{"const":"wrong"} is not assignable to {"type":"integer"}.',
  severity: "error",
  expected: { type: "integer" },
  actual: { const: "wrong" },
};

const degradation: Diagnostic = {
  path: [],
  message: 'expression degraded to `any` because variable "missing" is unresolved.',
  severity: "info",
};

const mismatchMatcher: DiagnosticMatcher = {
  path: ["main", "$return"],
  severity: "error",
  messageIncludes: "not assignable",
};

const degradationMatcher: DiagnosticMatcher = {
  path: [],
  severity: "info",
  messageIncludes: "degraded to `any`",
};

describe("diagnostic multiset matching", () => {
  test("matches independently of diagnostic order", () => {
    expect(
      diagnosticMismatch([mismatchError, degradation], [degradationMatcher, mismatchMatcher]),
    ).toBeUndefined();
    expect(
      diagnosticMismatch([degradation, mismatchError], [degradationMatcher, mismatchMatcher]),
    ).toBeUndefined();
  });

  test("an empty expectation requires no diagnostics", () => {
    expect(diagnosticMismatch([], [])).toBeUndefined();
    expect(diagnosticMismatch([degradation], [])).toContain("expected 0 diagnostic(s)");
  });

  test("a missing diagnostic fails", () => {
    expect(diagnosticMismatch([], [mismatchMatcher])).toContain("expected 1 diagnostic(s)");
  });

  test("an additional diagnostic fails", () => {
    expect(diagnosticMismatch([mismatchError, degradation], [mismatchMatcher])).toContain(
      "expected 1 diagnostic(s)",
    );
  });

  test("a duplicate actual diagnostic is not absorbed by one matcher", () => {
    expect(diagnosticMismatch([mismatchError, mismatchError], [mismatchMatcher])).toContain(
      "expected 1 diagnostic(s)",
    );
  });

  test("duplicate matchers each consume one duplicate diagnostic", () => {
    expect(
      diagnosticMismatch([mismatchError, mismatchError], [mismatchMatcher, mismatchMatcher]),
    ).toBeUndefined();
  });

  test("a duplicate matcher cannot consume the same diagnostic twice", () => {
    expect(
      diagnosticMismatch([mismatchError, degradation], [mismatchMatcher, mismatchMatcher]),
    ).toContain("do not match the expected multiset");
  });

  test("overlapping matchers use maximum matching, not greedy assignment", () => {
    // The loose matcher accepts both diagnostics; the strict one accepts only
    // the first. A greedy pass giving the loose matcher the first diagnostic
    // would strand the strict matcher.
    const first: Diagnostic = { path: ["f"], severity: "error", message: "not assignable: A" };
    const second: Diagnostic = { path: ["f"], severity: "error", message: "not assignable: B" };
    const loose: DiagnosticMatcher = {
      path: ["f"],
      severity: "error",
      messageIncludes: "not assignable",
    };
    const strict: DiagnosticMatcher = { path: ["f"], severity: "error", messageIncludes: ": A" };
    expect(diagnosticMismatch([first, second], [loose, strict])).toBeUndefined();
    expect(diagnosticMismatch([second, first], [loose, strict])).toBeUndefined();
  });

  test("path and severity are exact", () => {
    expect(diagnosticMismatch([mismatchError], [{ ...mismatchMatcher, path: ["main"] }])).toContain(
      "do not match the expected multiset",
    );
    expect(
      diagnosticMismatch([mismatchError], [{ ...mismatchMatcher, severity: "info" }]),
    ).toContain("do not match the expected multiset");
  });

  test("messageIncludes is a substring assertion", () => {
    expect(
      diagnosticMismatch([mismatchError], [{ ...mismatchMatcher, messageIncludes: "nope" }]),
    ).toContain("do not match the expected multiset");
  });

  test("present schema fields are exact assertions", () => {
    expect(
      diagnosticMismatch(
        [mismatchError],
        [{ ...mismatchMatcher, expected: { type: "integer" }, actual: { const: "wrong" } }],
      ),
    ).toBeUndefined();
    expect(
      diagnosticMismatch([mismatchError], [{ ...mismatchMatcher, expected: { type: "string" } }]),
    ).toContain("do not match the expected multiset");
    expect(
      diagnosticMismatch([degradation], [{ ...degradationMatcher, expected: { type: "string" } }]),
    ).toContain("do not match the expected multiset");
  });
});

describe("runCheckCase", () => {
  const suite: CheckSuite = {
    $schema: "../check.schema.json",
    description: "unit-test suite",
    builtins: "none",
    cases: [],
  };

  test("passes a clean expression case with an exact inferred type", () => {
    runCheckCase(
      { description: "ok", expression: 1, expected: { type: { const: 1 }, diagnostics: [] } },
      suite,
    );
  });

  test("fails when the inferred type differs", () => {
    expect(() =>
      runCheckCase(
        {
          description: "bad type",
          expression: 1,
          expected: { type: { type: "integer" }, diagnostics: [] },
        },
        suite,
      ),
    ).toThrow();
  });

  test("fails when the checker emits an unasserted diagnostic", () => {
    expect(() =>
      runCheckCase(
        {
          description: "unasserted",
          expression: { $var: "missing" },
          expected: { diagnostics: [] },
        },
        suite,
      ),
    ).toThrow("expected 0 diagnostic(s)");
  });

  test("fails when an expected diagnostic is missing", () => {
    expect(() =>
      runCheckCase(
        {
          description: "missing diagnostic",
          expression: 1,
          expected: { diagnostics: [{ ...degradationMatcher }] },
        },
        suite,
      ),
    ).toThrow("expected 1 diagnostic(s)");
  });

  test("module cases run through checkModule", () => {
    runCheckCase(
      {
        description: "module",
        module: {
          main: {
            $params: [],
            $sig: { required: [], optional: [], returns: { type: "integer" } },
            $return: 1,
          },
        },
        expected: { diagnostics: [] },
      },
      suite,
    );
  });

  test("throws cases assert the error message substring", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 513; i++) deep = [deep];
    runCheckCase(
      {
        description: "depth",
        expression: deep as CheckCase["expression"],
        throws: { messageIncludes: "Maximum structural depth" },
      } as CheckCase,
      suite,
    );
    expect(() =>
      runCheckCase(
        {
          description: "no throw",
          expression: 1,
          throws: { messageIncludes: "Maximum structural depth" },
        } as CheckCase,
        suite,
      ),
    ).toThrow();
  });
});
