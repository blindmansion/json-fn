// Validates every conformance case file in a spec directory against its
// suite schema. Each `<specDir>/cases/<suite>/**/*.json` case file is checked
// against the sibling `<specDir>/cases/<schema>.schema.json`, where the schema
// name is the suite directory name (with the irregular `builtins` directory
// mapping to `builtin.schema.json`).
//
// Usage: bun run scripts/validate-spec-schemas.ts <spec-dir>
// e.g. from the repo root: bun run typescript/scripts/validate-spec-schemas.ts spec-v2

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";

const specDirArg = process.argv[2];
if (!specDirArg) {
  console.error("Usage: bun run scripts/validate-spec-schemas.ts <spec-dir>");
  console.error("Example: bun run scripts/validate-spec-schemas.ts ../spec-v2");
  process.exit(2);
}

const specDir = resolve(specDirArg);
const casesDir = join(specDir, "cases");
if (!existsSync(casesDir)) {
  console.error(`No cases directory found at ${casesDir}`);
  process.exit(2);
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });

// Suite directory name -> compiled validator for its sibling schema.
const validators = new Map<string, ValidateFunction>();
for (const path of new Glob("*.schema.json").scanSync({ cwd: casesDir, absolute: true })) {
  const schemaName = basename(path).replace(/\.schema\.json$/, "");
  // The `builtins` suite directory pairs with the singular `builtin.schema.json`.
  const suite = schemaName === "builtin" ? "builtins" : schemaName;
  validators.set(suite, ajv.compile(JSON.parse(await Bun.file(path).text())));
}

let checked = 0;
let failures = 0;

const caseFiles = new Glob("*/**/*.json").scanSync({ cwd: casesDir, absolute: true });
for (const path of [...caseFiles].sort()) {
  const relPath = relative(casesDir, path);
  const suite = relPath.split("/")[0]!;
  const validate = validators.get(suite);
  if (!validate) {
    console.error(`FAIL ${relPath}: no schema for suite directory '${suite}'`);
    failures += 1;
    continue;
  }
  checked += 1;
  const data: unknown = JSON.parse(await Bun.file(path).text());
  if (validate(data)) continue;
  failures += 1;
  console.error(`FAIL ${relPath}`);
  for (const error of validate.errors ?? []) {
    console.error(`  ${error.instancePath || "/"}: ${error.message ?? "invalid"}`);
  }
}

const specLabel = relative(process.cwd(), specDir) || specDir;
if (failures > 0) {
  console.error(
    `\n${specLabel}: ${failures} file(s) failed schema validation (${checked} checked).`,
  );
  process.exit(1);
}
console.log(`${specLabel}: all ${checked} case files match their schemas.`);
