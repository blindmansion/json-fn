import { describe, test, expect } from "bun:test";
import { callFunction, createStdlib } from "../src";
import type { JSONType, FunctionRegistry } from "../src";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

type FunctionBody = { [key: string]: JSONType; $return: JSONType };

interface TestCase {
  description: string;
  body: JSONType;
  args?: JSONType[];
  functions?: Record<string, FunctionBody>;
  expected?: JSONType;
  error?: string;
}

interface TestSuite {
  description: string;
  functions?: Record<string, FunctionBody>;
  cases: TestCase[];
}

function runCase(tc: TestCase, suiteFunctions: Record<string, FunctionBody> = {}): void {
  const functions: FunctionRegistry = {
    ...createStdlib(),
    ...suiteFunctions,
    ...tc.functions,
  };
  const args = tc.args ?? [];

  if (tc.error !== undefined) {
    expect(() => callFunction(tc.body as any, args, functions)).toThrow(tc.error);
  } else {
    const result = callFunction(tc.body as any, args, functions);
    expect(result).toEqual(tc.expected!);
  }
}

export function runSuite(suite: TestSuite): void {
  describe(suite.description, () => {
    for (const tc of suite.cases) {
      test(tc.description, () => runCase(tc, suite.functions));
    }
  });
}

export function runAllCases(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const suite: TestSuite = JSON.parse(content);
    runSuite(suite);
  }
}
