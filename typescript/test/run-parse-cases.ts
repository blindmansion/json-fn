import { describe, test, expect } from "bun:test";
import { parseExpression, parseModule } from "../src/shorthand";
import {
  loadParseSuites,
  type ParseCase,
  type ParseMode,
  type ParseSuite,
  type StructuredParseError,
} from "./parse-case-fixtures";

function runCase(tc: ParseCase, suiteMode: ParseMode = "expression"): void {
  const parse = (tc.mode ?? suiteMode) === "module" ? parseModule : parseExpression;
  if (tc.error !== undefined) {
    if (typeof tc.error === "string") {
      expect(() => parse(tc.source)).toThrow(tc.error);
    } else if (tc.error === true) {
      expect(() => parse(tc.source)).toThrow();
    } else {
      expectStructuredError(() => parse(tc.source), tc.error);
    }
  } else {
    expect(parse(tc.source)).toEqual(tc.expected);
  }
}

function expectStructuredError(parse: () => unknown, expected: StructuredParseError): void {
  let threw = false;
  let error: unknown;
  try {
    parse();
  } catch (caught) {
    threw = true;
    error = caught;
  }

  expect(threw).toBe(true);
  if (expected.messageIncludes !== undefined) {
    expect(error instanceof Error ? error.message : undefined).toContain(expected.messageIncludes);
  }
  if (expected.at !== undefined) {
    expect(numericProperty(error, "line")).toBe(expected.at.line);
    expect(numericProperty(error, "col")).toBe(expected.at.column);
  }
}

function numericProperty(value: unknown, field: string): number | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "number" ? fieldValue : undefined;
}

function runSuite(suite: ParseSuite): void {
  describe(suite.description, () => {
    for (const tc of suite.cases) {
      test(tc.description, () => runCase(tc, suite.mode));
    }
  });
}

export function runAllParseCases(dir: string): void {
  for (const suite of loadParseSuites(dir)) runSuite(suite);
}
