// Migrate the canonical-JSON example programs (examples/*.json) from the legacy
// array-valued `$fn` call form to the split `$call`/`$args` form via the shared
// `toSplitForm` utility.
//
// Each migrated program is validated: no legacy array-`$fn` remains, the
// transform is idempotent, and — crucially — every node that ISN'T a legacy
// call is byte-identical before and after, proving only the intended forms were
// touched.
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyFnCall, isLegacyFnCall, toSplitForm } from "./fn-split-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../examples");
const WRITE = process.argv.includes("--write");

function isPlainObject(v: JSONType): v is { [k: string]: JSONType } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Assert that every node NOT part of a legacy call is preserved exactly. Legacy
// call nodes (and their subtrees) are skipped — those are meant to change.
function collectUnexpectedChanges(before: JSONType, after: JSONType, path: string, out: string[]) {
  if (isLegacyFnCall(before)) return;
  if (isPlainObject(before) && "$raw" in before) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push(path);
    return;
  }
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length !== after.length) return void out.push(path);
    before.forEach((v, i) => collectUnexpectedChanges(v, after[i]!, `${path}[${i}]`, out));
    return;
  }
  if (isPlainObject(before)) {
    if (
      !isPlainObject(after) ||
      JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))
    ) {
      return void out.push(`${path} (keys)`);
    }
    for (const k of Object.keys(before)) {
      collectUnexpectedChanges(before[k]!, after[k]!, `${path}.${k}`, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(path);
}

let touched = 0;
let failures = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const path = join(DIR, file);
  const before = JSON.parse(readFileSync(path, "utf-8")) as JSONType;
  if (!hasLegacyFnCall(before)) {
    console.log(`${file}: no legacy forms`);
    continue;
  }

  const after = toSplitForm(before);
  touched++;

  const problems: string[] = [];
  if (hasLegacyFnCall(after)) problems.push("legacy forms still present after transform");
  if (JSON.stringify(toSplitForm(after)) !== JSON.stringify(after)) {
    problems.push("transform is not idempotent");
  }
  const changes: string[] = [];
  collectUnexpectedChanges(before, after, "", changes);
  if (changes.length > 0) {
    problems.push(`non-call nodes changed: ${changes.slice(0, 5).join(", ")}`);
  }

  if (problems.length > 0) {
    failures++;
    console.log(`${file}: FAILED validation`);
    for (const p of problems) console.log(`    - ${p}`);
    continue;
  }

  console.log(`${file}: migrated (only call nodes changed)`);
  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style.
  if (WRITE) writeFileSync(path, JSON.stringify(after));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would migrate"} ${touched} file(s), ${failures} validation failure(s).` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
