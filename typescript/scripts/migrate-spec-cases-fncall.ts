// Migrate the eval conformance suites (spec/cases/*.json) from the legacy
// array-valued `$fn` call form to the split `$call`/`$args` form. Rewrites
// `body`/`functions`/`expected` on every case via the shared `toSplitForm`
// utility.
//
// Unlike the property-access migration, this split removes NO behavior, so no
// cases are dropped — it is a pure shape rewrite.
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyFnCall, toSplitForm } from "./fn-split-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../spec/cases");
const WRITE = process.argv.includes("--write");

type Case = { description: string; body: JSONType; error?: JSONType } & Record<string, JSONType>;
type Suite = { description: string; cases: Case[] } & Record<string, JSONType>;

let totalTransformed = 0;
let totalCases = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(DIR, file);
  const suite = JSON.parse(readFileSync(path, "utf-8")) as Suite;

  let fileTransformed = 0;
  // Suite-level `functions` are shared across every case (see run-cases.ts) and
  // must be rewritten too, not just the per-case `functions`.
  if (suite.functions !== undefined) {
    if (hasLegacyFnCall(suite.functions)) fileTransformed++;
    suite.functions = toSplitForm(suite.functions);
  }
  for (const tc of suite.cases) {
    totalCases++;
    // `args` can carry function *values* (closures) whose bodies are evaluated
    // when the closure is later invoked, so their call nodes must be split too.
    const had =
      hasLegacyFnCall(tc.body) ||
      (tc.functions !== undefined && hasLegacyFnCall(tc.functions)) ||
      (tc.args !== undefined && hasLegacyFnCall(tc.args)) ||
      ("expected" in tc && hasLegacyFnCall(tc.expected!));
    tc.body = toSplitForm(tc.body);
    if (tc.functions !== undefined) tc.functions = toSplitForm(tc.functions);
    if (tc.args !== undefined) tc.args = toSplitForm(tc.args);
    if ("expected" in tc) tc.expected = toSplitForm(tc.expected!);
    if (had) fileTransformed++;
  }

  totalTransformed += fileTransformed;
  if (fileTransformed > 0) console.log(`${file}: migrated ${fileTransformed} case(s)`);

  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style,
  // so files whose content didn't change end up byte-identical (no diff churn).
  if (WRITE) writeFileSync(path, JSON.stringify(suite));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would migrate"} ${totalTransformed} case(s) across ${totalCases} total.` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
