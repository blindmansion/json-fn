// Migrate the canonical-JSON example programs (examples/*.json) from the
// first-class comparator nodes ($eq/$neq/$lt/$lte/$gt/$gte) and the unary $not
// node to stdlib function calls via the shared `toCallForm` utility.
//
// Each migrated program is validated: no legacy comparator/$not node remains,
// the transform is idempotent, and — crucially — every node that ISN'T a legacy
// comparator/$not is byte-identical before and after, proving only the intended
// forms were touched.
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyComparison, isLegacyComparison, toCallForm } from "./comparison-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../examples");
const WRITE = process.argv.includes("--write");

function isPlainObject(v: JSONType): v is { [k: string]: JSONType } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Assert that every node NOT part of a legacy comparator/$not is preserved
// exactly. Legacy nodes (and their subtrees) are skipped — those are meant to
// change.
function collectUnexpectedChanges(before: JSONType, after: JSONType, path: string, out: string[]) {
  if (isLegacyComparison(before)) return;
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
  if (!hasLegacyComparison(before)) {
    console.log(`${file}: no legacy forms`);
    continue;
  }

  const after = toCallForm(before);
  touched++;

  const problems: string[] = [];
  if (hasLegacyComparison(after)) problems.push("legacy forms still present after transform");
  if (JSON.stringify(toCallForm(after)) !== JSON.stringify(after)) {
    problems.push("transform is not idempotent");
  }
  const changes: string[] = [];
  collectUnexpectedChanges(before, after, "", changes);
  if (changes.length > 0) {
    problems.push(`non-comparator nodes changed: ${changes.slice(0, 5).join(", ")}`);
  }

  if (problems.length > 0) {
    failures++;
    console.log(`${file}: FAILED validation`);
    for (const p of problems) console.log(`    - ${p}`);
    continue;
  }

  console.log(`${file}: migrated (only comparator/$not nodes changed)`);
  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style.
  if (WRITE) writeFileSync(path, JSON.stringify(after));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would migrate"} ${touched} file(s), ${failures} validation failure(s).` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
