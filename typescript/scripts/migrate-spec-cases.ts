// Migrate the eval conformance suites (spec/cases/*.json) to the new
// property-access canon. Rewrites `body`/`functions`/`expected` on every case
// via the shared `toNewCanon` utility, and drops cases that only exist to test
// now-removed behavior (legacy path-string parse errors, the param-name dot/
// bracket restriction, and the `$var` path guard).
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyVarAccess, toNewCanon } from "./canon-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../spec/cases");
const WRITE = process.argv.includes("--write");

type Case = { description: string; body: JSONType; error?: JSONType } & Record<string, JSONType>;
type Suite = { description: string; cases: Case[] } & Record<string, JSONType>;

// A case is obsolete when it asserts an error that only the removed forms could
// produce: a legacy `$var` path/combo in the body (bad-path parse errors and
// the path guard), or the deleted param-name restriction.
function isObsolete(tc: Case): boolean {
  if (tc.error === undefined) return false;
  if (hasLegacyVarAccess(tc.body)) return true;
  return /must not contain/.test(String(tc.error));
}

let totalDropped = 0;
let totalTransformed = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(DIR, file);
  const suite = JSON.parse(readFileSync(path, "utf-8")) as Suite;

  const dropped: string[] = [];
  const kept: Case[] = [];
  for (const tc of suite.cases) {
    if (isObsolete(tc)) {
      dropped.push(tc.description);
      continue;
    }
    tc.body = toNewCanon(tc.body);
    if (tc.functions !== undefined) tc.functions = toNewCanon(tc.functions);
    if ("expected" in tc) tc.expected = toNewCanon(tc.expected!);
    kept.push(tc);
  }
  suite.cases = kept;

  totalDropped += dropped.length;
  totalTransformed += kept.length;

  if (dropped.length > 0) {
    console.log(`${file}: dropped ${dropped.length}`);
    for (const d of dropped) console.log(`    - ${d}`);
  }

  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style,
  // so files whose content didn't change end up byte-identical (no diff churn).
  if (WRITE) writeFileSync(path, JSON.stringify(suite));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would keep"} ${totalTransformed} cases, dropped ${totalDropped}.` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
