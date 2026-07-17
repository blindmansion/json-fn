import type { JSONType } from "./types";
import { exprError } from "./utils";

type NormalizedParam =
  | { kind: "required"; name: string; index: number }
  | { kind: "defaulted"; name: string; index: number; defaultExpression: JSONType }
  | { kind: "rest"; name: string; index: number }
  | { kind: "fields"; bindings: NormalizedFieldBinding[]; index: number };

type NormalizedFieldBinding =
  | { kind: "required"; name: string }
  | { kind: "defaulted"; name: string; defaultExpression: JSONType };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueKind(value: JSONType): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function addBoundName(name: string, boundNames: Set<string>, expression: JSONType): void {
  if (boundNames.has(name)) {
    exprError(expression, `Duplicate parameter binding "${name}".`);
  }
  boundNames.add(name);
}

/**
 * Validate and normalize the canonical `$params` representation. Keeping this
 * in one reader makes direct calls, registry calls, inline calls, and prepared
 * programs agree on descriptor and binding behavior.
 */
export function normalizeParams(params: unknown, expression: JSONType): NormalizedParam[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) {
    exprError(expression, "$params must be an array.");
  }

  const normalized: NormalizedParam[] = [];
  const boundNames = new Set<string>();
  let seenOmittable = false;

  for (let index = 0; index < params.length; index++) {
    const slot: unknown = params[index];

    if (typeof slot === "string") {
      if (slot.startsWith("...")) {
        const name = slot.slice(3);
        if (name.length === 0 || index !== params.length - 1) {
          exprError(
            expression,
            "A rest parameter must have a name and be the final $params entry.",
          );
        }
        addBoundName(name, boundNames, expression);
        normalized.push({ kind: "rest", name, index });
      } else {
        addBoundName(slot, boundNames, expression);
        if (seenOmittable) {
          exprError(
            expression,
            `Required positional parameters must precede defaulted parameters; named parameter "${slot}" at position ${index + 1} is required.`,
          );
        }
        normalized.push({ kind: "required", name: slot, index });
      }
      continue;
    }

    if (isObject(slot) && "$param" in slot) {
      const keys = Object.keys(slot);
      if (
        keys.length !== 2 ||
        !Object.prototype.hasOwnProperty.call(slot, "$default") ||
        typeof slot.$param !== "string" ||
        slot.$default === undefined
      ) {
        exprError(
          expression,
          "A defaulted parameter must contain exactly one string $param and a present $default.",
        );
      }
      if (slot.$param.startsWith("...")) {
        exprError(expression, "A defaulted parameter cannot be a rest parameter.");
      }
      addBoundName(slot.$param, boundNames, expression);
      normalized.push({
        kind: "defaulted",
        name: slot.$param,
        index,
        defaultExpression: slot.$default as JSONType,
      });
      seenOmittable = true;
      continue;
    }

    if (isObject(slot) && "$fields" in slot) {
      const fields = slot.$fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        exprError(
          expression,
          "$fields must be a non-empty array of strings or { $field, $default } descriptors.",
        );
      }
      const bindings: NormalizedFieldBinding[] = [];
      for (const field of fields) {
        if (typeof field === "string") {
          addBoundName(field, boundNames, expression);
          bindings.push({ kind: "required", name: field });
          continue;
        }
        if (isObject(field) && "$field" in field) {
          const keys = Object.keys(field);
          if (
            keys.length !== 2 ||
            !Object.prototype.hasOwnProperty.call(field, "$default") ||
            typeof field.$field !== "string" ||
            field.$default === undefined
          ) {
            exprError(
              expression,
              "A defaulted field must contain exactly one string $field and a present $default.",
            );
          }
          addBoundName(field.$field, boundNames, expression);
          bindings.push({
            kind: "defaulted",
            name: field.$field,
            defaultExpression: field.$default as JSONType,
          });
          continue;
        }
        exprError(
          expression,
          "$fields entries must be strings or { $field, $default } descriptors.",
        );
      }
      if (seenOmittable) {
        exprError(
          expression,
          `Required positional parameters must precede defaulted parameters; object pattern at position ${index + 1} is required.`,
        );
      }
      normalized.push({ kind: "fields", bindings, index });
      continue;
    }

    exprError(
      expression,
      "$params entries must be strings, { $param, $default } descriptors, or { $fields: [...] } patterns.",
    );
  }

  return normalized;
}

/**
 * Enforce JSON-function invocation semantics after descriptor normalization.
 * Presence is positional/own-property based so explicit null remains data.
 */
export function validateRuntimeArguments(params: NormalizedParam[], args: JSONType[]): void {
  const rest = params.at(-1)?.kind === "rest";
  const fixedCount = rest ? params.length - 1 : params.length;

  if (!rest && args.length > fixedCount) {
    throw new Error(
      `Expected exactly ${fixedCount} argument${fixedCount === 1 ? "" : "s"}, received ${args.length}.`,
    );
  }

  for (const slot of params) {
    if (slot.kind === "rest" || slot.kind === "defaulted") continue;

    const position = slot.index + 1;
    if (slot.index >= args.length) {
      if (slot.kind === "fields") {
        throw new Error(
          `Missing object-pattern argument at parameter position ${position}. Expected at least ${position} argument${position === 1 ? "" : "s"}, received ${args.length}.`,
        );
      }
      throw new Error(
        `Missing required argument at parameter position ${position}. Expected at least ${position} argument${position === 1 ? "" : "s"}, received ${args.length}.`,
      );
    }

    if (slot.kind !== "fields") continue;

    const value = args[slot.index]!;
    if (!isObject(value)) {
      throw new Error(
        `Object pattern at parameter position ${position} expected a plain object, received ${valueKind(value)}.`,
      );
    }

    for (const binding of slot.bindings) {
      if (
        binding.kind === "required" &&
        !Object.prototype.hasOwnProperty.call(value, binding.name)
      ) {
        throw new Error(
          `Missing required field "${binding.name}" in object pattern at parameter position ${position}.`,
        );
      }
    }
  }
}

export type { NormalizedFieldBinding, NormalizedParam };
