import type { JSONType } from "../types";
import type { Schema } from "./type-parser";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REFINEMENTS: [string, string, "number" | "string" | "flag"][] = [
  ["minimum", "min", "number"],
  ["maximum", "max", "number"],
  ["exclusiveMinimum", "xmin", "number"],
  ["exclusiveMaximum", "xmax", "number"],
  ["multipleOf", "multipleOf", "number"],
  ["minLength", "minLen", "number"],
  ["maxLength", "maxLen", "number"],
  ["pattern", "pattern", "string"],
  ["format", "format", "string"],
  ["minItems", "minItems", "number"],
  ["maxItems", "maxItems", "number"],
  ["uniqueItems", "unique", "flag"],
];

function isObject(value: unknown): value is Record<string, JSONType> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refName(ref: JSONType): string {
  return String(ref).replace(/^#\/\$defs\//, "");
}

function literal(value: JSONType): string {
  if (value === null) return "null";
  return JSON.stringify(value);
}

function isUnion(schema: Schema): boolean {
  return (
    isObject(schema) &&
    (Array.isArray(schema.anyOf) || Array.isArray(schema.enum) || Array.isArray(schema.type))
  );
}

function isFnType(schema: Schema): boolean {
  return isObject(schema) && isObject(schema.$fnType);
}

function isTaskType(schema: Schema): boolean {
  return isObject(schema) && "$taskType" in schema;
}

function postfixOperand(schema: Schema): string {
  const rendered = printType(schema);
  return isUnion(schema) || isFnType(schema) ? `(${rendered})` : rendered;
}

function unionArm(schema: Schema): string {
  const rendered = printType(schema);
  return isFnType(schema) ? `(${rendered})` : rendered;
}

function printRefinements(
  base: string,
  schema: Record<string, JSONType>,
  ignored: ReadonlySet<string> = new Set(),
): string {
  let out = base;
  for (const [keyword, surface, kind] of REFINEMENTS) {
    if (ignored.has(keyword) || !(keyword in schema)) continue;
    const value = schema[keyword]!;
    if (kind === "flag") {
      if (value === true) out += ` & ${surface}`;
    } else {
      out += ` & ${surface}(${kind === "string" ? JSON.stringify(value) : String(value)})`;
    }
  }
  return out;
}

function printObject(schema: Record<string, JSONType>): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const entries = Object.entries(properties).map(([key, value]) => {
    const name = IDENT_RE.test(key) ? key : JSON.stringify(key);
    return `${name}${required.has(key) ? "" : "?"}: ${printType(value)}`;
  });

  if (schema.additionalProperties === undefined) {
    entries.push("...");
  } else if (schema.additionalProperties !== false) {
    entries.push(`[string]: ${printType(schema.additionalProperties)}`);
  }

  if (entries.length === 0) return "{}";
  return `{ ${entries.join(", ")} }`;
}

function printArray(schema: Record<string, JSONType>): string {
  if (Array.isArray(schema.prefixItems)) {
    const prefix = schema.prefixItems.map(printType);
    if (schema.items !== false && schema.items !== undefined) {
      prefix.push(`...${postfixOperand(schema.items)}[]`);
    }
    return `[${prefix.join(", ")}]`;
  }

  const item = schema.items === undefined ? "any" : postfixOperand(schema.items);
  return printRefinements(`${item}[]`, schema);
}

function printFunction(schema: Record<string, JSONType>): string {
  const shape = schema.$fnType;
  if (!isObject(shape)) throw new Error("Cannot print malformed $fnType schema");
  const optional = Array.isArray(shape.optional) ? shape.optional : [];
  const required = Array.isArray(shape.required) ? shape.required : [];
  const params = required.map(printType);
  params.push(...optional.map((param) => `${printType(param)}?`));
  if (shape.rest !== undefined) params.push(`...${postfixOperand(shape.rest)}[]`);
  return `(${params.join(", ")}) -> ${printType(shape.returns ?? true)}`;
}

/** Print a schema emitted by TypeParser back into the tractable type syntax. */
export function printType(schema: Schema): string {
  if (schema === true) return "any";
  if (schema === false) return "never";
  if (!isObject(schema)) throw new Error(`Cannot print non-schema type ${JSON.stringify(schema)}`);

  if ("$ref" in schema) {
    return printRefinements(refName(schema.$ref), schema);
  }
  if ("$fnType" in schema) return printFunction(schema);
  if (isTaskType(schema)) return `Task<${printType(schema.$taskType!)}>`;
  if ("const" in schema) return literal(schema.const!);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(unionArm).join(" | ");
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => String(type)).join(" | ");
  }

  if (schema.type === "object") return printObject(schema);
  if (schema.type === "array") return printArray(schema);
  if (typeof schema.type === "string") {
    return printRefinements(schema.type, schema);
  }

  throw new Error(
    `Cannot print schema outside the shorthand type fragment: ${JSON.stringify(schema)}`,
  );
}
