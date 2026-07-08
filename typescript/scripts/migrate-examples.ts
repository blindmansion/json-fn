// Migrate the canonical-JSON example programs (examples/*.json) to the new
// property-access canon via the shared `toNewCanon` utility. The `.jsonc` files
// are intentionally skipped (old artifacts slated for deletion).
//
// Each migrated program is validated: no legacy access forms remain, the
// transform is idempotent, and — crucially — every node that ISN'T a legacy
// access is byte-identical before and after, proving only the intended forms
// were touched.
//
// Dry-run by default; pass `--write` to update files in place.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hasLegacyVarAccess, toNewCanon } from "./canon-transform";
import type { JSONType } from "../src/types";

const DIR = join(import.meta.dir, "../../examples");
const WRITE = process.argv.includes("--write");

function isPlainObject(v: JSONType): v is { [k: string]: JSONType } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A legacy `$var` access node (the thing `toNewCanon` rewrites): a `$var` string
// with either a `$get` sibling or a dotted/bracket path — ignoring `$comment`.
function isLegacyAccess(v: JSONType): boolean {
  if (!isPlainObject(v) || "$raw" in v || typeof v.$var !== "string") return false;
  const others = Object.keys(v).filter((k) => k !== "$var" && k !== "$get" && k !== "$comment");
  if (others.length > 0) return false;
  return "$get" in v || v.$var.includes(".") || v.$var.includes("[");
}

// Assert that every node NOT part of a legacy access is preserved exactly.
// Legacy nodes (and their subtrees) are skipped — those are meant to change.
function collectUnexpectedChanges(before: JSONType, after: JSONType, path: string, out: string[]) {
  if (isLegacyAccess(before)) return;
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
  if (!hasLegacyVarAccess(before)) {
    console.log(`${file}: no legacy forms`);
    continue;
  }

  const after = toNewCanon(before);
  touched++;

  const problems: string[] = [];
  if (hasLegacyVarAccess(after)) problems.push("legacy forms still present after transform");
  if (JSON.stringify(toNewCanon(after)) !== JSON.stringify(after)) {
    problems.push("transform is not idempotent");
  }
  const changes: string[] = [];
  collectUnexpectedChanges(before, after, "", changes);
  if (changes.length > 0) {
    problems.push(`non-legacy nodes changed: ${changes.slice(0, 5).join(", ")}`);
  }

  if (problems.length > 0) {
    failures++;
    console.log(`${file}: FAILED validation`);
    for (const p of problems) console.log(`    - ${p}`);
    continue;
  }

  console.log(`${file}: migrated (only legacy access nodes changed)`);
  // Write compact; oxfmt (run afterward) reflows to the repo's canonical style.
  if (WRITE) writeFileSync(path, JSON.stringify(after));
}

console.log(
  `\n${WRITE ? "Wrote" : "Would migrate"} ${touched} file(s), ${failures} validation failure(s).` +
    (WRITE ? "" : " (dry run; pass --write to apply)"),
);
