import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type BuiltinDocEntry = {
  name: string;
  description: string;
  signatures: Signature[];
};

type Signature = {
  typeParams?: string[];
  required: unknown[];
  optional: unknown[];
  rest?: unknown;
  returns: unknown;
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const inputPath = join(root, "spec/builtins.json");
const outputPath = join(root, "docs/builtins.md");
const categoryTitles: Record<string, string> = {
  "type-checking": "Type Checking",
  coercion: "Type Coercion",
  "higher-order": "Higher-Order Functions",
  "tasks-effects": "Tasks & Effects",
};

function readMetadata(value: unknown): Map<string, BuiltinDocEntry[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected the builtin table to be an object");
  }

  const builtins = Reflect.get(value, "builtins");
  if (typeof builtins !== "object" || builtins === null || Array.isArray(builtins)) {
    throw new Error("Expected builtins to be an object");
  }

  const categories = new Map<string, BuiltinDocEntry[]>();
  for (const [name, value] of Object.entries(builtins)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Expected builtin ${name} to be an object`);
    }

    const description = Reflect.get(value, "description");
    const category = Reflect.get(value, "category");
    const signatures = Reflect.get(value, "signatures");
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`Expected builtin ${name} to have a non-empty description`);
    }
    if (typeof category !== "string" || category.length === 0) {
      throw new Error(`Expected builtin ${name} to have a non-empty category`);
    }
    if (!Array.isArray(signatures) || signatures.length === 0) {
      throw new Error(`Expected builtin ${name} to have signatures`);
    }

    const entries = categories.get(category) ?? [];
    entries.push({ name, description, signatures: signatures as Signature[] });
    categories.set(category, entries);
  }

  return categories;
}

function titleCase(value: string): string {
  const title = categoryTitles[value];
  if (title !== undefined) return title;

  return value
    .split("-")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

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
    ...required.map(renderSchema),
    ...optional.map((schema) => `${renderSchema(schema)}?`),
  ];
  if ("rest" in value) parameters.push(`...${renderSchema(value.rest)}[]`);
  return `(${parameters.join(", ")}) → ${renderSchema(value.returns)}`;
}

function renderObject(schema: Record<string, unknown>): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(
    ([name, value]) =>
      `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value)}`,
  );

  if (schema.additionalProperties === true) fields.push("[key: string]: any");
  else if (
    "additionalProperties" in schema &&
    schema.additionalProperties !== false &&
    schema.additionalProperties !== undefined
  ) {
    fields.push(`[key: string]: ${renderSchema(schema.additionalProperties)}`);
  }

  if (fields.length === 0) return "object";
  if (
    Object.keys(properties).length === 0 &&
    "additionalProperties" in schema &&
    schema.additionalProperties !== true &&
    schema.additionalProperties !== false
  ) {
    return `Record<string, ${renderSchema(schema.additionalProperties)}>`;
  }
  return `{ ${fields.join("; ")} }`;
}

function renderArray(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.prefixItems)) {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 0;
    const items = schema.prefixItems.map(
      (item, index) => `${renderSchema(item)}${index < minimum ? "" : "?"}`,
    );
    if ("items" in schema && schema.items !== false) {
      items.push(`...${renderSchema(schema.items)}[]`);
    }
    return `[${items.join(", ")}]`;
  }

  const item = "items" in schema ? renderSchema(schema.items) : "any";
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item) ? `${item}[]` : `Array<${item}>`;
}

function renderSchema(value: unknown): string {
  if (value === true) return "any";
  if (value === false) return "never";
  if (!isObject(value)) throw new Error("Expected a schema");

  if (typeof value.$tvar === "string") return value.$tvar;
  if (typeof value.$ref === "string") return value.$ref.replace(/^#\/\$defs\//, "");
  if ("$fnType" in value) return renderFunctionShape(value.$fnType);
  if ("const" in value) return JSON.stringify(value.const);
  if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (Array.isArray(value.anyOf)) return value.anyOf.map(renderSchema).join(" | ");
  if (Array.isArray(value.type)) return value.type.join(" | ");
  if (value.type === "array") return renderArray(value);
  if (value.type === "object") return renderObject(value);
  if (typeof value.type === "string") return value.type;

  throw new Error(`Unsupported schema: ${JSON.stringify(value)}`);
}

function renderSignature(signature: Signature): string {
  const typeParams =
    signature.typeParams === undefined ? "" : `<${signature.typeParams.join(", ")}>`;
  return `${typeParams}${renderFunctionShape(signature)}`;
}

function renderTable(entries: BuiltinDocEntry[]): string {
  const rows = entries.map(({ name, description, signatures }) => [
    `\`${escapeCell(name)}\``,
    signatures.map((signature) => `\`${escapeCell(renderSignature(signature))}\``).join("<br>"),
    escapeCell(description),
  ]);
  const functionWidth = Math.max("Function".length, ...rows.map(([name]) => name!.length));
  const signatureWidth = Math.max(
    "Signature".length,
    ...rows.map(([, signature]) => signature!.length),
  );
  const descriptionWidth = Math.max(
    "Description".length,
    ...rows.map(([, , description]) => description!.length),
  );

  return [
    `| ${"Function".padEnd(functionWidth)} | ${"Signature".padEnd(signatureWidth)} | ${"Description".padEnd(descriptionWidth)} |`,
    `| ${"-".repeat(functionWidth)} | ${"-".repeat(signatureWidth)} | ${"-".repeat(descriptionWidth)} |`,
    ...rows.map(
      ([name, signature, description]) =>
        `| ${name!.padEnd(functionWidth)} | ${signature!.padEnd(signatureWidth)} | ${description!.padEnd(descriptionWidth)} |`,
    ),
  ].join("\n");
}

const source = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
const categories = readMetadata(source);
const sections = [...categories].map(
  ([category, entries]) => `## ${titleCase(category)}\n\n${renderTable(entries)}`,
);
const document = `# Builtins

<!-- Generated by typescript/scripts/generate-builtin-doc.ts. Do not edit directly. -->

This reference is generated from the descriptions, categories, and portable type
signatures in
[\`spec/builtins.json\`](../spec/builtins.json).

Signatures use \`T?\` for optional parameters and \`...T[]\` for variadic
parameters. Builtins backed by implementation-specific type rules may be checked
more precisely than their portable signatures indicate.

${sections.join("\n\n")}
`;

await writeFile(outputPath, document);
console.log(`Generated ${outputPath}`);
