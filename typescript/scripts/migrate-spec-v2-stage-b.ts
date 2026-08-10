// One-shot Stage B migration for `spec-v2/cases/` (plans/spec-v2/conformance-2g.md).
// Not maintained tooling: it exists to perform the mechanical bulk passes once and
// emit the flagged-for-hand-review list. Passes, in the plan's order:
//
//   2. `$sig` inlining — `$sig.required[i]`/`$sig.optional[i]` become per-slot
//      `$type`, `$sig.rest` becomes a rest descriptor carrying the array type as
//      written, and `$sig.returns` becomes the body's `$returns`. Deviation from
//      the plan's cosmetic rule, reported per occurrence: `true` schemas are kept
//      explicit (`$type: true` / `$returns: true`) instead of dropped, because a
//      `$sig`-carrying body was "declared" in v1 and dropping them would demote
//      named functions and concrete lambdas to partially annotated, changing
//      checker expectations.
//   3. `$fields` lowering — a pattern slot at index i becomes the reserved
//      `__p<i>` slot (carrying the pattern's `$type` when the `$sig` pass attached
//      one) plus one body-top `$let` of strict-read projections wrapping the
//      authored `$return`.
//   4. array-path `$get` unfolding — a path array becomes a nested single-key
//      `$get` chain, innermost segment first. Cases *asserting* the array-path
//      form (rather than merely using it) are deleted via DELETE_CASES below.
//
// A case is flagged (left byte-identical, listed in the report) when its
// expectations assert behavior the transforms erase: diagnostics mentioning
// `$sig`/`$fields` paths or alignment, zip shapes that do not line up, malformed
// or duplicate-binding patterns, and eval errors with pattern-specific
// identities. Flagged cases are Stage C hand work; the audit script's ALLOWLIST
// records them so the Stage B gate stays meaningful.
//
// Usage (from `typescript/`):
//   bun run scripts/migrate-spec-v2-stage-b.ts          # report only
//   bun run scripts/migrate-spec-v2-stage-b.ts --write  # apply changes

import { Glob } from "bun";
import { join, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const write = process.argv.includes("--write");
const casesDir = resolve(import.meta.dir, "../../spec-v2/cases");

// Cases asserting array-path behavior (2b removes the form); reviewed one by one
// against the audit pointers. Everything else with an array path merely uses it
// and unfolds.
const DELETE_CASES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "eval/property-access.json",
    [
      // Asserts the array-path form itself; nested-structure coverage survives in
      // the unfolded dot-notation cases.
      "path access walks nested structure",
      "path with array index",
      // Asserts the path-walk miss short-circuit, a behavior 2b deletes with the
      // form; single-key null-on-miss cases already queue for Stage C.
      "missing path segment returns null",
      "dot notation: missing intermediate returns null",
      // Asserts per-segment validation of the folded form; unfolded it duplicates
      // "object access rejects a numeric key".
      "folded paths validate each segment against its current target",
    ],
  ],
]);

// Descriptions asserting the deleted collapse behavior, reworded to the nested
// chain the v2 parser emits.
const RENAME_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [
    "parse/property-access.json :: mixed dotted and numeric access collapses",
    "mixed dotted and numeric access lowers to a nested chain",
  ],
]);

class FlagError extends Error {}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromEntries(entries: [string, Json][]): JsonObject {
  // Object.fromEntries uses CreateDataProperty, so a "__proto__" binding (the
  // corpus has one) becomes an ordinary own property.
  return Object.fromEntries(entries) as JsonObject;
}

function isSchema(value: Json | undefined): value is boolean | JsonObject {
  return typeof value === "boolean" || isObject(value);
}

// --- pass 2: $sig inlining ---

function inlineSig(body: JsonObject): JsonObject {
  const sig = body["$sig"];
  if (!isObject(sig)) throw new FlagError("$sig is not an object");
  const required = sig["required"];
  const optional = sig["optional"];
  if (
    !Array.isArray(required) ||
    !Array.isArray(optional) ||
    !required.every(isSchema) ||
    !optional.every(isSchema)
  ) {
    throw new FlagError("$sig required/optional are not schema arrays");
  }
  const rest = sig["rest"];
  const returns = sig["returns"];
  if (("rest" in sig && !isSchema(rest)) || !isSchema(returns)) {
    throw new FlagError("$sig rest/returns are not schemas");
  }

  const params = Array.isArray(body["$params"]) ? [...body["$params"]] : [];
  const isPattern = (slot: Json) => isObject(slot) && "$fields" in slot;
  const isRequiredName = (slot: Json) => typeof slot === "string" && !slot.startsWith("...");
  const isOptionalDescriptor = (slot: Json) =>
    isObject(slot) &&
    typeof slot["$param"] === "string" &&
    !slot["$param"].startsWith("...") &&
    ("$optional" in slot || "$default" in slot);
  const isRest = (slot: Json) => typeof slot === "string" && slot.startsWith("...");

  let i = 0;
  const requiredIndexes: number[] = [];
  while (i < params.length && (isRequiredName(params[i]!) || isPattern(params[i]!)))
    requiredIndexes.push(i++);
  const optionalIndexes: number[] = [];
  while (i < params.length && isOptionalDescriptor(params[i]!)) optionalIndexes.push(i++);
  const restIndex = i < params.length && isRest(params[i]!) ? i++ : undefined;
  if (i !== params.length) throw new FlagError("unrecognized $params slot shape");
  if (requiredIndexes.length !== required.length || optionalIndexes.length !== optional.length) {
    throw new FlagError("$sig arity does not match the declared $params layout");
  }
  if ("rest" in sig !== (restIndex !== undefined)) {
    throw new FlagError("$sig rest does not match the declared $params layout");
  }

  // `true` schemas stay explicit; see the header comment.
  requiredIndexes.forEach((slotIndex, sigIndex) => {
    const slot = params[slotIndex]!;
    const schema = required[sigIndex]! as Json;
    if (typeof slot === "string") {
      params[slotIndex] = { $param: slot, $type: schema };
    } else {
      const pattern = slot as JsonObject;
      params[slotIndex] = fromEntries([...Object.entries(pattern), ["$type", schema]]);
    }
  });
  optionalIndexes.forEach((slotIndex, sigIndex) => {
    const descriptor = params[slotIndex] as JsonObject;
    params[slotIndex] = fromEntries([
      ...Object.entries(descriptor),
      ["$type", optional[sigIndex]! as Json],
    ]);
  });
  if (restIndex !== undefined) {
    params[restIndex] = {
      $param: params[restIndex] as string,
      $type: { type: "array", items: rest! },
    };
  }

  if ([...required, ...optional, rest, returns].some((schema) => schema === true)) {
    keptTrue.push(currentPointer);
  }

  // Canonical key order for the migrated body: leading keys (e.g. $comment) in
  // original order, then $params, $returns, $return, then any trailing keys.
  const leading: [string, Json][] = [];
  const trailing: [string, Json][] = [];
  let seenCore = false;
  for (const [key, value] of Object.entries(body)) {
    if (key === "$sig" || key === "$params" || key === "$return") {
      seenCore = true;
      continue;
    }
    (seenCore ? trailing : leading).push([key, value]);
  }
  const core: [string, Json][] = [];
  if ("$params" in body) core.push(["$params", params]);
  core.push(["$returns", returns as Json]);
  if ("$return" in body) core.push(["$return", body["$return"]!]);
  return fromEntries([...leading, ...core, ...trailing]);
}

// --- pass 3: $fields lowering ---

function lowerFields(body: JsonObject): JsonObject {
  const params = body["$params"];
  if (!Array.isArray(params)) throw new FlagError("$fields outside a $params array");
  if (!("$return" in body)) throw new FlagError("$fields on a body without $return");

  const boundNames = new Set<string>();
  const bind = (name: string) => {
    if (boundNames.has(name)) throw new FlagError(`duplicate parameter binding "${name}"`);
    boundNames.add(name);
  };
  for (const slot of params) {
    if (typeof slot === "string") bind(slot.startsWith("...") ? slot.slice(3) : slot);
    else if (isObject(slot) && typeof slot["$param"] === "string") bind(slot["$param"]);
  }

  const projections: [string, Json][] = [];
  const newParams = params.map((slot, index) => {
    if (!isObject(slot) || !("$fields" in slot)) return slot;
    const extraKeys = Object.keys(slot).filter((key) => key !== "$fields" && key !== "$type");
    if (extraKeys.length > 0)
      throw new FlagError(`pattern slot has unexpected keys: ${extraKeys.join(", ")}`);
    const fields = slot["$fields"];
    if (!Array.isArray(fields) || fields.length === 0)
      throw new FlagError("malformed $fields array");
    const parameter = `__p${index}`;
    for (const field of fields) {
      const from: Json = { $var: parameter };
      if (typeof field === "string") {
        bind(field);
        projections.push([field, { $get: field, $from: from }]);
        continue;
      }
      if (!isObject(field) || typeof field["$field"] !== "string") {
        throw new FlagError("malformed $fields entry");
      }
      const name = field["$field"];
      const keys = Object.keys(field).sort();
      if (keys.join(",") === "$field,$optional" && field["$optional"] === true) {
        bind(name);
        projections.push([name, { $get: name, $from: from, $else: null }]);
      } else if (keys.join(",") === "$default,$field") {
        bind(name);
        projections.push([name, { $get: name, $from: from, $else: field["$default"]! }]);
      } else {
        throw new FlagError("malformed $fields entry");
      }
    }
    return "$type" in slot ? { $param: parameter, $type: slot["$type"]! } : parameter;
  });

  const entries: [string, Json][] = Object.entries(body).map(([key, value]) => {
    if (key === "$params") return [key, newParams];
    if (key === "$return") return [key, { $let: fromEntries(projections), $in: value }];
    return [key, value];
  });
  return fromEntries(entries);
}

// --- pass 4: array-path $get unfolding ---

function unfoldPath(node: JsonObject): JsonObject {
  const segments = node["$get"];
  if (!Array.isArray(segments) || segments.length === 0) throw new FlagError("empty $get path");
  let from = node["$from"] ?? null;
  for (const segment of segments.slice(0, -1)) from = { $get: segment, $from: from };
  return fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (key === "$get") return [key, segments[segments.length - 1]!];
      if (key === "$from") return [key, from];
      return [key, value];
    }),
  );
}

// --- traversal ---

function transform(value: Json): Json {
  if (Array.isArray(value)) return value.map(transform);
  if (!isObject(value)) return value;
  // Bottom-up, so the material a node transform moves (slot schemas, field
  // defaults, `$from` targets) is already in final form.
  let node: JsonObject = fromEntries(
    Object.entries(value).map(([key, child]) => [key, transform(child)]),
  );
  if ("$sig" in node) node = inlineSig(node);
  if (
    Array.isArray(node["$params"]) &&
    node["$params"].some((slot) => isObject(slot) && "$fields" in slot)
  ) {
    node = lowerFields(node);
  }
  if (Array.isArray(node["$get"])) node = unfoldPath(node);
  return node;
}

// Expectations asserting behavior the transforms erase: alignment and
// descriptor-form diagnostics, and pattern-specific eval error identities.
function textualFlag(entry: JsonObject): string | undefined {
  const expected = entry["expected"];
  const diagnostics = isObject(expected) ? expected["diagnostics"] : undefined;
  const text = JSON.stringify(diagnostics ?? []) + JSON.stringify(entry["throws"] ?? null);
  if (/\$sig|\$fields|aligned|Body signature|Object parameter pattern/.test(text)) {
    return "diagnostics assert $sig/$fields shapes or alignment";
  }
  const error = entry["error"];
  if (
    typeof error === "string" &&
    /object-pattern|plain object|Missing required field/i.test(error)
  ) {
    return "error asserts a pattern-specific identity (2b/2d change it)";
  }
  return undefined;
}

const flagged: string[] = [];
const deleted: string[] = [];
const keptTrue: string[] = [];
const changedFiles: string[] = [];
let currentPointer = "";

const caseFiles = [...new Glob("*/**/*.json").scanSync({ cwd: casesDir })].sort();
for (const file of caseFiles) {
  const path = join(casesDir, file);
  const original = await Bun.file(path).text();
  const doc = JSON.parse(original) as Json;
  if (!isObject(doc)) continue;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(doc)) {
    currentPointer = `${file} (shared)`;
    if (key !== "cases") out[key] = transform(value); // shared material never flags
  }

  const cases = doc["cases"];
  if (Array.isArray(cases)) {
    const kept: Json[] = [];
    const deletions = DELETE_CASES.get(file) ?? [];
    cases.forEach((entry, index) => {
      if (!isObject(entry)) {
        kept.push(entry);
        return;
      }
      const description = typeof entry["description"] === "string" ? entry["description"] : "";
      const pointer = `${file} #${index}${description ? ` — ${description}` : ""}`;
      currentPointer = pointer;
      if (deletions.includes(description)) {
        deleted.push(pointer);
        return;
      }
      const reason = textualFlag(entry);
      if (reason !== undefined) {
        flagged.push(`${pointer}\n      ${reason}`);
        kept.push(entry);
        return;
      }
      try {
        let next = transform(entry) as JsonObject;
        const rename = RENAME_DESCRIPTIONS.get(`${file} :: ${description}`);
        if (rename !== undefined) next = { ...next, description: rename };
        kept.push(next);
      } catch (error) {
        if (!(error instanceof FlagError)) throw error;
        flagged.push(`${pointer}\n      ${error.message}`);
        kept.push(entry);
      }
    });
    // Preserve top-level key order, cases in place.
    for (const key of Object.keys(doc)) {
      if (key === "cases") out[key] = kept;
    }
  }

  const serialized = `${JSON.stringify(out, null, 2)}\n`;
  if (JSON.stringify(out) !== JSON.stringify(doc)) {
    changedFiles.push(file);
    if (write) await Bun.write(path, serialized);
  }
}

console.log(`Flagged for hand review (${flagged.length}):`);
for (const entry of flagged) console.log(`  ${entry}`);
console.log(`\nDeleted array-path-asserting cases (${deleted.length}):`);
for (const entry of deleted) console.log(`  ${entry}`);
console.log(
  `\nKept explicit \`true\` annotations, deviating from the plan's drop rule (${keptTrue.length}):`,
);
for (const entry of keptTrue) console.log(`  ${entry}`);
console.log(`\n${write ? "Rewrote" : "Would rewrite"} ${changedFiles.length} file(s):`);
for (const file of changedFiles) console.log(`  ${file}`);
if (!write) console.log("\nDry run; pass --write to apply.");
