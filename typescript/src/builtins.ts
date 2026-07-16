// Loader for the canonical, language-agnostic builtin signature table
// (`spec/builtins.json`). The table is the shared source of truth for builtin
// types across implementations; the TypeScript checker's Section F reads it via
// `CheckContext.builtins`. See docs/builtin-signatures.md for the format.
//
// For now this reads the JSON off disk at runtime, mirroring how the spec-case
// harness loads `spec/cases`. Bundling / codegen is a later concern.

import { readFileSync } from "fs";
import { join } from "path";
import type { CallableSignature, CallableTable } from "./check/builtin-types";
import type { Schema } from "./check/schema";

const DEFAULT_PATH = join(import.meta.dir, "../../spec/builtins.json");

export class CallableTableValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CallableTableValidationError";
  }
}

type SchemaValidation = {
  defs: Set<string>;
  declaredTVars: Set<string> | null;
  usedTVars: Set<string>;
};

const PRIMITIVE_TYPES = new Set(["null", "boolean", "number", "integer", "string"]);
const SCHEMA_HEADS = new Set(["$tvar", "$ref", "$fnType", "const", "enum", "anyOf", "type"]);

function fail(path: string, message: string): never {
  throw new CallableTableValidationError(path, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, "expected an object");
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported field");
  }
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "expected a non-negative integer");
  }
}

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number");
  }
}

function validateBounds(value: Record<string, unknown>, path: string): void {
  if ("minItems" in value) assertNonNegativeInteger(value.minItems, `${path}.minItems`);
  if ("maxItems" in value) assertNonNegativeInteger(value.maxItems, `${path}.maxItems`);
  if (
    typeof value.minItems === "number" &&
    typeof value.maxItems === "number" &&
    value.minItems > value.maxItems
  ) {
    fail(path, "minItems cannot exceed maxItems");
  }
}

function validateSchema(
  value: unknown,
  path: string,
  state: SchemaValidation,
): asserts value is Schema {
  if (value === true || value === false) return;
  const schema = assertObject(value, path);
  const heads = Object.keys(schema).filter((key) => SCHEMA_HEADS.has(key));
  if (heads.length !== 1) {
    fail(path, `expected exactly one schema form, found ${heads.length}`);
  }

  const head = heads[0]!;
  if (head === "$tvar") {
    assertOnlyKeys(schema, new Set(["$tvar"]), path);
    const name = schema.$tvar;
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`${path}.$tvar`, "expected a valid type-variable name");
    }
    if (state.declaredTVars === null) {
      fail(path, "type variables are not allowed in definitions");
    }
    if (!state.declaredTVars.has(name)) {
      fail(`${path}.$tvar`, `undeclared type variable "${name}"`);
    }
    state.usedTVars.add(name);
    return;
  }

  if (head === "$ref") {
    assertOnlyKeys(schema, new Set(["$ref"]), path);
    if (typeof schema.$ref !== "string") fail(`${path}.$ref`, "expected a string");
    const match = /^#\/\$defs\/([^/]+)$/.exec(schema.$ref);
    if (match === null) fail(`${path}.$ref`, 'expected the form "#/$defs/Name"');
    const name = match[1]!;
    if (!state.defs.has(name)) fail(`${path}.$ref`, `references undefined type "${name}"`);
    return;
  }

  if (head === "$fnType") {
    assertOnlyKeys(schema, new Set(["$fnType"]), path);
    const fn = assertObject(schema.$fnType, `${path}.$fnType`);
    assertOnlyKeys(fn, new Set(["params", "rest", "returns"]), `${path}.$fnType`);
    if (!Array.isArray(fn.params)) fail(`${path}.$fnType.params`, "expected an array");
    if (!("returns" in fn)) fail(`${path}.$fnType.returns`, "field is required");
    for (let i = 0; i < fn.params.length; i++) {
      validateSchema(fn.params[i], `${path}.$fnType.params[${i}]`, state);
    }
    if ("rest" in fn) validateSchema(fn.rest, `${path}.$fnType.rest`, state);
    validateSchema(fn.returns, `${path}.$fnType.returns`, state);
    return;
  }

  if (head === "const") {
    assertOnlyKeys(schema, new Set(["const"]), path);
    return;
  }

  if (head === "enum") {
    assertOnlyKeys(schema, new Set(["enum"]), path);
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      fail(`${path}.enum`, "expected a non-empty array");
    }
    return;
  }

  if (head === "anyOf") {
    assertOnlyKeys(schema, new Set(["anyOf"]), path);
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      fail(`${path}.anyOf`, "expected a non-empty array");
    }
    for (let i = 0; i < schema.anyOf.length; i++) {
      validateSchema(schema.anyOf[i], `${path}.anyOf[${i}]`, state);
    }
    return;
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    assertOnlyKeys(schema, new Set(["type"]), path);
    if (type.length === 0) fail(`${path}.type`, "expected a non-empty type union");
    const seen = new Set<string>();
    for (let i = 0; i < type.length; i++) {
      const arm = type[i];
      if (typeof arm !== "string" || !PRIMITIVE_TYPES.has(arm)) {
        fail(`${path}.type[${i}]`, "expected a primitive type name");
      }
      if (seen.has(arm)) fail(`${path}.type[${i}]`, `duplicate type "${arm}"`);
      seen.add(arm);
    }
    return;
  }
  if (typeof type !== "string") fail(`${path}.type`, "expected a type name");

  if (PRIMITIVE_TYPES.has(type)) {
    const numeric = new Set([
      "type",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ]);
    const string = new Set(["type", "minLength", "maxLength", "pattern", "format"]);
    const allowed =
      type === "number" || type === "integer"
        ? numeric
        : type === "string"
          ? string
          : new Set(["type"]);
    assertOnlyKeys(schema, allowed, path);

    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
      if (key in schema) assertFiniteNumber(schema[key], `${path}.${key}`);
    }
    if ("multipleOf" in schema) {
      assertFiniteNumber(schema.multipleOf, `${path}.multipleOf`);
      if ((schema.multipleOf as number) <= 0)
        fail(`${path}.multipleOf`, "must be greater than zero");
    }
    if ("minLength" in schema) assertNonNegativeInteger(schema.minLength, `${path}.minLength`);
    if ("maxLength" in schema) assertNonNegativeInteger(schema.maxLength, `${path}.maxLength`);
    if (
      typeof schema.minLength === "number" &&
      typeof schema.maxLength === "number" &&
      schema.minLength > schema.maxLength
    ) {
      fail(path, "minLength cannot exceed maxLength");
    }
    if ("pattern" in schema) {
      if (typeof schema.pattern !== "string") fail(`${path}.pattern`, "expected a string");
      try {
        new RegExp(schema.pattern);
      } catch {
        fail(`${path}.pattern`, "expected a valid regular expression");
      }
    }
    if ("format" in schema && typeof schema.format !== "string") {
      fail(`${path}.format`, "expected a string");
    }
    return;
  }

  if (type === "array") {
    assertOnlyKeys(
      schema,
      new Set(["type", "items", "prefixItems", "minItems", "maxItems", "uniqueItems"]),
      path,
    );
    if ("items" in schema) validateSchema(schema.items, `${path}.items`, state);
    if ("prefixItems" in schema) {
      if (!Array.isArray(schema.prefixItems)) fail(`${path}.prefixItems`, "expected an array");
      for (let i = 0; i < schema.prefixItems.length; i++) {
        validateSchema(schema.prefixItems[i], `${path}.prefixItems[${i}]`, state);
      }
    }
    validateBounds(schema, path);
    if ("uniqueItems" in schema && schema.uniqueItems !== true) {
      fail(`${path}.uniqueItems`, "only true is supported");
    }
    return;
  }

  if (type === "object") {
    assertOnlyKeys(
      schema,
      new Set(["type", "properties", "required", "additionalProperties"]),
      path,
    );
    let propertyNames = new Set<string>();
    if ("properties" in schema) {
      const properties = assertObject(schema.properties, `${path}.properties`);
      propertyNames = new Set(Object.keys(properties));
      for (const [name, property] of Object.entries(properties)) {
        validateSchema(property, `${path}.properties.${name}`, state);
      }
    }
    if ("required" in schema) {
      if (!Array.isArray(schema.required)) fail(`${path}.required`, "expected an array");
      const seen = new Set<string>();
      for (let i = 0; i < schema.required.length; i++) {
        const name = schema.required[i];
        if (typeof name !== "string") fail(`${path}.required[${i}]`, "expected a string");
        if (seen.has(name)) fail(`${path}.required[${i}]`, `duplicate property "${name}"`);
        if (!propertyNames.has(name)) {
          fail(`${path}.required[${i}]`, `unknown property "${name}"`);
        }
        seen.add(name);
      }
    }
    if (
      "additionalProperties" in schema &&
      schema.additionalProperties !== true &&
      schema.additionalProperties !== false
    ) {
      validateSchema(schema.additionalProperties, `${path}.additionalProperties`, state);
    }
    return;
  }

  fail(`${path}.type`, `unsupported type "${type}"`);
}

function validateSignature(
  value: unknown,
  path: string,
  defs: Set<string>,
): asserts value is CallableSignature {
  const sig = assertObject(value, path);
  assertOnlyKeys(sig, new Set(["typeParams", "params", "rest", "returns"]), path);
  if (!Array.isArray(sig.params)) fail(`${path}.params`, "expected an array");
  if (!("returns" in sig)) fail(`${path}.returns`, "field is required");

  const declared = new Set<string>();
  if ("typeParams" in sig) {
    if (!Array.isArray(sig.typeParams)) fail(`${path}.typeParams`, "expected an array");
    for (let i = 0; i < sig.typeParams.length; i++) {
      const name = sig.typeParams[i];
      if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        fail(`${path}.typeParams[${i}]`, "expected a valid type-variable name");
      }
      if (declared.has(name))
        fail(`${path}.typeParams[${i}]`, `duplicate type parameter "${name}"`);
      declared.add(name);
    }
  }

  const state: SchemaValidation = { defs, declaredTVars: declared, usedTVars: new Set() };
  for (let i = 0; i < sig.params.length; i++) {
    validateSchema(sig.params[i], `${path}.params[${i}]`, state);
  }
  if ("rest" in sig) validateSchema(sig.rest, `${path}.rest`, state);
  validateSchema(sig.returns, `${path}.returns`, state);
  for (const name of declared) {
    if (!state.usedTVars.has(name)) {
      fail(`${path}.typeParams`, `declared type parameter "${name}" is not used`);
    }
  }
}

export function validateCallableTable(value: unknown): asserts value is CallableTable {
  const table = assertObject(value, "table");
  assertOnlyKeys(table, new Set(["description", "$defs", "builtins"]), "table");
  if ("description" in table && typeof table.description !== "string") {
    fail("table.description", "expected a string");
  }

  const rawDefs = "$defs" in table ? assertObject(table.$defs, "table.$defs") : {};
  const defs = new Set(Object.keys(rawDefs));
  for (const [name, schema] of Object.entries(rawDefs)) {
    if (name.length === 0 || name.includes("/"))
      fail(`table.$defs.${name}`, "invalid definition name");
    validateSchema(schema, `table.$defs.${name}`, {
      defs,
      declaredTVars: null,
      usedTVars: new Set(),
    });
  }

  const builtins = assertObject(table.builtins, "table.builtins");
  for (const [name, entry] of Object.entries(builtins)) {
    const path = `table.builtins.${name}`;
    if (name.length === 0) fail(path, "builtin name cannot be empty");
    const contract = assertObject(entry, path);
    assertOnlyKeys(contract, new Set(["signatures", "rule"]), path);
    if (!Array.isArray(contract.signatures)) fail(`${path}.signatures`, "expected an array");
    if (contract.signatures.length === 0) {
      fail(`${path}.signatures`, "fallback signature set cannot be empty");
    }
    for (let i = 0; i < contract.signatures.length; i++) {
      validateSignature(contract.signatures[i], `${path}.signatures[${i}]`, defs);
    }
    if (
      "rule" in contract &&
      (typeof contract.rule !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(contract.rule))
    ) {
      fail(`${path}.rule`, "expected a namespaced rule identifier");
    }
  }
}

export function loadBuiltinTable(path: string = DEFAULT_PATH): CallableTable {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  validateCallableTable(parsed);
  return parsed;
}
