import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renderBuiltinSignature } from "../src/builtin-signature-format";
import type { CallableSignature } from "../src/check/builtin-types";

type BuiltinDocEntry = {
  name: string;
  description: string;
  signatures: CallableSignature[];
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const inputPath = join(root, "spec/builtins.json");
const outputPath = join(root, "docs/builtins/builtins.md");
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
    entries.push({ name, description, signatures: signatures as CallableSignature[] });
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

function renderTable(entries: BuiltinDocEntry[]): string {
  const rows = entries.map(({ name, description, signatures }) => [
    `\`${escapeCell(name)}\``,
    signatures
      .map((signature) => `\`${escapeCell(renderBuiltinSignature(signature))}\``)
      .join("<br>"),
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

<!-- Generated file. Do not edit directly. -->

This reference is generated from the descriptions, categories, and portable type
signatures in
[\`spec/builtins.json\`](../../spec/builtins.json).

Signatures use \`T?\` for optional parameters and \`...T[]\` for variadic
parameters. Builtins backed by implementation-specific type rules may be checked
more precisely than their portable signatures indicate.

${sections.join("\n\n")}
`;

await writeFile(outputPath, document);
console.log(`Generated ${outputPath}`);
