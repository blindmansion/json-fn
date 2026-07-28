import type { CallableSignature } from "./check/builtin-types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderFunctionShape(value: unknown): string {
  if (!isObject(value)) throw new Error("Expected a function type shape");
  const required = value.required;
  const optional = value.optional;
  if (!Array.isArray(required) || !Array.isArray(optional) || !("returns" in value)) {
    throw new Error("Expected required, optional, and returns in a function type");
  }

  const parameters = [
    ...required.map(renderBuiltinSchema),
    ...optional.map((schema) => `${renderBuiltinSchema(schema)}?`),
  ];
  if ("rest" in value) parameters.push(`...${renderBuiltinSchema(value.rest)}[]`);
  return `(${parameters.join(", ")}) → ${renderBuiltinSchema(value.returns)}`;
}

function renderObject(schema: Record<string, unknown>): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(
    ([name, value]) =>
      `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${renderBuiltinSchema(value)}`,
  );

  if (schema.additionalProperties === true) fields.push("[key: string]: any");
  else if (
    "additionalProperties" in schema &&
    schema.additionalProperties !== false &&
    schema.additionalProperties !== undefined
  ) {
    fields.push(`[key: string]: ${renderBuiltinSchema(schema.additionalProperties)}`);
  }

  if (fields.length === 0) return "object";
  if (
    Object.keys(properties).length === 0 &&
    "additionalProperties" in schema &&
    schema.additionalProperties !== true &&
    schema.additionalProperties !== false
  ) {
    return `Record<string, ${renderBuiltinSchema(schema.additionalProperties)}>`;
  }
  return `{ ${fields.join("; ")} }`;
}

function renderArray(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.prefixItems)) {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    const items = schema.prefixItems.map(
      (item, index) => `${renderBuiltinSchema(item)}${index < minimum ? "" : "?"}`,
    );
    if ("items" in schema && schema.items !== false) {
      items.push(`...${renderBuiltinSchema(schema.items)}[]`);
    }
    return `[${items.join(", ")}]`;
  }

  const item = "items" in schema ? renderBuiltinSchema(schema.items) : "any";
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item) ? `${item}[]` : `Array<${item}>`;
}

export function renderBuiltinSchema(value: unknown): string {
  if (value === true) return "any";
  if (value === false) return "never";
  if (!isObject(value)) throw new Error("Expected a schema");

  if (typeof value.$tvar === "string") return value.$tvar;
  if (typeof value.$ref === "string") return value.$ref.replace(/^#\/\$defs\//, "");
  if ("$fnType" in value) return renderFunctionShape(value.$fnType);
  if ("const" in value) return JSON.stringify(value.const);
  if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (Array.isArray(value.anyOf)) return value.anyOf.map(renderBuiltinSchema).join(" | ");
  if (Array.isArray(value.type)) return value.type.join(" | ");
  if (value.type === "array") return renderArray(value);
  if (value.type === "object") return renderObject(value);
  if (typeof value.type === "string") return value.type;

  throw new Error(`Unsupported schema: ${JSON.stringify(value)}`);
}

export function renderBuiltinSignature(signature: CallableSignature): string {
  const typeParams =
    signature.typeParams === undefined ? "" : `<${signature.typeParams.join(", ")}>`;
  return `${typeParams}${renderFunctionShape(signature)}`;
}
