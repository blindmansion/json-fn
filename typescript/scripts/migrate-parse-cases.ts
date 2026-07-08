// Migrate the parse conformance suites (spec/parse-cases/*.json) to the new
// property-access canon. The shorthand `source` is unchanged (its lowering
// changed, not its syntax), so only each case's `expected` canonical JSON is
// rewritten via the shared `toNewCanon` utility.
//
// As a faithfulness check, each rewritten `expected` is compared against what
// the current parser actually produces for `source`; mismatches are reported.
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "../src/shorthand";
import { toNewCanon } from "./canon-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../spec/parse-cases");
const WRITE = process.argv.includes("--write");

type Case = { description: string; source: string; expected?: JSONType; error?: JSONType };
type Suite = { description: string; cases: Case[] } & Record<string, JSONType>;

let mismatches = 0;
let transformed = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(DIR, file);
  const suite = JSON.parse(readFileSync(path, "utf-8")) as Suite;

  for (const tc of suite.cases) {
    if (tc.error !== undefined || !("expected" in tc)) continue;
    tc.expected = toNewCanon(tc.expected!);
    transformed++;

    // Cross-check: the migrated golden should match the live parser output.
    const actual = parse(tc.source);
    if (JSON.stringify(actual) !== JSON.stringify(tc.expected)) {
      mismatches++;
      console.log(`MISMATCH ${file} :: ${tc.description}`);
      console.log(`    source:      ${tc.source}`);
      console.log(`    transformed: ${JSON.stringify(tc.expected)}`);
      console.log(`    parser:      ${JSON.stringify(actual)}`);
    }
  }

  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style,
  // so files whose content didn't change end up byte-identical (no diff churn).
  if (WRITE) writeFileSync(path, JSON.stringify(suite));
}

console.log(
  `\n${WRITE ? "Wrote" : "Checked"} ${transformed} expected values, ${mismatches} mismatch(es).` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
