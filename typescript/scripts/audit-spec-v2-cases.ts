// Audits `spec-v2/cases/` for markers the Stage 2 conformance migration (2g)
// must clear. Each category is a structural query over the case JSON: the
// mechanical categories must reach zero via bulk transforms, the review
// categories are work queues for hand triage (delete / rewrite / keep with
// justification). Run it repeatedly as the migration's progress gate.
//
// Usage (from `typescript/`):
//   bun run scripts/audit-spec-v2-cases.ts               # report all categories
//   bun run scripts/audit-spec-v2-cases.ts --gate sig-in-body,fields-descriptors
//   bun run scripts/audit-spec-v2-cases.ts --gate all    # exit 1 if anything remains
//   bun run scripts/audit-spec-v2-cases.ts --max 30      # show more pointers
//
// Deliberate post-migration negative cases (e.g. "reports $sig as an unknown
// field") can be recorded in ALLOWLIST below so the gate stays meaningful.

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Category {
  id: string;
  chunk: string;
  kind: "mechanical" | "delete" | "review";
  summary: string;
}

const CATEGORIES: Category[] = [
  {
    id: "sig-in-body",
    chunk: "2d",
    kind: "mechanical",
    summary: "source-body $sig — inline to per-slot $type plus $returns",
  },
  {
    id: "fields-descriptors",
    chunk: "2d",
    kind: "mechanical",
    summary: "$fields pattern slots — lower to __p<i> plus body-top projection $let",
  },
  {
    id: "allow-untyped-functions",
    chunk: "2d",
    kind: "mechanical",
    summary: "allowUntypedFunctions — delete the option, its schema field, and its cases",
  },
  {
    id: "array-path-get",
    chunk: "2b",
    kind: "mechanical",
    summary: "array-valued $get paths — unfold to nested single-key $get chains",
  },
  {
    id: "truthiness-suite",
    chunk: "2e",
    kind: "delete",
    summary: "the truthiness narrowing suite — deleted whole under D4",
  },
  {
    id: "nonbool-literal-condition",
    chunk: "2e",
    kind: "review",
    summary: "literal non-boolean $if/$cond condition — now an evaluation error",
  },
  {
    id: "nonbool-literal-operand",
    chunk: "2e",
    kind: "review",
    summary: "literal non-boolean $and/$or operand — value-returning forms are gone",
  },
  {
    id: "null-on-miss",
    chunk: "2b",
    kind: "review",
    summary: "eval case expecting null with a bare $get in scope — misses now error",
  },
  {
    id: "substituted-closure-expectation",
    chunk: "2c",
    kind: "review",
    summary:
      "expected function value whose body is not byte-identical to a case source subtree — substituted output is gone; bodies ride unrewritten beside $captures",
  },
  {
    id: "lazy-forcing-wording",
    chunk: "2a",
    kind: "review",
    summary:
      "case wording referencing laziness/forcing/demand/cycles — re-derive under strict $let",
  },
];

// Entries are `"<category-id> <path relative to spec-v2/cases>"`.
const ALLOWLIST = new Set<string>([
  // Stage B flagged these files' remaining findings for Stage C hand triage
  // (see the migrate-spec-v2-stage-b.ts report): alignment/malformed-descriptor
  // diagnostics that are unexpressible after 2d, diagnostics whose paths point
  // into `$sig`/`$fields`, and eval errors asserting pattern-specific identities
  // that 2b/2d replace. Remove each entry as Stage C resolves its cases.
  "sig-in-body check/functions/signatures.json",
  "sig-in-body check/modules/references.json",
  "fields-descriptors check/functions/signatures.json",
  "fields-descriptors eval/parameter-defaults.json",
  // Stage C (2a) deliberate survivors: cycles are still errors under strict
  // $let — these cases now pin the schedule-stall identity (docs
  // language/json/execution-limits.md), so their "cycle" wording is accurate.
  "lazy-forcing-wording check/locals/recursion.json",
  "lazy-forcing-wording eval/safety-limits.json",
  // Stage C (2a): type-level ($types) recursion is 2a-adjacent wording only;
  // the non-contractive-cycle rule is untouched by strict $let.
  "lazy-forcing-wording check/modules/recursive-types.json",
  // Stage C (2a): the positional $default is the language's one surviving
  // lazy construct (docs language/json/functions.md), so its laziness and
  // default-cycle cases keep their wording.
  "lazy-forcing-wording eval/parameter-defaults.json",
]);

// --- CLI ---

let gateIds: string[] = [];
let maxPointers = 12;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--gate") {
    const value = argv[++i];
    if (!value) usage("--gate requires a value");
    gateIds = value === "all" ? CATEGORIES.map((c) => c.id) : value.split(",");
  } else if (arg === "--max") {
    const value = Number(argv[++i]);
    if (!Number.isInteger(value) || value < 1) usage("--max requires a positive integer");
    maxPointers = value;
  } else {
    usage(`unknown argument: ${arg}`);
  }
}
const knownIds = new Set(CATEGORIES.map((c) => c.id));
for (const id of gateIds) if (!knownIds.has(id)) usage(`unknown gate category: ${id}`);

function usage(message: string): never {
  console.error(message);
  console.error("Usage: bun run scripts/audit-spec-v2-cases.ts [--gate <ids|all>] [--max N]");
  console.error(`Categories: ${CATEGORIES.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

// --- collection ---

const casesDir = resolve(import.meta.dir, "../../spec-v2/cases");
if (!existsSync(casesDir)) {
  console.error(`No cases directory found at ${casesDir}`);
  process.exit(2);
}

// category id -> pointer -> occurrence count; plus the touched files.
const findings = new Map<string, Map<string, number>>();
const touchedFiles = new Map<string, Set<string>>();
for (const category of CATEGORIES) {
  findings.set(category.id, new Map());
  touchedFiles.set(category.id, new Set());
}

function record(categoryId: string, file: string, pointer: string): void {
  if (ALLOWLIST.has(`${categoryId} ${file}`)) return;
  const byPointer = findings.get(categoryId)!;
  byPointer.set(pointer, (byPointer.get(pointer) ?? 0) + 1);
  touchedFiles.get(categoryId)!.add(file);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkNodes(value: Json, visit: (node: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visit);
    return;
  }
  if (isObject(value)) {
    visit(value);
    for (const key of Object.keys(value)) walkNodes(value[key]!, visit);
  }
}

function containsKey(value: Json, key: string): boolean {
  let found = false;
  walkNodes(value, (node) => {
    if (key in node) found = true;
  });
  return found;
}

// Canonical (key-sorted) encoding, used for subtree byte-identity checks.
function canonicalize(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectSubtrees(value: Json, into: Set<string>): void {
  walkNodes(value, (node) => into.add(canonicalize(node)));
}

// 2c's body byte-identity claim: every expected function value's body — the
// node minus the value-only fields — must appear byte-identically as a
// subtree of the case's source material. Substituted output never does.
function hasNonSourceFunctionValue(expected: Json, sourceSubtrees: Set<string>): boolean {
  let found = false;
  walkNodes(expected, (node) => {
    if (!("$return" in node)) return;
    const body: JsonObject = {};
    for (const key of Object.keys(node)) {
      if (key !== "$captures" && key !== "$runtimeContract") body[key] = node[key]!;
    }
    if (!sourceSubtrees.has(canonicalize(body))) found = true;
  });
  return found;
}

function hasBareGet(value: Json): boolean {
  let found = false;
  walkNodes(value, (node) => {
    if ("$get" in node && !("$else" in node)) found = true;
  });
  return found;
}

// A value the evaluator could never produce as `true`/`false`: literals and
// plain data (no `$`-keyed operator object). `$var`/`$call`/... are unknown
// without types and are left to hand review.
function isLiteralNonBoolean(value: Json | undefined): boolean {
  if (value === undefined || typeof value === "boolean") return false;
  if (value === null || typeof value === "number" || typeof value === "string") return true;
  if (Array.isArray(value)) return true;
  return !Object.keys(value).some((key) => key.startsWith("$"));
}

// Structural (node-shape) categories, attributed to `pointer`.
//
// The 2e categories flag only *live* literal non-booleans: operands past a
// literal deciding operand (`false` for `$and`, `true` for `$or`) and `$cond`
// arms behind a literal `true` condition are neither evaluated nor validated
// (validation attaches to evaluation), so a dead literal asserts nothing. A
// case that pins the boolean-position rejection — an eval `error` naming it,
// or a checker diagnostic expecting `{type: boolean}` — keeps its reached
// non-boolean literal deliberately; that is the case's teaching.
function scanNodes(value: Json, file: string, pointer: string, pinsBooleanError = false): void {
  walkNodes(value, (node) => {
    if ("$sig" in node) record("sig-in-body", file, pointer);
    if ("$fields" in node) record("fields-descriptors", file, pointer);
    if ("allowUntypedFunctions" in node) record("allow-untyped-functions", file, pointer);
    if (Array.isArray(node["$get"])) record("array-path-get", file, pointer);
    if (pinsBooleanError) return;
    if (isLiteralNonBoolean(node["$if"])) record("nonbool-literal-condition", file, pointer);
    const cond = node["$cond"];
    if (Array.isArray(cond)) {
      for (const arm of cond) {
        if (!Array.isArray(arm)) continue;
        if (isLiteralNonBoolean(arm[0])) record("nonbool-literal-condition", file, pointer);
        if (arm[0] === true) break; // later arms are unreachable
      }
    }
    for (const form of ["$and", "$or"]) {
      const operands = node[form];
      if (!Array.isArray(operands)) continue;
      const decider = form === "$and" ? false : true;
      for (const operand of operands) {
        if (isLiteralNonBoolean(operand)) record("nonbool-literal-operand", file, pointer);
        if (operand === decider) break; // later operands are neither evaluated nor validated
      }
    }
  });
}

const LAZY_WORDING = /laz(y|i)|unforced|not forced|demand|cycle/i;

const caseFiles = [...new Glob("*/**/*.json").scanSync({ cwd: casesDir })].sort();
for (const file of caseFiles) {
  const suite = file.split("/")[0]!;
  const doc = JSON.parse(await Bun.file(join(casesDir, file)).text()) as Json;
  if (!isObject(doc)) continue;

  const cases = Array.isArray(doc["cases"]) ? doc["cases"] : undefined;
  if (cases === undefined) {
    scanNodes(doc, file, file);
    continue;
  }

  // Shared top-level material (e.g. an eval file's `functions`).
  const sharedSubtrees = new Set<string>();
  for (const key of Object.keys(doc)) {
    if (key === "cases") continue;
    scanNodes(doc[key]!, file, `${file} (shared)`);
    collectSubtrees(doc[key]!, sharedSubtrees);
  }
  const sharedHasBareGet = hasBareGet(doc["functions"] ?? null);

  cases.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const description = typeof entry["description"] === "string" ? entry["description"] : "";
    const pointer = `${file} #${index}${description ? ` — ${description}` : ""}`;
    const expectedDiagnostics = isObject(entry["expected"])
      ? entry["expected"]["diagnostics"]
      : undefined;
    const pinsBooleanError =
      (typeof entry["error"] === "string" && entry["error"].includes("must be a boolean")) ||
      (Array.isArray(expectedDiagnostics) &&
        expectedDiagnostics.some(
          (d) => isObject(d) && canonicalize(d["expected"] ?? null) === '{"type":"boolean"}',
        ));
    scanNodes(entry, file, pointer, pinsBooleanError);

    if (suite === "eval") {
      if (
        Object.hasOwn(entry, "expected") &&
        entry["expected"] === null &&
        (hasBareGet(entry) || sharedHasBareGet)
      ) {
        record("null-on-miss", file, pointer);
      }
    }
    if (
      (suite === "eval" || suite === "builtins") &&
      entry["expected"] !== undefined &&
      containsKey(entry["expected"], "$return")
    ) {
      const sourceSubtrees = new Set(sharedSubtrees);
      for (const key of Object.keys(entry)) {
        if (key !== "expected") collectSubtrees(entry[key]!, sourceSubtrees);
      }
      if (hasNonSourceFunctionValue(entry["expected"]!, sourceSubtrees)) {
        record("substituted-closure-expectation", file, pointer);
      }
    }
    const wording = [entry["description"], entry["comment"]]
      .filter((v) => typeof v === "string")
      .join(" ");
    if (LAZY_WORDING.test(wording)) record("lazy-forcing-wording", file, pointer);
  });
}

// The option's schema field lives beside the suites, in the root schemas.
for (const file of [...new Glob("*.schema.json").scanSync({ cwd: casesDir })].sort()) {
  const doc = JSON.parse(await Bun.file(join(casesDir, file)).text()) as Json;
  walkNodes(doc, (node) => {
    if ("allowUntypedFunctions" in node) record("allow-untyped-functions", file, file);
  });
}

if (existsSync(join(casesDir, "check/narrowing/truthiness.json"))) {
  record("truthiness-suite", "check/narrowing/truthiness.json", "check/narrowing/truthiness.json");
}

// --- report ---

let gateFailures = 0;
for (const category of CATEGORIES) {
  const byPointer = findings.get(category.id)!;
  const total = [...byPointer.values()].reduce((sum, n) => sum + n, 0);
  const files = touchedFiles.get(category.id)!;
  const gated = gateIds.includes(category.id);
  if (gated && total > 0) gateFailures += 1;

  const status = total === 0 ? "clear" : `${total} finding(s) in ${files.size} file(s)`;
  console.log(
    `[${category.chunk}][${category.kind}] ${category.id}: ${status}${gated && total > 0 ? "  <-- GATED" : ""}`,
  );
  if (total === 0) continue;
  console.log(`    ${category.summary}`);
  const pointers = [...byPointer.entries()];
  for (const [pointer, count] of pointers.slice(0, maxPointers)) {
    console.log(`    ${pointer}${count > 1 ? ` (x${count})` : ""}`);
  }
  if (pointers.length > maxPointers) {
    console.log(`    ... ${pointers.length - maxPointers} more (rerun with --max)`);
  }
}

if (gateFailures > 0) {
  console.error(`\nGate failed: ${gateFailures} gated categor(ies) still have findings.`);
  process.exit(1);
}
if (gateIds.length > 0) console.log("\nGate passed.");
