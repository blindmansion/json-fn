// show-parse-cases.ts — Pretty-print shorthand parser test-case fixtures.
//
// The fixtures in spec/parse-cases/*.json are painful to read because the
// `source` field is a JSON string with escaped newlines and quotes. This
// script prints each case with its source rendered as real multi-line text
// alongside the expected canonical JSON (or the expected error).
//
// Usage:
//   bun run scripts/show-parse-cases.ts                 # all suites
//   bun run scripts/show-parse-cases.ts operators       # one suite by stem
//   bun run scripts/show-parse-cases.ts control-flow.json
//   bun run scripts/show-parse-cases.ts /abs/path/to/suite.json

import { readdirSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

const CASES_DIR = join(import.meta.dir, "../../spec/parse-cases");

interface ParseCase {
  description: string;
  source: string;
  expected?: unknown;
  error?: unknown;
}

interface ParseSuite {
  description: string;
  cases: ParseCase[];
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function resolveFiles(arg: string | undefined): string[] {
  if (arg === undefined) {
    return readdirSync(CASES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(CASES_DIR, f));
  }
  if (isAbsolute(arg)) return [arg];
  const name = arg.endsWith(".json") ? arg : `${arg}.json`;
  return [join(CASES_DIR, name)];
}

function printSuite(path: string): void {
  const suite: ParseSuite = JSON.parse(readFileSync(path, "utf-8"));
  console.log(bold(cyan(`\n═══ ${suite.description} ═══`)));

  for (const tc of suite.cases) {
    console.log(bold(`\n• ${tc.description}`));
    console.log(dim("  source:"));
    console.log(indent(tc.source));

    if (tc.error !== undefined) {
      const detail =
        typeof tc.error === "string" ? `containing ${JSON.stringify(tc.error)}` : "(any)";
      console.log(dim("  expected:"));
      console.log(indent(red(`✗ parse error ${detail}`)));
    } else {
      console.log(dim("  expected:"));
      console.log(indent(green(JSON.stringify(tc.expected ?? null, null, 2))));
    }
  }
}

const files = resolveFiles(process.argv[2]);
for (const file of files) printSuite(file);
