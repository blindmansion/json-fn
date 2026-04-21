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
  VarPropertyAccess,
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

type ParsedPath = { variable: string; path: (string | number)[] };
const PATH_CACHE_MAX = 1024;
const _pathCache = new Map<string, ParsedPath>();

function cachePath(str: string, result: ParsedPath): ParsedPath {
  if (_pathCache.size >= PATH_CACHE_MAX) _pathCache.delete(_pathCache.keys().next().value!);
  _pathCache.set(str, result);
  return result;
}

function parsePath(str: string): ParsedPath {
  const cached = _pathCache.get(str);
  if (cached) return cached;

  const dotIdx = str.indexOf(".");
  const bracketIdx = str.indexOf("[");

  if (dotIdx === -1 && bracketIdx === -1) {
    const result: ParsedPath = { variable: str, path: [] };
    return cachePath(str, result);
  }

  let splitIdx: number;
  if (dotIdx === -1) splitIdx = bracketIdx;
  else if (bracketIdx === -1) splitIdx = dotIdx;
  else splitIdx = Math.min(dotIdx, bracketIdx);

  const variable = str.slice(0, splitIdx);
  if (variable === "") {
    throw new Error(`Invalid $var path: variable name cannot be empty in "${str}"`);
  }

  const path: (string | number)[] = [];
  let i = splitIdx;

  while (i < str.length) {
    const ch = str[i];
    if (ch === ".") {
      i++;
      let end = i;
      while (end < str.length && str[end] !== "." && str[end] !== "[") {
        end++;
      }
      if (end === i) {
        throw new Error(`Invalid $var path: empty segment after "." in "${str}"`);
      }
      path.push(str.slice(i, end));
      i = end;
    } else if (ch === "[") {
      i++;
      const closeIdx = str.indexOf("]", i);
      if (closeIdx === -1) {
        throw new Error(`Invalid $var path: unclosed "[" in "${str}"`);
      }
      const inner = str.slice(i, closeIdx);
      if (inner === "") {
        throw new Error(`Invalid $var path: empty "[]" in "${str}"`);
      }
      const num = Number(inner);
      path.push(Number.isInteger(num) && String(num) === inner ? num : inner);
      i = closeIdx + 1;
    } else {
      throw new Error(`Invalid $var path: unexpected character "${ch}" in "${str}"`);
    }
  }

  const result: ParsedPath = { variable, path };
  return cachePath(str, result);
}

function isFnDeclaration(value: JSONType): value is FunctionDeclaration {
  return (
    typeof value === "string" ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && "$return" in value)
  );
}

function walkPath(value: JSONType, path: (string | number)[]): JSONType {
  let current = value;
  for (const segment of path) {
    if (typeof current === "string") {
      if (typeof segment === "number") {
        const ch = current[segment];
        current = ch === undefined ? null : ch;
      } else {
        return null;
      }
    } else if (current === null || typeof current !== "object") {
      return null;
    } else {
      current = (current as any)[segment];
      if (current === undefined) {
        return null;
      }
    }
  }
  return current;
}

function resolveVar(
  varPath: string,
  getVar: (name: string) => JSONType | undefined,
  expression: JSONType,
): JSONType {
  const parsed = parsePath(varPath);
  const value = getVar(parsed.variable);
  if (value === undefined) {
    exprError(expression, `Variable ${parsed.variable} not found.`);
  }
  return parsed.path.length > 0 ? walkPath(value, parsed.path) : value;
}

function validateParamName(name: string): void {
  if (name.includes(".") || name.includes("[")) {
    throw new Error(
      `Parameter name "${name}" must not contain "." or "[". Use simple identifiers.`,
    );
  }
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
    limits: {
      maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
      maxOperations: limits?.maxOperations ?? Infinity,
      signal: limits?.signal,
    },
    state: { depth: 0, operations: 0 },
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
  context.state.depth++;
  try {
    if (context.state.depth > context.limits.maxCallDepth) {
      throw new Error(`Maximum call depth of ${context.limits.maxCallDepth} exceeded`);
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
          limits: context.limits,
          state: context.state,
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
    context.state.depth--;
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
  const { functions, getVar: getVarParent, limits, state } = context;

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
        const restName = name.slice(3);
        validateParamName(restName);
        evaluatedVars[restName] = args.slice(i);
        break;
      }
      validateParamName(name);
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
          limits,
          state,
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

  return evaluateExpression(fn.$return, { functions: scopedFunctions, getVar, limits, state });
}

function evaluateExpression(expression: JSONType, context: EvaluationContext): JSONType {
  if (_perf) _perf.evaluateExpression++;

  if (context.limits.signal?.aborted) {
    throw new Error("Execution aborted");
  }

  if (context.limits.maxOperations < Infinity) {
    if (++context.state.operations > context.limits.maxOperations) {
      throw new Error(`Maximum operations limit of ${context.limits.maxOperations} exceeded`);
    }
  }

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

      if (!isFnDeclaration(evaluatedFnRef)) {
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
      return resolveVar(varRef.$var, getVar, expression);

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

    case ExpressionType.And:
      const andExprs = (expression as { $and: JSONType[] }).$and;
      let andResult: JSONType = true;
      for (const expr of andExprs) {
        andResult = evaluateExpression(expr, context);
        if (!andResult) return andResult;
      }
      return andResult;

    case ExpressionType.Or:
      const orExprs = (expression as { $or: JSONType[] }).$or;
      let orResult: JSONType = false;
      for (const expr of orExprs) {
        orResult = evaluateExpression(expr, context);
        if (orResult) return orResult;
      }
      return orResult;

    case ExpressionType.PropertyAccess:
      return evaluatePropertyAccess(expression as PropertyAccess | VarPropertyAccess, context);

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
      const parsed = parsePath(expression.$var);
      if ("$get" in expression) {
        const varValue = getVar(parsed.variable);
        const replacedKey = replaceVars(expression.$get, getVar);
        if (varValue !== undefined) {
          if (parsed.path.length > 0) {
            const pathKey: JSONType = parsed.path.length === 1 ? parsed.path[0]! : parsed.path;
            return { $get: replacedKey, $from: { $get: pathKey, $from: varValue } };
          }
          return { $get: replacedKey, $from: varValue };
        }
        return { $var: expression.$var, $get: replacedKey };
      }
      const varValue = getVar(parsed.variable);
      if (varValue === undefined) {
        return expression;
      }
      if (parsed.path.length > 0) {
        const pathKey: JSONType = parsed.path.length === 1 ? parsed.path[0]! : parsed.path;
        return { $get: pathKey, $from: varValue };
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

function evaluatePropertyAccess(
  expression: PropertyAccess | VarPropertyAccess,
  context: EvaluationContext,
): JSONType {
  const { getVar } = context;
  const evaluatedKey = evaluateExpression(expression.$get, context);
  let evaluatedTarget: JSONType;
  if ("$var" in expression) {
    if (!getVar) {
      exprError(expression, "getVar is not defined.");
    }
    evaluatedTarget = resolveVar(expression.$var, getVar, expression);
  } else {
    evaluatedTarget = evaluateExpression(expression.$from, context);
  }

  if (
    evaluatedTarget === null ||
    (typeof evaluatedTarget !== "object" && typeof evaluatedTarget !== "string")
  ) {
    throw new Error(
      `Invalid $get target: expected object, array, or string, got ${JSON.stringify(evaluatedTarget)}`,
    );
  }

  if (typeof evaluatedTarget === "string") {
    if (typeof evaluatedKey === "number") {
      return evaluatedTarget[evaluatedKey] ?? null;
    }
    throw new Error(
      `Invalid $get key for string: expected number, got ${JSON.stringify(evaluatedKey)}`,
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
}

function evaluateFunctionCall(
  fnCall: FunctionCall,
  context: EvaluationContext,
): EvaluatedFunctionCall {
  const fnArray = fnCall.$fn;
  const fnExpr = fnArray[0]!;

  const evaluatedFn = evaluateExpression(fnExpr, context);

  if (!isFnDeclaration(evaluatedFn)) {
    exprError(
      fnCall,
      `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFn}.`,
    );
  }

  const fnDeclaration = evaluatedFn as FunctionDeclaration;
  const args: JSONType[] = [];
  for (let i = 1; i < fnArray.length; i++) {
    args.push(evaluateExpression(fnArray[i]!, context));
  }

  return { fnDeclaration, args };
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
      const keyCount = objectKeyCount(json);
      if ("$get" in json) {
        if (keyCount > 2) {
          exprError(json, "$var/$get property access cannot have other properties.");
        }
        return ExpressionType.PropertyAccess;
      }
      if (keyCount > 1) {
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
      if ("$fn" in json) {
        exprError(json, "Function bodies cannot have other keyword properties.");
      }
      if ("$params" in json) {
        const params = json.$params;
        if (!Array.isArray(params) || !params.every((p) => typeof p === "string")) {
          exprError(json, "$params must be an array of strings.");
        }
        for (const p of params) {
          const name = (p as string).startsWith("...") ? (p as string).slice(3) : (p as string);
          validateParamName(name);
        }
      }
      return ExpressionType.FunctionBody;
    }

    if ("$fn" in json) {
      if (Array.isArray(json.$fn)) {
        if (objectKeyCount(json) > 1) {
          exprError(json, "Function calls cannot have other properties.");
        }
        return ExpressionType.FunctionCall;
      }

      if (typeof json.$fn === "string" || typeof json.$fn === "object") {
        if (objectKeyCount(json) > 1) {
          exprError(json, "Function references cannot have other properties.");
        }
        return ExpressionType.FunctionReference;
      }
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

    if ("$and" in json) {
      if (objectKeyCount(json) > 1) {
        exprError(json, "$and expressions cannot have other properties.");
      }
      if (!Array.isArray(json.$and)) {
        exprError(json, "$and must be an array of expressions.");
      }
      return ExpressionType.And;
    }

    if ("$or" in json) {
      if (objectKeyCount(json) > 1) {
        exprError(json, "$or expressions cannot have other properties.");
      }
      if (!Array.isArray(json.$or)) {
        exprError(json, "$or must be an array of expressions.");
      }
      return ExpressionType.Or;
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
