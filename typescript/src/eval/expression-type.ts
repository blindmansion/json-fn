import type { JSONType, PerfStats } from "../types";
import { ExpressionType } from "../types";
import { exprError } from "../expression-error";
import {
  analyzeFunctionBodyStructure,
  formatFunctionBodyStructureIssue,
} from "../function-body-structure";
import { isFunctionBody } from "../function-value";
import { expressionKeyCount } from "../utils";

export function getExpressionType(json: JSONType, perf?: PerfStats): ExpressionType {
  if (perf) perf.getExpressionType++;
  if (json === null) return ExpressionType.Null;
  const t = typeof json;
  if (t === "string") return ExpressionType.String;
  if (t === "number") {
    return Number.isInteger(json as number) ? ExpressionType.Integer : ExpressionType.Number;
  }
  if (t === "boolean") return ExpressionType.Boolean;

  return classifyExpressionType(json);
}

function classifyExpressionType(json: JSONType): ExpressionType {
  if (Array.isArray(json)) return ExpressionType.Array;

  if (typeof json === "object" && json !== null) {
    const hasLet = "$let" in json;
    const hasIn = "$in" in json;
    if (hasLet || hasIn) {
      if (!(hasLet && hasIn)) {
        exprError(json, "$let expressions must have both $let and $in properties.");
      }
      if (Object.keys(json).length !== 2) {
        exprError(json, "$let expressions cannot have other properties.");
      }
      if (typeof json.$let !== "object" || json.$let === null || Array.isArray(json.$let)) {
        exprError(json, "$let must be a non-null object of bindings.");
      }
      if (Object.keys(json.$let).length === 0) {
        exprError(json, "$let must contain at least one binding.");
      }
      return ExpressionType.Let;
    }

    if ("$var" in json) {
      if (typeof json.$var !== "string") {
        exprError(json, "Variable references must have a string $var property.");
      }
      if (expressionKeyCount(json) > 1) {
        exprError(json, "Variable references cannot have other properties.");
      }
      return ExpressionType.VariableReference;
    }

    const hasGet = "$get" in json;
    const hasFrom = "$from" in json;
    if (hasGet || hasFrom) {
      if (!(hasGet && hasFrom)) {
        exprError(json, "Property access expressions must have both $get and $from.");
      }
      if (expressionKeyCount(json) > 2) {
        exprError(json, "Property access expressions cannot have more than two properties.");
      }
      return ExpressionType.PropertyAccess;
    }

    if (isFunctionBody(json)) {
      const analysis = analyzeFunctionBodyStructure(json);
      if (!analysis.ok) {
        exprError(json, formatFunctionBodyStructureIssue(analysis.issues[0]!));
      }
      return ExpressionType.FunctionBody;
    }

    if ("$call" in json || "$args" in json) {
      if (!("$call" in json && "$args" in json)) {
        exprError(json, "Function calls must have both $call and $args.");
      }
      if (!Array.isArray(json.$args)) {
        exprError(json, "Function call $args must be an array.");
      }
      if (expressionKeyCount(json) > 2) {
        exprError(json, "Function calls cannot have other properties.");
      }
      return ExpressionType.FunctionCall;
    }

    if ("$fn" in json) {
      if (Array.isArray(json.$fn)) {
        exprError(json, "Function references ($fn) cannot be arrays; use $call/$args for calls.");
      }
      if (expressionKeyCount(json) > 1) {
        exprError(json, "Function references cannot have other properties.");
      }
      return ExpressionType.FunctionReference;
    }

    if ("$cond" in json) {
      if (expressionKeyCount(json) > ("$else" in json ? 2 : 1)) {
        exprError(json, "$cond expressions can only have $cond and optional $else properties.");
      }
      const pairs = json.$cond;
      if (!Array.isArray(pairs)) {
        exprError(json, "$cond must be an array of [condition, result] pairs.");
      }
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          exprError(json, "Each $cond branch must be a [condition, result] pair.");
        }
      }
      return ExpressionType.Cond;
    }

    const hasMatch = "$match" in json;
    const hasCases = "$cases" in json;
    const hasMatchElse = "$else" in json;
    if (hasMatch || hasCases) {
      if (!(hasMatch && hasCases && hasMatchElse)) {
        exprError(json, "$match expressions must have $match, $cases, and $else properties.");
      }
      if (expressionKeyCount(json) > 3) {
        exprError(json, "$match expressions can only have $match, $cases, and $else properties.");
      }
      const pairs = json.$cases;
      if (!Array.isArray(pairs)) {
        exprError(json, "$cases must be an array of [value, result] pairs.");
      }
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          exprError(json, "Each $match case must be a [value, result] pair.");
        }
      }
      return ExpressionType.Match;
    }

    const hasIf = "$if" in json;
    const hasThen = "$then" in json;
    const hasElse = "$else" in json;
    if (hasIf || hasThen || hasElse) {
      if (!(hasIf && hasThen && hasElse)) {
        exprError(
          json,
          "Conditional expressions must have all three properties: $if, $then, $else.",
        );
      }
      if (expressionKeyCount(json) > 3) {
        exprError(json, "Conditional expressions cannot have more than three properties.");
      }
      return ExpressionType.Conditional;
    }

    if ("$and" in json) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, "$and expressions cannot have other properties.");
      }
      if (!Array.isArray(json.$and)) {
        exprError(json, "$and must be an array of expressions.");
      }
      return ExpressionType.And;
    }

    if ("$or" in json) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, "$or expressions cannot have other properties.");
      }
      if (!Array.isArray(json.$or)) {
        exprError(json, "$or must be an array of expressions.");
      }
      return ExpressionType.Or;
    }

    if ("$nonnull" in json) {
      if (Object.keys(json).length > 1) {
        exprError(json, "$nonnull expressions cannot have other properties.");
      }
      return ExpressionType.NonNullAssertion;
    }

    const hasAs = "$as" in json;
    const hasType = "$type" in json;
    if (hasAs || hasType) {
      if (!(hasAs && hasType)) {
        exprError(json, "Checked ascriptions must have both $as and $type.");
      }
      if (Object.keys(json).length > 2) {
        exprError(json, "Checked ascriptions cannot have other properties.");
      }
      return ExpressionType.CheckedAscription;
    }

    if ("$raw" in json) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, "$raw expressions cannot have other properties.");
      }
      return ExpressionType.Raw;
    }

    return ExpressionType.Object;
  }

  exprError(json, "Unrecognized expression type.");
}
