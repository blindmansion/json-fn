import type { JSONType } from "./types";
import { exprError } from "./utils";

type NormalizedParam =
  | { kind: "required"; name: string; index: number }
  | { kind: "defaulted"; name: string; index: number; defaultExpression: JSONType }
  | { kind: "rest"; name: string; index: number }
  | { kind: "fields"; names: string[]; index: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      continue;
    }

    if (isObject(slot) && "$fields" in slot) {
      const fields = slot.$fields;
      if (
        !Array.isArray(fields) ||
        fields.length === 0 ||
        !fields.every((field) => typeof field === "string")
      ) {
        exprError(expression, "$fields must be a non-empty array of strings.");
      }
      const names = fields as string[];
      for (const name of names) addBoundName(name, boundNames, expression);
      normalized.push({ kind: "fields", names, index });
      continue;
    }

    exprError(
      expression,
      "$params entries must be strings, { $param, $default } descriptors, or { $fields: [...] } patterns.",
    );
  }

  return normalized;
}

export type { NormalizedParam };
