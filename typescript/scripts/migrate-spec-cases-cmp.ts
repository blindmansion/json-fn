// Migrate the eval conformance suites (spec/cases/*.json) from the first-class
// comparator nodes ($eq/$neq/$lt/$lte/$gt/$gte) and the unary $not node to
// stdlib function calls, via the shared `toCallForm` utility. Rewrites
// `body`/`functions`/`args`/`expected` on every case.
//
// Cases that only assert an error the removed nodes could produce — wrong arity
// ("… must be an array of two expressions") or sibling properties ("$eq/…/$not
// expressions cannot have other properties") — are dropped, since those nodes
// no longer exist (an $eq-shaped object is now just plain data).
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyComparison, toCallForm } from "./comparison-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../spec/cases");
const WRITE = process.argv.includes("--write");

type Case = { description: string; body: JSONType; error?: JSONType } & Record<string, JSONType>;
type Suite = { description: string; cases: Case[] } & Record<string, JSONType>;

// The node-specific validation messages that only the removed comparator/$not
// nodes could produce. A case asserting one of these tests behavior that no
// longer exists, so it is dropped rather than rewritten.
const OBSOLETE_ERROR =
  /\$(eq|neq|lt|lte|gt|gte|not) expressions cannot have other properties|\$(eq|neq|lt|lte|gt|gte) must be an array of two expressions/;

function isObsolete(tc: Case): boolean {
  return tc.error !== undefined && OBSOLETE_ERROR.test(String(tc.error));
}

let totalDropped = 0;
let totalTransformed = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(DIR, file);
  const suite = JSON.parse(readFileSync(path, "utf-8")) as Suite;

  // Suite-level `functions` are shared across every case (see run-cases.ts) and
  // must be rewritten too, not just the per-case `functions`.
  let fileTransformed = 0;
  if (suite.functions !== undefined) {
    if (hasLegacyComparison(suite.functions)) fileTransformed++;
    suite.functions = toCallForm(suite.functions);
  }

  const dropped: string[] = [];
  const kept: Case[] = [];
  for (const tc of suite.cases) {
    if (isObsolete(tc)) {
      dropped.push(tc.description);
      continue;
    }
    // `args` can carry function *values* (closures) whose bodies are evaluated
    // when the closure is later invoked, so their nodes must be rewritten too.
    const had =
      hasLegacyComparison(tc.body) ||
      (tc.functions !== undefined && hasLegacyComparison(tc.functions)) ||
      (tc.args !== undefined && hasLegacyComparison(tc.args)) ||
      ("expected" in tc && hasLegacyComparison(tc.expected!));
    tc.body = toCallForm(tc.body);
    if (tc.functions !== undefined) tc.functions = toCallForm(tc.functions);
    if (tc.args !== undefined) tc.args = toCallForm(tc.args);
    if ("expected" in tc) tc.expected = toCallForm(tc.expected!);
    if (had) fileTransformed++;
    kept.push(tc);
  }
  suite.cases = kept;

  totalDropped += dropped.length;
  totalTransformed += fileTransformed;

  if (fileTransformed > 0 || dropped.length > 0) {
    console.log(`${file}: migrated ${fileTransformed} case(s), dropped ${dropped.length}`);
    for (const d of dropped) console.log(`    - ${d}`);
  }

  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style,
  // so files whose content didn't change end up byte-identical (no diff churn).
  if (WRITE) writeFileSync(path, JSON.stringify(suite));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would migrate"} ${totalTransformed} case(s), dropped ${totalDropped}.` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
