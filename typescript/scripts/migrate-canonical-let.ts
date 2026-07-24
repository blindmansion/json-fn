import { isAbsolute, relative, resolve } from "path";
import {
  analyzeParameters,
  boundParameterNames,
  defaultBindings,
  formatParameterIssue,
} from "../src/params";
import type { JSONType } from "../src/types";

type JSONObject = Record<string, JSONType>;

type Counts = {
  functionBodies: number;
  bodyLocals: number;
  bindingIifes: number;
};

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FUNCTION_BODY_KEYS = new Set([
  "$return",
  "$params",
  "$sig",
  "$comment",
  "$captures",
  "$runtimeContract",
]);

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/migrate-canonical-let.ts (--check | --write) <path-or-glob> [...]",
  );
}

function isObject(value: JSONType): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(): JSONObject {
  return Object.create(null) as JSONObject;
}

function pathString(path: readonly (string | number)[]): string {
  if (path.length === 0) return "$";
  let result = "$";
  for (const segment of path) {
    result += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return result;
}

function fail(file: string, path: readonly (string | number)[], message: string): never {
  throw new Error(`${file}:${pathString(path)}: ${message}`);
}

function bodyLocalKeys(body: JSONObject): string[] {
  return Object.keys(body).filter((key) => !FUNCTION_BODY_KEYS.has(key));
}

function validateBody(
  body: JSONObject,
  file: string,
  path: readonly (string | number)[],
): string[] {
  if ("$comment" in body && typeof body.$comment !== "string") {
    fail(file, [...path, "$comment"], "$comment must be a string.");
  }
  if ("$types" in body) {
    fail(file, [...path, "$types"], "$types is module-only and cannot appear in a function body.");
  }

  const localKeys = bodyLocalKeys(body);
  const unknownReserved = localKeys.find((key) => key.startsWith("$"));
  if (unknownReserved !== undefined) {
    fail(
      file,
      [...path, unknownReserved],
      `unknown reserved function-body key "${unknownReserved}".`,
    );
  }

  const analysis = analyzeParameters(body.$params);
  if (!analysis.ok) {
    fail(file, [...path, "$params"], formatParameterIssue(analysis.issue));
  }

  const localNames = new Set(localKeys);
  const collision = boundParameterNames(analysis.layout).find((name) => localNames.has(name));
  if (collision !== undefined) {
    fail(
      file,
      path,
      `inline local "${collision}" collides with a parameter binding; migrate this body manually.`,
    );
  }

  for (const binding of defaultBindings(analysis.layout)) {
    const reference = findReferenceTo(binding.expression, localNames);
    if (reference !== null) {
      fail(
        file,
        [...path, "$params", ...binding.path, ...reference.path],
        `parameter default refers to inline local "${reference.name}" through ${reference.kind}; migrate this body manually.`,
      );
    }
  }

  return localKeys;
}

function findReferenceTo(
  value: JSONType,
  names: ReadonlySet<string>,
): { name: string; kind: "$var" | "$fn" | "$call"; path: (string | number)[] } | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findReferenceTo(value[index]!, names);
      if (found !== null) return { ...found, path: [index, ...found.path] };
    }
    return null;
  }
  if (!isObject(value) || "$raw" in value) return null;

  for (const kind of ["$var", "$fn", "$call"] as const) {
    const name = value[kind];
    if (typeof name === "string" && names.has(name)) {
      return { name, kind, path: [kind] };
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findReferenceTo(child, names);
    if (found !== null) return { ...found, path: [key, ...found.path] };
  }
  return null;
}

function isBindingIife(value: JSONObject): value is JSONObject & {
  $call: JSONObject;
  $args: JSONType[];
} {
  if (
    Object.keys(value).length !== 2 ||
    !("$call" in value) ||
    !("$args" in value) ||
    !Array.isArray(value.$args) ||
    value.$args.length !== 0 ||
    !isObject(value.$call) ||
    !("$return" in value.$call)
  ) {
    return false;
  }

  const callee = value.$call;
  const params = callee.$params;
  return (
    bodyLocalKeys(callee).some((key) => !key.startsWith("$")) &&
    (params === undefined || (Array.isArray(params) && params.length === 0)) &&
    !("$sig" in callee) &&
    !("$captures" in callee) &&
    !("$runtimeContract" in callee)
  );
}

function migrate(
  value: JSONType,
  file: string,
  path: readonly (string | number)[],
  counts: Counts,
): JSONType {
  if (Array.isArray(value)) {
    return value.map((child, index) => migrate(child, file, [...path, index], counts));
  }
  if (!isObject(value) || "$raw" in value) return value;

  if (isBindingIife(value)) {
    const callee = value.$call;
    const localKeys = validateBody(callee, file, [...path, "$call"]);
    const bindings = jsonObject();
    for (const key of localKeys) {
      bindings[key] = migrate(callee[key]!, file, [...path, "$call", key], counts);
    }
    counts.bindingIifes++;
    return {
      $let: bindings,
      $in: migrate(callee.$return!, file, [...path, "$call", "$return"], counts),
    };
  }

  if ("$return" in value) {
    counts.functionBodies++;
    const localKeys = bodyLocalKeys(value).length === 0 ? [] : validateBody(value, file, path);
    const locals = new Set(localKeys);
    const migrated = jsonObject();
    for (const [key, child] of Object.entries(value)) {
      if (locals.has(key)) continue;
      if (key === "$return" && localKeys.length > 0) {
        const bindings = jsonObject();
        for (const local of localKeys) {
          bindings[local] = migrate(value[local]!, file, [...path, local], counts);
        }
        migrated.$return = {
          $let: bindings,
          $in: migrate(child, file, [...path, "$return"], counts),
        };
      } else {
        migrated[key] = migrate(child, file, [...path, key], counts);
      }
    }
    if (localKeys.length > 0) counts.bodyLocals++;
    return migrated;
  }

  const migrated = jsonObject();
  for (const [key, child] of Object.entries(value)) {
    migrated[key] = migrate(child, file, [...path, key], counts);
  }
  return migrated;
}

async function inputFiles(patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const input of patterns) {
    const absoluteInput = isAbsolute(input) ? input : resolve(process.cwd(), input);
    if (!/[*?[\]{}]/.test(input)) {
      if (!(await Bun.file(absoluteInput).exists())) {
        throw new Error(`Input does not exist: ${input}`);
      }
      files.add(absoluteInput);
      continue;
    }

    const pattern = isAbsolute(input)
      ? relative(REPO_ROOT, input)
      : relative(REPO_ROOT, absoluteInput);
    let matched = false;
    for await (const match of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT, onlyFiles: true })) {
      files.add(resolve(REPO_ROOT, match));
      matched = true;
    }
    if (!matched) throw new Error(`Glob matched no files: ${input}`);
  }
  return [...files].sort();
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const write = args.includes("--write");
if (check === write) usage();
const patterns = args.filter((arg) => arg !== "--check" && arg !== "--write");
if (patterns.length === 0) usage();

const totals: Counts = { functionBodies: 0, bodyLocals: 0, bindingIifes: 0 };
for (const absolutePath of await inputFiles(patterns)) {
  const displayPath = relative(REPO_ROOT, absolutePath);
  const source = await Bun.file(absolutePath).text();
  const parsed = JSON.parse(source) as JSONType;
  const counts: Counts = { functionBodies: 0, bodyLocals: 0, bindingIifes: 0 };
  const migrated = migrate(parsed, displayPath, [], counts);
  totals.functionBodies += counts.functionBodies;
  totals.bodyLocals += counts.bodyLocals;
  totals.bindingIifes += counts.bindingIifes;
  console.log(
    `${displayPath}: ${counts.functionBodies} bodies, ${counts.bodyLocals} body-local transforms, ${counts.bindingIifes} binding-IIFE transforms`,
  );
  if (write && (counts.bodyLocals > 0 || counts.bindingIifes > 0)) {
    await Bun.write(absolutePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
}

console.log(
  `total: ${totals.functionBodies} bodies, ${totals.bodyLocals} body-local transforms, ${totals.bindingIifes} binding-IIFE transforms`,
);
