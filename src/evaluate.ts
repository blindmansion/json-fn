import type {
  JSONType,
  FunctionCall,
  FunctionReference,
  BuiltinFunction,
  FunctionDeclaration,
  EvaluationContext,
  FunctionBody,
  FunctionRegistry,
  ArgReference,
  VariableReference,
  Conditional,
  Cond,
  PropertyAccess,
  EvaluatedFunctionCall,
} from "./types";
import { BUILTIN_MARKER, PURE_MARKER, ExpressionType } from "./types";

export type PerfStats = {
  evaluateExpression: number;
  getExpressionType: number;
  callFunctionInternal: number;
  callJSONFunction: number;
  callExternalFunction: number;
  replaceVars: number;
  cloneIfNeeded: number;
  structuredClones: number;
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

function exprError(expr: JSONType, message: string): never {
  throw new Error(`Invalid JSON expression: ${JSON.stringify(expr, null, 2)}. ${message}`);
}

function cloneIfNeeded(value: JSONType): JSONType {
  if (_perf) _perf.cloneIfNeeded++;
  if (value === null || typeof value !== "object") return value;
  if (_perf) _perf.structuredClones++;
  return structuredClone(value);
}

function isPure(fn: unknown): boolean {
  return typeof fn === "function" && PURE_MARKER in fn;
}

export function pure(fn: Function): Function {
  (fn as any)[PURE_MARKER] = true;
  return fn;
}

export function builtin(
  fn: (args: JSONType[], call: (fn: JSONType, args: JSONType[]) => JSONType) => JSONType,
): BuiltinFunction {
  (fn as any)[BUILTIN_MARKER] = true;
  return fn as BuiltinFunction;
}

function isBuiltin(fn: unknown): fn is BuiltinFunction {
  return typeof fn === "function" && BUILTIN_MARKER in fn;
}

export function callFunction(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry,
): JSONType {
  return callFunctionInternal(fn, args, { functions });
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
  try {
    const { functions } = context;
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
          return entry(args, call);
        } else {
          return callExternalFunction(entry, args, fn);
        }
      } else {
        return callJSONFunction(entry as FunctionBody, args, {
          functions,
          args: [],
        });
      }
    } else {
      if (_perf) {
        _perf.functionCallCounts["<inline>"] = (_perf.functionCallCounts["<inline>"] ?? 0) + 1;
      }
      return callJSONFunction(fn as FunctionBody, args, context);
    }
  } finally {
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
  const { functions, getVar: getVarParent } = context;
  const evaluatedVars: Record<string, JSONType> = {};

  const getVar = (name: string): JSONType | undefined => {
    if (name in evaluatedVars) {
      return evaluatedVars[name];
    }

    const expression = fn[name];
    if (expression !== undefined) {
      const evaluated = evaluateExpression(expression, {
        args,
        functions,
        getVar,
      });
      evaluatedVars[name] = evaluated;
      return evaluated;
    }

    if (getVarParent) {
      return getVarParent(name);
    }

    return undefined;
  };

  return evaluateExpression(fn.$return, { args, functions, getVar });
}

function evaluateExpression(expression: JSONType, context: EvaluationContext): JSONType {
  if (_perf) _perf.evaluateExpression++;
  const { args, functions, getVar } = context;
  const expressionType = getExpressionType(expression);
  if (_perf) {
    const name = ExpressionType[expressionType] ?? String(expressionType);
    _perf.exprTypeCounts[name] = (_perf.exprTypeCounts[name] ?? 0) + 1;
  }

  switch (expressionType) {
    case ExpressionType.FunctionCall:
      const fnCall = expression as FunctionCall;
      const evaluatedFunctionCall = evaluateFunctionCall(fnCall, context);

      return callFunctionInternal(evaluatedFunctionCall.fnDeclaration, evaluatedFunctionCall.args, {
        args: [],
        functions,
        getVar,
      });

    case ExpressionType.FunctionReference:
      const fnRef = expression as FunctionReference;
      const evaluatedFnRef = evaluateExpression(fnRef.$fn, context);

      if (typeof evaluatedFnRef !== "string" && (typeof evaluatedFnRef !== "object" || evaluatedFnRef === null || Array.isArray(evaluatedFnRef) || !("$return" in evaluatedFnRef))) {
        exprError(
          expression,
          `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFnRef}.`,
        );
      }

      return evaluatedFnRef;

    case ExpressionType.ArgReference:
      if (!args) {
        exprError(expression, "args is not defined.");
      }

      const argRef = expression as ArgReference;
      const index = argRef.$arg;
      if (typeof index === "number") {
        return args[index]!;
      } else {
        return args.slice(index[0], index[1]);
      }

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

    case ExpressionType.Array:
      const array = expression as JSONType[];
      return array.map((item) => evaluateExpression(item, context));

    case ExpressionType.Object:
      const object = expression as { [key: string]: JSONType };
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
      const localNames = new Set(Object.keys(expression).filter((k) => k !== "$return"));
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

function evaluateFunctionCall(
  fnCall: FunctionCall,
  context: EvaluationContext,
): EvaluatedFunctionCall {
  const { $fn, $args } = fnCall;

  const evaluatedFn = evaluateExpression($fn, context);
  const evaluatedArgs = evaluateExpression($args, context);

  if (typeof evaluatedFn !== "string" && (typeof evaluatedFn !== "object" || evaluatedFn === null || Array.isArray(evaluatedFn) || !("$return" in evaluatedFn))) {
    exprError(
      fnCall,
      `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFn}.`,
    );
  }

  if (!Array.isArray(evaluatedArgs)) {
    exprError(fnCall, `Evaluated function arguments must be an array. Got ${typeof evaluatedArgs}.`);
  }

  return {
    fnDeclaration: evaluatedFn as FunctionDeclaration,
    args: evaluatedArgs as JSONType[],
  };
}

function objectKeyCount(obj: Record<string, unknown>): number {
  let n = 0;
  for (const _ in obj) n++;
  return n;
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

    if ("$arg" in json) {
      if (objectKeyCount(json) > 1) {
        exprError(json, "Arg references cannot have other properties.");
      }
      return ExpressionType.ArgReference;
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

    return ExpressionType.Object;
  }

  exprError(json, "Unrecognized expression type.");
}
