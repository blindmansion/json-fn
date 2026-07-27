import { describe, test, expect } from "bun:test";
import { parseExpression, parseModule } from "../src/shorthand";
import type { JSONType } from "../src/types";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

interface ParseCase {
  description: string;
  source: string;
  mode?: "expression" | "module";
  expected?: JSONType;
  // Present when parsing must fail. A string asserts the thrown message
  // contains it; any other truthy value only requires that parsing failed.
  error?: JSONType;
}

interface ParseSuite {
  description: string;
  mode?: "expression" | "module";
  cases: ParseCase[];
}

function runCase(tc: ParseCase, suiteMode: "expression" | "module" = "expression"): void {
  const parse = (tc.mode ?? suiteMode) === "module" ? parseModule : parseExpression;
  if (tc.error !== undefined) {
    if (typeof tc.error === "string") {
      expect(() => parse(tc.source)).toThrow(tc.error);
    } else {
      expect(() => parse(tc.source)).toThrow();
    }
  } else {
    expect(parse(tc.source)).toEqual(tc.expected ?? null);
  }
}

export function runSuite(suite: ParseSuite): void {
  describe(suite.description, () => {
    for (const tc of suite.cases) {
      test(tc.description, () => runCase(tc, suite.mode));
    }
  });
}

export function runAllParseCases(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const suite: ParseSuite = JSON.parse(content);
    runSuite(suite);
  }
}
