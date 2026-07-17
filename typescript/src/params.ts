import type { JSONType } from "./types";
import { exprError } from "./utils";

type ParameterPath = readonly (string | number)[];

type ParameterIssueCode =
  | "params-not-array"
  | "invalid-slot"
  | "invalid-param-name"
  | "invalid-param-descriptor"
  | "invalid-fields-pattern"
  | "invalid-field-name"
  | "invalid-field-descriptor"
  | "duplicate-binding"
  | "rest-not-final"
  | "required-after-omittable";

type ParameterIssue = {
  code: ParameterIssueCode;
  path: ParameterPath;
  message: string;
};

type NormalizedParameter =
  | { kind: "required"; name: string; index: number }
  | { kind: "optional"; name: string; index: number }
  | { kind: "defaulted"; name: string; index: number; defaultExpression: JSONType }
  | { kind: "rest"; name: string; index: number }
  | { kind: "fields"; bindings: NormalizedField[]; index: number };

type NormalizedField =
  | { kind: "required"; name: string; fieldIndex: number }
  | { kind: "optional"; name: string; fieldIndex: number }
  | {
      kind: "defaulted";
      name: string;
      fieldIndex: number;
      defaultExpression: JSONType;
    };

type ParameterLayout = {
  slots: readonly NormalizedParameter[];
  fixedCount: number;
  requiredCount: number;
  omittableCount: number;
  rest: Extract<NormalizedParameter, { kind: "rest" }> | null;
};

type ParameterAnalysis =
  | { ok: true; layout: ParameterLayout }
  | { ok: false; issue: ParameterIssue };

type DefaultBinding = {
  name: string;
  expression: JSONType;
  path: ParameterPath;
};

// Compatibility names used by the runtime until the stage-4 consumer
// migrations pass ParameterLayout directly.
type NormalizedParam = NormalizedParameter;
type NormalizedFieldBinding = NormalizedField;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueKind(value: JSONType): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(code: ParameterIssueCode, path: ParameterPath, message: string): ParameterAnalysis {
  return { ok: false, issue: { code, path, message } };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}

function addBoundName(
  name: string,
  path: ParameterPath,
  boundNames: Map<string, ParameterPath>,
): ParameterIssue | null {
  const earlierPath = boundNames.get(name);
  if (earlierPath !== undefined) {
    return {
      code: "duplicate-binding",
      path,
      message: `Duplicate parameter binding "${name}"; first declared at ${formatParameterPath(earlierPath)}.`,
    };
  }
  boundNames.set(name, path);
  return null;
}

/**
 * Analyze the canonical `$params` representation without throwing. The first
 * issue is returned in canonical left-to-right traversal order.
 */
export function analyzeParameters(params: unknown): ParameterAnalysis {
  if (params === undefined) {
    return {
      ok: true,
      layout: {
        slots: [],
        fixedCount: 0,
        requiredCount: 0,
        omittableCount: 0,
        rest: null,
      },
    };
  }
  if (!Array.isArray(params)) {
    return issue("params-not-array", [], "$params must be an array.");
  }

  const slots: NormalizedParameter[] = [];
  const boundNames = new Map<string, ParameterPath>();
  let seenOmittable = false;
  let requiredCount = 0;
  let omittableCount = 0;
  let rest: Extract<NormalizedParameter, { kind: "rest" }> | null = null;

  for (let index = 0; index < params.length; index++) {
    const slot: unknown = params[index];
    const slotPath: ParameterPath = [index];

    if (typeof slot === "string") {
      if (slot.startsWith("...")) {
        const name = slot.slice(3);
        if (name.length === 0) {
          return issue(
            "invalid-param-name",
            slotPath,
            "A rest parameter must have a non-empty name.",
          );
        }
        if (index !== params.length - 1) {
          return issue(
            "rest-not-final",
            slotPath,
            "A rest parameter must have a name and be the final $params entry.",
          );
        }
        const duplicate = addBoundName(name, slotPath, boundNames);
        if (duplicate !== null) return { ok: false, issue: duplicate };
        rest = { kind: "rest", name, index };
        slots.push(rest);
      } else {
        const duplicate = addBoundName(slot, slotPath, boundNames);
        if (duplicate !== null) return { ok: false, issue: duplicate };
        if (seenOmittable) {
          return issue(
            "required-after-omittable",
            slotPath,
            `Required positional parameters must precede defaulted parameters; named parameter "${slot}" at position ${index + 1} is required. Optional parameters are omittable as well.`,
          );
        }
        slots.push({ kind: "required", name: slot, index });
        requiredCount++;
      }
      continue;
    }

    if (isObject(slot) && "$param" in slot) {
      const isDefaulted = hasExactKeys(slot, ["$param", "$default"]);
      const isOptional = hasExactKeys(slot, ["$param", "$optional"]);
      if (!isDefaulted && !isOptional) {
        return issue(
          "invalid-param-descriptor",
          slotPath,
          "A defaulted parameter must contain exactly one string $param and a present $default; an optional parameter must contain exactly $param and $optional: true.",
        );
      }
      if (typeof slot.$param !== "string") {
        return issue("invalid-param-name", [index, "$param"], "Expected a string parameter name.");
      }
      if (slot.$param.startsWith("...")) {
        return issue(
          "invalid-param-name",
          [index, "$param"],
          "A parameter descriptor cannot encode a rest parameter.",
        );
      }
      if (isDefaulted && slot.$default === undefined) {
        return issue(
          "invalid-param-descriptor",
          [index, "$default"],
          "A default expression must be present and cannot be undefined.",
        );
      }
      if (isOptional && slot.$optional !== true) {
        return issue("invalid-param-descriptor", [index, "$optional"], "$optional must be true.");
      }
      const duplicate = addBoundName(slot.$param, [index, "$param"], boundNames);
      if (duplicate !== null) return { ok: false, issue: duplicate };
      if (isDefaulted) {
        slots.push({
          kind: "defaulted",
          name: slot.$param,
          index,
          defaultExpression: slot.$default as JSONType,
        });
      } else {
        slots.push({ kind: "optional", name: slot.$param, index });
      }
      seenOmittable = true;
      omittableCount++;
      continue;
    }

    if (isObject(slot) && "$fields" in slot) {
      if (!hasExactKeys(slot, ["$fields"])) {
        return issue(
          "invalid-fields-pattern",
          slotPath,
          "An object parameter pattern must contain exactly $fields.",
        );
      }
      const fields = slot.$fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        return issue(
          "invalid-fields-pattern",
          [index, "$fields"],
          "$fields must be a non-empty array of strings or { $field, $default } descriptors.",
        );
      }
      const bindings: NormalizedField[] = [];
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
        const field: unknown = fields[fieldIndex];
        const fieldPath: ParameterPath = [index, "$fields", fieldIndex];
        if (typeof field === "string") {
          const duplicate = addBoundName(field, fieldPath, boundNames);
          if (duplicate !== null) return { ok: false, issue: duplicate };
          bindings.push({ kind: "required", name: field, fieldIndex });
          continue;
        }
        if (isObject(field) && "$field" in field) {
          const isDefaulted = hasExactKeys(field, ["$field", "$default"]);
          const isOptional = hasExactKeys(field, ["$field", "$optional"]);
          if (!isDefaulted && !isOptional) {
            return issue(
              "invalid-field-descriptor",
              fieldPath,
              "A field descriptor must contain exactly $field and either $default or $optional.",
            );
          }
          if (typeof field.$field !== "string") {
            return issue(
              "invalid-field-name",
              [...fieldPath, "$field"],
              "Expected a string field name.",
            );
          }
          if (field.$field.startsWith("...")) {
            return issue(
              "invalid-field-name",
              [...fieldPath, "$field"],
              "A field descriptor cannot encode a rest parameter.",
            );
          }
          if (isDefaulted && field.$default === undefined) {
            return issue(
              "invalid-field-descriptor",
              [...fieldPath, "$default"],
              "A default expression must be present and cannot be undefined.",
            );
          }
          if (isOptional && field.$optional !== true) {
            return issue(
              "invalid-field-descriptor",
              [...fieldPath, "$optional"],
              "$optional must be true.",
            );
          }
          const duplicate = addBoundName(field.$field, [...fieldPath, "$field"], boundNames);
          if (duplicate !== null) return { ok: false, issue: duplicate };
          if (isDefaulted) {
            bindings.push({
              kind: "defaulted",
              name: field.$field,
              fieldIndex,
              defaultExpression: field.$default as JSONType,
            });
          } else {
            bindings.push({ kind: "optional", name: field.$field, fieldIndex });
          }
          continue;
        }
        return issue(
          "invalid-field-descriptor",
          fieldPath,
          "$fields entries must be strings or { $field, $default } descriptors.",
        );
      }
      if (seenOmittable) {
        return issue(
          "required-after-omittable",
          slotPath,
          `Required positional parameters must precede defaulted parameters; object pattern at position ${index + 1} is required. Optional parameters are omittable as well.`,
        );
      }
      slots.push({ kind: "fields", bindings, index });
      requiredCount++;
      continue;
    }

    return issue(
      "invalid-slot",
      slotPath,
      "$params entries must be strings, { $param, $default } descriptors, or { $fields: [...] } patterns.",
    );
  }

  return {
    ok: true,
    layout: {
      slots,
      fixedCount: slots.length - (rest === null ? 0 : 1),
      requiredCount,
      omittableCount,
      rest,
    },
  };
}

export function formatParameterPath(path: ParameterPath): string {
  let formatted = "$params";
  for (const segment of path) {
    formatted += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return formatted;
}

export function formatParameterIssue(parameterIssue: ParameterIssue): string {
  return `${formatParameterPath(parameterIssue.path)}: ${parameterIssue.message}`;
}

export function boundParameterNames(layout: ParameterLayout): readonly string[] {
  const names: string[] = [];
  for (const slot of layout.slots) {
    if (slot.kind === "fields") {
      for (const binding of slot.bindings) names.push(binding.name);
    } else {
      names.push(slot.name);
    }
  }
  return names;
}

export function defaultBindings(layout: ParameterLayout): readonly DefaultBinding[] {
  const defaults: DefaultBinding[] = [];
  for (const slot of layout.slots) {
    if (slot.kind === "defaulted") {
      defaults.push({
        name: slot.name,
        expression: slot.defaultExpression,
        path: [slot.index, "$default"],
      });
      continue;
    }
    if (slot.kind !== "fields") continue;
    for (const binding of slot.bindings) {
      if (binding.kind !== "defaulted") continue;
      defaults.push({
        name: binding.name,
        expression: binding.defaultExpression,
        path: [slot.index, "$fields", binding.fieldIndex, "$default"],
      });
    }
  }
  return defaults;
}

export function requireParameterLayout(params: unknown, expression: JSONType): ParameterLayout {
  const analysis = analyzeParameters(params);
  if (!analysis.ok) {
    exprError(expression, formatParameterIssue(analysis.issue));
  }
  return analysis.layout;
}

/**
 * Temporary adapter for consumers migrated in later stage-4 steps.
 */
export function normalizeParams(params: unknown, expression: JSONType): NormalizedParam[] {
  return [...requireParameterLayout(params, expression).slots];
}

/**
 * Enforce JSON-function invocation semantics after descriptor normalization.
 * Presence is positional/own-property based so explicit null remains data.
 */
export function validateRuntimeArguments(layout: ParameterLayout, args: JSONType[]): void {
  if (layout.rest === null && args.length > layout.fixedCount) {
    throw new Error(
      `Expected exactly ${layout.fixedCount} argument${layout.fixedCount === 1 ? "" : "s"}, received ${args.length}.`,
    );
  }

  for (const slot of layout.slots) {
    if (slot.kind === "rest" || slot.kind === "defaulted" || slot.kind === "optional") continue;

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

export type {
  DefaultBinding,
  NormalizedField,
  NormalizedFieldBinding,
  NormalizedParam,
  NormalizedParameter,
  ParameterAnalysis,
  ParameterIssue,
  ParameterIssueCode,
  ParameterLayout,
  ParameterPath,
};
