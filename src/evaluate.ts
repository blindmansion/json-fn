import type {
  JSONType,
  FunctionCall,
  FunctionReference,
  FunctionDeclaration,
  EvaluationContext,
  ExecutionLimits,
  FunctionBody,
  FunctionRegistry,
  VariableReference,
  Conditional,
  Cond,
  PropertyAccess,
  EvaluatedFunctionCall,
} from "./types";
import { ExpressionType } from "./types";
import { exprError, objectKeyCount, isPure, isBuiltin, isRaw, raw } from "./utils";

export type PerfStats = {
  evaluateExpression: number;
  getExpressionType: number;
  callFunctionInternal: number;
  callJSONFunction: number;
  callExternalFunction: number;
  replaceVars: number;
  cloneIfNeeded: number;
  structuredClones: number;
  rawSkips: number;
  exprTypeCounts: Record<string, number>;
  functionCallCounts: Record<string, number>;
  maxCallDepth: number;
};

let _perf: PerfStats | null = null;
let _callDepth = 0;

export function enablePerf(): PerfStats {
  _callDepth = 0;
  _perf = {
    evaluateExpression: 0,
    getExpressionType: 0,
    callFunctionInternal: 0,
    callJSONFunction: 0,
    callExternalFunction: 0,
    replaceVars: 0,
    cloneIfNeeded: 0,
    structuredClones: 0,
    rawSkips: 0,
    exprTypeCounts: {},
    functionCallCounts: {},
    maxCallDepth: 0,
  };
  return _perf;
}

export function disablePerf(): PerfStats | null {
  const stats = _perf;
  _perf = null;
  _callDepth = 0;
  return stats;
}

function cloneIfNeeded(value: JSONType): JSONType {
  if (_perf) _perf.cloneIfNeeded++;
  if (value === null || typeof value !== "object") return value;
  if (_perf) _perf.structuredClones++;
  return structuredClone(value);
}

const DEFAULT_MAX_CALL_DEPTH = 256;

export function callFunction(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry,
  limits?: ExecutionLimits,
): JSONType {
  return callFunctionInternal(fn, args, {
    functions,
    maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
    callState: { depth: 0 },
  });
}

function callFunctionInternal(
  fn: FunctionDeclaration,
  args: JSONType[],
  context: EvaluationContext,
): JSONType {
  if (_perf) {
    _perf.callFunctionInternal++;
    _callDepth++;
    if (_callDepth > _perf.maxCallDepth) _perf.maxCallDepth = _callDepth;
  }
  context.callState.depth++;
  try {
    if (context.callState.depth > context.maxCallDepth) {
      throw new Error(`Maximum call depth of ${context.maxCallDepth} exceeded`);
    }
    const { functions } = context;
    let result: JSONType;
    if (typeof fn === "string") {
      if (_perf) {
        _perf.functionCallCounts[fn] = (_perf.functionCallCounts[fn] ?? 0) + 1;
      }
      const entry = functions[fn];
      if (entry === undefined) {
        throw new Error(`Function ${fn} not found`);
      }

      if (typeof entry === "function") {
        if (isBuiltin(entry)) {
          const call = (f: JSONType, a: JSONType[]) =>
            callFunctionInternal(f as FunctionDeclaration, a, context);
          result = entry(args, call, functions);
        } else {
          result = callExternalFunction(entry, args, fn);
        }
      } else {
        result = callJSONFunction(entry as FunctionBody, args, {
          functions,
          maxCallDepth: context.maxCallDepth,
          callState: context.callState,
        });
      }
    } else {
      if (_perf) {
        _perf.functionCallCounts["<inline>"] = (_perf.functionCallCounts["<inline>"] ?? 0) + 1;
      }
      result = callJSONFunction(fn as FunctionBody, args, context);
    }
    raw(result);
    return result;
  } finally {
    context.callState.depth--;
    if (_perf) _callDepth--;
  }
}

function callExternalFunction(fn: Function, args: JSONType[], name: string): JSONType {
  if (_perf) _perf.callExternalFunction++;
  if (isPure(fn)) {
    try {
      return fn(...args);
    } catch (e) {
      throw new Error(`Error calling external function ${name}: ${e}`);
    }
  }
  const safeArgs = args.map((a) => cloneIfNeeded(a));
  try {
    const result = fn(...safeArgs);
    return cloneIfNeeded(result);
  } catch (e) {
    throw new Error(`Error calling external function ${name}: ${e}`);
  }
}

function callJSONFunction(fn: FunctionBody, args: JSONType[], context: EvaluationContext) {
  if (_perf) _perf.callJSONFunction++;
  const { functions, getVar: getVarParent, maxCallDepth, callState } = context;

  const localFnKeys: string[] = [];
  let scopedFunctions = functions;
  for (const key of Object.keys(fn)) {
    if (key === "$return" || key === "$params") continue;
    const val = fn[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val) && "$return" in val) {
      if (scopedFunctions === functions) scopedFunctions = { ...functions };
      scopedFunctions[key] = val as FunctionBody;
      localFnKeys.push(key);
    }
  }

  const evaluatedVars: Record<string, JSONType> = {};

  const params = (fn as any).$params as string[] | undefined;
  if (params) {
    for (let i = 0; i < params.length; i++) {
      const name = params[i]!;
      if (name.startsWith("...")) {
        evaluatedVars[name.slice(3)] = args.slice(i);
        break;
      }
      evaluatedVars[name] = args[i] ?? null;
    }
  }

  const resolvingVars: string[] = [];

  const getVar = (name: string): JSONType | undefined => {
    if (name in evaluatedVars) {
      return evaluatedVars[name];
    }

    if (resolvingVars.includes(name)) {
      const cycle = [...resolvingVars.slice(resolvingVars.indexOf(name)), name];
      throw new Error(`Circular variable dependency detected: ${cycle.join(" -> ")}`);
    }

    const expression = fn[name];
    if (expression !== undefined) {
      resolvingVars.push(name);
      try {
        const evaluated = evaluateExpression(expression, {
          functions: scopedFunctions,
          getVar,
          maxCallDepth,
          callState,
        });
        evaluatedVars[name] = evaluated;
        return evaluated;
      } finally {
        resolvingVars.pop();
      }
    }

    if (getVarParent) {
      return getVarParent(name);
    }

    return undefined;
  };

  if (localFnKeys.length > 0) {
    for (const key of localFnKeys) {
      scopedFunctions[key] = replaceVars(fn[key]!, getVar) as FunctionBody;
    }
  }

  return evaluateExpression(fn.$return, {
    functions: scopedFunctions,
    getVar,
    maxCallDepth,
    callState,
  });
}

function evaluateExpression(expression: JSONType, context: EvaluationContext): JSONType {
  if (_perf) _perf.evaluateExpression++;

  const { getVar } = context;
  const expressionType = getExpressionType(expression);
  if (_perf) {
    const name = ExpressionType[expressionType] ?? String(expressionType);
    _perf.exprTypeCounts[name] = (_perf.exprTypeCounts[name] ?? 0) + 1;
  }

  switch (expressionType) {
    case ExpressionType.FunctionCall:
      const fnCall = expression as FunctionCall;
      const evaluatedFunctionCall = evaluateFunctionCall(fnCall, context);

      return callFunctionInternal(
        evaluatedFunctionCall.fnDeclaration,
        evaluatedFunctionCall.args,
        context,
      );

    case ExpressionType.FunctionReference:
      const fnRef = expression as FunctionReference;
      const evaluatedFnRef = evaluateExpression(fnRef.$fn, context);

      if (
        typeof evaluatedFnRef !== "string" &&
        (typeof evaluatedFnRef !== "object" ||
          evaluatedFnRef === null ||
          Array.isArray(evaluatedFnRef) ||
          !("$return" in evaluatedFnRef))
      ) {
        exprError(
          expression,
          `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFnRef}.`,
        );
      }

      return evaluatedFnRef;

    case ExpressionType.VariableReference:
      const varRef = expression as VariableReference;
      if (!getVar) {
        exprError(expression, "getVar is not defined.");
      }
      const value = getVar(varRef.$var);
      if (value === undefined) {
        exprError(expression, `Variable ${varRef.$var} not found.`);
      }
      return value;

    case ExpressionType.FunctionBody:
      if (!getVar) {
        return expression;
      }
      return replaceVars(expression, getVar);

    case ExpressionType.Conditional:
      const conditional = expression as Conditional;
      const evaluatedIf = evaluateExpression(conditional.$if, context);

      if (evaluatedIf) {
        return evaluateExpression(conditional.$then, context);
      } else {
        return evaluateExpression(conditional.$else, context);
      }

    case ExpressionType.Cond:
      const cond = expression as Cond;
      for (const [condition, result] of cond.$cond) {
        const evaluatedCondition = evaluateExpression(condition, context);
        if (evaluatedCondition) {
          return evaluateExpression(result, context);
        }
      }
      exprError(expression, "No $cond branch matched (add a [true, ...] catch-all).");

    case ExpressionType.PropertyAccess:
      const propAccess = expression as PropertyAccess;
      const evaluatedKey = evaluateExpression(propAccess.$get, context);
      const evaluatedTarget = evaluateExpression(propAccess.$from, context);

      if (evaluatedTarget === null || typeof evaluatedTarget !== "object") {
        throw new Error(
          `Invalid $get target: expected object or array, got ${JSON.stringify(evaluatedTarget)}`,
        );
      }

      if (Array.isArray(evaluatedKey)) {
        let current: JSONType = evaluatedTarget;
        for (const segment of evaluatedKey) {
          if (current === null || typeof current !== "object") {
            throw new Error(
              `Invalid $get path traversal: cannot access property ${JSON.stringify(
                segment,
              )} on ${JSON.stringify(current)}`,
            );
          }
          current = (current as any)[segment as string | number];
          if (current === undefined) {
            return null;
          }
        }
        return current;
      }

      if (typeof evaluatedKey === "string" || typeof evaluatedKey === "number") {
        const result = (evaluatedTarget as any)[evaluatedKey];
        return result === undefined ? null : result;
      }

      throw new Error(
        `Invalid $get key: expected string, number, or array of strings/numbers, got ${JSON.stringify(
          evaluatedKey,
        )}`,
      );

    case ExpressionType.Literal:
      const literalValue = (expression as { $literal: JSONType }).$literal;
      raw(literalValue);
      return literalValue;

    case ExpressionType.Array:
      const array = expression as JSONType[];
      if (isRaw(array)) {
        if (_perf) _perf.rawSkips++;
        return array;
      }
      return array.map((item) => evaluateExpression(item, context));

    case ExpressionType.Object:
      const object = expression as { [key: string]: JSONType };
      if (isRaw(object)) {
        if (_perf) _perf.rawSkips++;
        return object;
      }
      const evaluatedObject: Record<string, JSONType> = {};
      for (const [key, value] of Object.entries(object)) {
        evaluatedObject[key] = evaluateExpression(value, context);
      }
      return evaluatedObject;

    case ExpressionType.String:
    case ExpressionType.Integer:
    case ExpressionType.Number:
    case ExpressionType.Boolean:
    case ExpressionType.Null:
      return expression;

    default:
      exprError(expression, "Unrecognized expression type.");
  }
}

function replaceVars(
  expression: JSONType,
  getVar: (name: string) => JSONType | undefined,
): JSONType {
  if (_perf) _perf.replaceVars++;
  if (typeof expression === "object" && expression !== null && isRaw(expression)) {
    if (_perf) _perf.rawSkips++;
    return expression;
  }
  if (Array.isArray(expression)) {
    return expression.map((item) => replaceVars(item, getVar));
  }

  if (typeof expression === "object" && expression !== null) {
    if ("$var" in expression && typeof expression.$var === "string") {
      const varValue = getVar(expression.$var);
      if (varValue === undefined) {
        return expression;
      }
      return varValue;
    }

    if ("$return" in expression) {
      const localNames = new Set(
        Object.keys(expression).filter((k) => k !== "$return" && k !== "$params"),
      );

      const params = expression.$params;
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === "string") {
            localNames.add(p.startsWith("...") ? p.slice(3) : p);
          }
        }
      }

      const maskedGetVar =
        localNames.size > 0
          ? (name: string) => (localNames.has(name) ? undefined : getVar(name))
          : getVar;

      const newObject: Record<string, JSONType> = {};
      for (const [key, value] of Object.entries(expression)) {
        newObject[key] = replaceVars(value, maskedGetVar);
      }
      return newObject;
    }

    const newObject: Record<string, JSONType> = {};
    for (const [key, value] of Object.entries(expression)) {
      newObject[key] = replaceVars(value, getVar);
    }
    return newObject;
  }

  return expression;
}

function getParamNames(fn: FunctionBody): string[] | undefined {
  const params = (fn as any).$params as string[] | undefined;
  if (!Array.isArray(params)) return undefined;
  return params;
}

function resolveNamedArgs(
  namedArgs: Record<string, JSONType>,
  fnDeclaration: FunctionDeclaration,
  context: EvaluationContext,
  fnCall: FunctionCall,
): JSONType[] {
  let fnBody: FunctionBody | undefined;

  if (typeof fnDeclaration === "string") {
    const entry = context.functions[fnDeclaration];
    if (entry === undefined) {
      exprError(fnCall, `Function ${fnDeclaration} not found.`);
    }
    if (typeof entry === "function") {
      exprError(fnCall, `Named arguments are not supported for external functions.`);
    }
    fnBody = entry as FunctionBody;
  } else {
    fnBody = fnDeclaration;
  }

  const paramNames = getParamNames(fnBody);
  if (!paramNames) {
    exprError(fnCall, `Named arguments require the target function to declare $params.`);
  }

  if (paramNames.some((p) => p.startsWith("..."))) {
    exprError(fnCall, `Named arguments are not supported for functions with rest parameters.`);
  }

  const argKeys = new Set(Object.keys(namedArgs));
  for (const key of argKeys) {
    if (!paramNames.includes(key)) {
      exprError(
        fnCall,
        `Unknown named argument "${key}". Expected one of: ${paramNames.join(", ")}.`,
      );
    }
  }

  return paramNames.map((name) => namedArgs[name] ?? null);
}

function evaluateFunctionCall(
  fnCall: FunctionCall,
  context: EvaluationContext,
): EvaluatedFunctionCall {
  const { $fn, $args } = fnCall;

  const evaluatedFn = evaluateExpression($fn, context);
  const evaluatedArgs = evaluateExpression($args, context);

  if (
    typeof evaluatedFn !== "string" &&
    (typeof evaluatedFn !== "object" ||
      evaluatedFn === null ||
      Array.isArray(evaluatedFn) ||
      !("$return" in evaluatedFn))
  ) {
    exprError(
      fnCall,
      `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFn}.`,
    );
  }

  const fnDeclaration = evaluatedFn as FunctionDeclaration;

  if (Array.isArray(evaluatedArgs)) {
    return { fnDeclaration, args: evaluatedArgs as JSONType[] };
  }

  if (
    typeof evaluatedArgs === "object" &&
    evaluatedArgs !== null &&
    !Array.isArray(evaluatedArgs)
  ) {
    const args = resolveNamedArgs(
      evaluatedArgs as Record<string, JSONType>,
      fnDeclaration,
      context,
      fnCall,
    );
    return { fnDeclaration, args };
  }

  exprError(
    fnCall,
    `Evaluated function arguments must be an array or named-args object. Got ${typeof evaluatedArgs}.`,
  );
}

function getExpressionType(json: JSONType): ExpressionType {
  if (_perf) _perf.getExpressionType++;
  if (Array.isArray(json)) return ExpressionType.Array;
  if (typeof json === "string") return ExpressionType.String;
  if (typeof json === "number") {
    return Number.isInteger(json) ? ExpressionType.Integer : ExpressionType.Number;
  }
  if (typeof json === "boolean") return ExpressionType.Boolean;
  if (json === null) return ExpressionType.Null;

  if (typeof json === "object") {
    if ("$var" in json) {
      if (typeof json.$var !== "string") {
        exprError(json, "Variable references must have a string $var property.");
      }
      if (objectKeyCount(json) > 1) {
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
      if (objectKeyCount(json) > 2) {
        exprError(json, "Property access expressions cannot have more than two properties.");
      }
      return ExpressionType.PropertyAccess;
    }

    if ("$return" in json) {
      if ("$fn" in json || "$args" in json) {
        exprError(json, "Function bodies cannot have other keyword properties.");
      }
      if ("$params" in json) {
        const params = json.$params;
        if (!Array.isArray(params) || !params.every((p) => typeof p === "string")) {
          exprError(json, "$params must be an array of strings.");
        }
      }
      return ExpressionType.FunctionBody;
    }

    if ("$fn" in json && (typeof json.$fn === "string" || typeof json.$fn === "object")) {
      if (Array.isArray(json.$fn)) {
        exprError(json, "Function references cannot be arrays.");
      }

      if ("$args" in json) {
        if (objectKeyCount(json) > 2) {
          exprError(json, "Function calls cannot have more than two properties.");
        }
        return ExpressionType.FunctionCall;
      }

      if (objectKeyCount(json) > 1) {
        exprError(json, "Function references cannot have other properties.");
      }
      return ExpressionType.FunctionReference;
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
      if (objectKeyCount(json) > 3) {
        exprError(json, "Conditional expressions cannot have more than three properties.");
      }
      return ExpressionType.Conditional;
    }

    if ("$cond" in json) {
      if (objectKeyCount(json) > 1) {
        exprError(json, "$cond expressions cannot have other properties.");
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

    if ("$literal" in json) {
      if (objectKeyCount(json) > 1) {
        exprError(json, "$literal expressions cannot have other properties.");
      }
      return ExpressionType.Literal;
    }

    return ExpressionType.Object;
  }

  exprError(json, "Unrecognized expression type.");
}
