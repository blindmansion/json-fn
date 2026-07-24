import { isFunctionBody, isFunctionDeclaration } from "./function-value";
import { analyzeParameters, formatParameterIssue, type ParameterIssue } from "./params";

const FUNCTION_BODY_SOURCE_FIELDS: ReadonlySet<string> = new Set([
  "$return",
  "$params",
  "$sig",
  "$comment",
]);
const FUNCTION_BODY_RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  "$captures",
  "$runtimeContract",
]);
const FUNCTION_BODY_FIELDS: ReadonlySet<string> = new Set([
  ...FUNCTION_BODY_SOURCE_FIELDS,
  ...FUNCTION_BODY_RUNTIME_FIELDS,
]);

type FunctionBodyStructureIssue =
  | { code: "not-object" | "missing-return"; path: [] }
  | { code: "unsupported-field"; path: [string]; field: string }
  | { code: "invalid-comment"; path: ["$comment"] }
  | { code: "invalid-params"; path: ["$params", ...(string | number)[]]; issue: ParameterIssue }
  | { code: "invalid-captures"; path: ["$captures"] }
  | { code: "invalid-capture"; path: ["$captures", string]; name: string }
  | { code: "invalid-runtime-contract"; path: ["$runtimeContract"] };

type FunctionBodyStructureAnalysis =
  | { ok: true; issues: [] }
  | { ok: false; issues: FunctionBodyStructureIssue[] };

function formatFunctionBodyStructureIssue(issue: FunctionBodyStructureIssue): string {
  switch (issue.code) {
    case "not-object":
      return "Function body must be a non-null object.";
    case "missing-return":
      return "Function body must have a $return property.";
    case "unsupported-field":
      return `Function body field "${issue.field}" is not supported.`;
    case "invalid-comment":
      return "Function body $comment must be a string.";
    case "invalid-params":
      return formatParameterIssue(issue.issue);
    case "invalid-captures":
      return "Function $captures must be a non-null object of function bodies.";
    case "invalid-capture":
      return `Function capture "${issue.name}" must be a function body.`;
    case "invalid-runtime-contract":
      return "Function $runtimeContract is malformed.";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Whether evaluator-owned function contract state satisfies its reader. */
function isReadableRuntimeFunctionContract(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOwn(value, "schema") &&
    isObject(value.defs) &&
    hasOwn(value, "target") &&
    isFunctionDeclaration(value.target)
  );
}

/**
 * Analyze a canonical function body without throwing. Recognition remains
 * deliberately separate: objects containing `$return` are body-shaped even
 * when this analysis reports malformed or unsupported fields.
 */
function analyzeFunctionBodyStructure(value: unknown): FunctionBodyStructureAnalysis {
  if (!isObject(value)) return { ok: false, issues: [{ code: "not-object", path: [] }] };

  const issues: FunctionBodyStructureIssue[] = [];
  if (!hasOwn(value, "$return")) issues.push({ code: "missing-return", path: [] });

  for (const field of Object.keys(value)) {
    if (!FUNCTION_BODY_FIELDS.has(field)) {
      issues.push({ code: "unsupported-field", path: [field], field });
    }
  }

  if (hasOwn(value, "$comment") && typeof value.$comment !== "string") {
    issues.push({ code: "invalid-comment", path: ["$comment"] });
  }

  const params = analyzeParameters(value.$params);
  if (!params.ok) {
    issues.push({
      code: "invalid-params",
      path: ["$params", ...params.issue.path],
      issue: params.issue,
    });
  }

  if (hasOwn(value, "$captures")) {
    if (!isObject(value.$captures)) {
      issues.push({ code: "invalid-captures", path: ["$captures"] });
    } else {
      for (const [name, capture] of Object.entries(value.$captures)) {
        if (!isFunctionBody(capture)) {
          issues.push({ code: "invalid-capture", path: ["$captures", name], name });
        }
      }
    }
  }

  if (
    hasOwn(value, "$runtimeContract") &&
    !isReadableRuntimeFunctionContract(value.$runtimeContract)
  ) {
    issues.push({ code: "invalid-runtime-contract", path: ["$runtimeContract"] });
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

export {
  FUNCTION_BODY_FIELDS,
  FUNCTION_BODY_RUNTIME_FIELDS,
  FUNCTION_BODY_SOURCE_FIELDS,
  analyzeFunctionBodyStructure,
  formatFunctionBodyStructureIssue,
  isReadableRuntimeFunctionContract,
};
export type { FunctionBodyStructureAnalysis, FunctionBodyStructureIssue };
