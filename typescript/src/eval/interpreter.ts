import type {
  JSONType,
  FunctionCall,
  FunctionReference,
  FunctionDeclaration,
  FunctionBody,
  FunctionRegistry,
  LetExpression,
  VariableReference,
  Conditional,
  Cond,
  Match,
  NonNullAssertion,
  CheckedAscription,
  PropertyAccess,
  EvaluatedFunctionCall,
  PerfStats,
  Meter,
} from "../types";
import { ExpressionType } from "../types";
import { exprError } from "../expression-error";
import {
  analyzeFunctionBodyStructure,
  formatFunctionBodyStructureIssue,
} from "../function-body-structure";
import {
  isCommentKey,
  isPure,
  isMeteredPure,
  isBuiltin,
  isRaw,
  isInert,
  markEvaluated,
  raw,
} from "../utils";
import {
  CONTRACT_KEY,
  enforceRuntimeContract,
  enforceRuntimeContractReturn,
  prepareRuntimeContractCall,
  readRuntimeFunctionContract,
} from "../runtime-contract";
import { requireParameterLayout, validateRuntimeArguments, type ParameterLayout } from "../params";
import { isFunctionBody, isFunctionDeclaration } from "../function-value";
import { replaceVars } from "./closures";
import { accountForResult, chargeFuel, checkInterrupt, guardValueSize } from "./execution";
import { getExpressionType } from "./expression-type";
import { getFunctionEnvironment, registerFunctionEnvironment } from "./function-environments";
import type { EvaluationContext } from "./internal-types";
import { accessProperty } from "./property-access";

const ADAPTER_ALIAS_PREFIX = "@adapter:";

export class ExternalFunctionError extends Error {
  readonly code = "EXTERNAL_FUNCTION_ERROR";

  constructor(
    readonly functionName: string,
    override readonly cause: unknown,
  ) {
    super(`Error calling external function ${functionName}: ${errorMessage(cause)}`);
    this.name = "ExternalFunctionError";
  }
}

export class ReservedAdapterAliasError extends Error {
  readonly code = "RESERVED_ADAPTER_ALIAS";

  constructor(readonly alias: string) {
    super(`Function alias "${alias}" is reserved for contract wrappers`);
    this.name = "ReservedAdapterAliasError";
  }
}

function isScalarValue(value: JSONType): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function assertMatchScalar(value: JSONType, expression: JSONType): void {
  if (!isScalarValue(value)) {
    exprError(expression, "$match values must be null, boolean, number, or string.");
  }
}

function cloneIfNeeded(value: JSONType, perf?: PerfStats): JSONType {
  if (perf) perf.cloneIfNeeded++;
  if (value === null || typeof value !== "object") return value;
  if (perf) perf.structuredClones++;
  return structuredClone(value);
}

const EMPTY_LOCAL_FNS: ReadonlySet<string> = new Set();

// Pure-data literals keep their original identity after evaluation. Cache the
// number of expression nodes that first evaluation visited so later evaluations
// can skip descendant classification/allocation without making normative fuel
// depend on whether this object was already evaluated in the current process.
const constantEvaluationCosts = new WeakMap<object, number>();

function constantChildCost(original: JSONType, evaluated: JSONType): number | null {
  if (evaluated !== original) return null;
  if (original === null || typeof original !== "object") return 1;
  return constantEvaluationCosts.get(original) ?? (isRaw(original) ? 1 : null);
}

function resolveVar(
  name: string,
  getVar: (name: string) => JSONType | undefined,
  functions: FunctionRegistry,
  expression: JSONType,
): JSONType {
  const value = getVar(name);
  if (value === undefined) {
    // P4: a bare identifier that isn't a lexical binding but *is* a registered
    // function resolves to its name reference (i.e. `map(length, xs)` ==
    // `map(&length, xs)`), so `&` is optional.
    if (functions[name] !== undefined) {
      return name;
    }
    exprError(expression, `Variable ${name} not found.`);
  }
  return value;
}

export function callFunctionInternal(
  fn: FunctionDeclaration,
  args: JSONType[],
  context: EvaluationContext,
): JSONType {
  const { perf } = context;
  if (perf) perf.callFunctionInternal++;
  checkInterrupt(context);
  chargeFuel(context, 1);
  context.state.depth++;
  try {
    if (context.state.depth > context.limits.maxCallDepth) {
      throw new Error(`Maximum call depth of ${context.limits.maxCallDepth} exceeded`);
    }
    if (perf && context.state.depth > perf.maxCallDepth) perf.maxCallDepth = context.state.depth;
    const { functions } = context;
    let result: JSONType;
    if (typeof fn === "string") {
      if (fn.startsWith(ADAPTER_ALIAS_PREFIX) && context.allowAdapterAlias !== true) {
        throw new ReservedAdapterAliasError(fn);
      }
      if (perf) {
        perf.functionCallCounts[fn] = (perf.functionCallCounts[fn] ?? 0) + 1;
      }
      // P4: lexical-first name resolution. A function-valued parameter or local
      // shadows a same-named global (stdlib/host builtin), *consistently* whether
      // the name is reached via operator desugaring (`+`→`add`), a direct call
      // `f(x)`, or a bare reference. Registry-dispatched local functions are
      // invoked *without* a getVar parent (see the JSON-function branch below),
      // so a local function's self/sibling references miss here and fall through
      // to the registry — local recursion is preserved. A non-function lexical
      // binding (e.g. `add: 5`) does not hijack a call position; resolution falls
      // through to the registry below.
      const lexical = context.localFns?.has(fn) ? undefined : context.getVar?.(fn);
      if (lexical !== undefined && isFunctionDeclaration(lexical)) {
        result = callFunctionInternal(lexical, args, context);
        markEvaluated(result);
        return result;
      }
      const entry = functions[fn];
      if (entry === undefined) {
        throw new Error(`Function ${fn} not found`);
      }

      if (typeof entry === "function") {
        if (isBuiltin(entry)) {
          const call = (f: JSONType, a: JSONType[]) =>
            callFunctionInternal(f as FunctionDeclaration, a, context);
          const meter = meterForContext(context);
          result = entry(args, call, functions, meter, { defs: context.runtimeDefs ?? {} });
          accountForResult(context, result);
        } else {
          result = callExternalFunction(entry, args, fn, context);
        }
      } else {
        const owner = getFunctionEnvironment(entry as FunctionBody);
        result = callJSONFunction(entry as FunctionBody, args, {
          functions: owner?.functions ?? functions,
          localFns: owner?.localFns ?? EMPTY_LOCAL_FNS,
          attachFns: owner?.attachFns ?? EMPTY_LOCAL_FNS,
          limits: context.limits,
          state: context.state,
          perf,
          runtimeDefs: context.runtimeDefs,
        });
      }
    } else {
      if (perf) {
        perf.functionCallCounts["<inline>"] = (perf.functionCallCounts["<inline>"] ?? 0) + 1;
      }
      // Function values are self-contained closures (free variables were
      // substituted by replaceVars at capture), so the callee must not chain
      // the caller's scope: linking getVar here turns lexical scope into a
      // dynamic chain that grows with recursion depth, making every name
      // lookup O(depth) and recursion O(depth^2) overall. This mirrors the
      // registry-dispatch branch above, which already drops getVar.
      result = callJSONFunction(fn as FunctionBody, args, {
        functions: context.functions,
        localFns: EMPTY_LOCAL_FNS,
        attachFns: EMPTY_LOCAL_FNS,
        limits: context.limits,
        state: context.state,
        perf,
        runtimeDefs: context.runtimeDefs,
      });
    }
    markEvaluated(result);
    return result;
  } finally {
    context.state.depth--;
  }
}

function meterForContext(context: EvaluationContext): Meter {
  return {
    charge: (amount: number) => chargeFuel(context, amount),
    guardSize: (size: number) => guardValueSize(context, size),
  };
}

function callExternalFunction(
  fn: Function,
  args: JSONType[],
  name: string,
  context: EvaluationContext,
): JSONType {
  const { perf } = context;
  if (perf) perf.callExternalFunction++;
  if (isPure(fn)) {
    let result: JSONType;
    try {
      result = isMeteredPure(fn) ? fn(meterForContext(context), ...args) : fn(...args);
    } catch (e) {
      throw new ExternalFunctionError(name, e);
    }
    accountForResult(context, result);
    return result;
  }
  const safeArgs = args.map((a) => cloneIfNeeded(a, perf));
  let result: JSONType;
  try {
    result = cloneIfNeeded(fn(...safeArgs), perf);
  } catch (e) {
    throw new ExternalFunctionError(name, e);
  }
  accountForResult(context, result);
  return result;
}

export type ScopeResult = {
  getVar: (name: string) => JSONType | undefined;
  functions: FunctionRegistry;
  localFns: ReadonlySet<string>;
  attachFns: ReadonlySet<string>;
};

type LazyFramePolicy = {
  attachLocalFunctions: boolean;
};

function createLazyFrame(
  evaluatedBindings: Record<string, JSONType>,
  lazyBindings: Record<string, JSONType>,
  context: EvaluationContext,
  policy: LazyFramePolicy,
): ScopeResult {
  const { functions, getVar: getVarParent, limits, state } = context;

  const localFnKeys: string[] = [];
  let scopedFunctions = functions;
  for (const [key, value] of Object.entries(lazyBindings)) {
    if (isFunctionBody(value)) {
      if (scopedFunctions === functions) scopedFunctions = { ...functions };
      scopedFunctions[key] = value;
      localFnKeys.push(key);
    }
  }

  const parentLocalFns = context.localFns ?? EMPTY_LOCAL_FNS;
  let localFns = parentLocalFns;
  if (localFnKeys.length > 0) {
    const merged = new Set(parentLocalFns);
    for (const key of localFnKeys) merged.add(key);
    localFns = merged;
  }

  const parentAttachFns = context.attachFns ?? EMPTY_LOCAL_FNS;
  let attachFns = parentAttachFns;
  if (policy.attachLocalFunctions && localFnKeys.length > 0) {
    const merged = new Set(parentAttachFns);
    for (const key of localFnKeys) merged.add(key);
    attachFns = merged;
  }

  const evaluatedVars = { ...evaluatedBindings };
  const pendingBindings = new Map(Object.entries(lazyBindings));
  const resolvingVars: string[] = [];

  const getVar = (name: string): JSONType | undefined => {
    if (Object.prototype.hasOwnProperty.call(evaluatedVars, name)) {
      return evaluatedVars[name];
    }

    if (resolvingVars.includes(name)) {
      const cycle = [...resolvingVars.slice(resolvingVars.indexOf(name)), name];
      throw new Error(`Circular variable dependency detected: ${cycle.join(" -> ")}`);
    }

    if (pendingBindings.has(name)) {
      resolvingVars.push(name);
      try {
        const evaluated = evaluateExpression(pendingBindings.get(name)!, {
          functions: scopedFunctions,
          getVar,
          localFns,
          attachFns,
          limits,
          state,
          perf: context.perf,
          runtimeDefs: context.runtimeDefs,
        });
        pendingBindings.delete(name);
        evaluatedVars[name] = evaluated;
        return evaluated;
      } finally {
        resolvingVars.pop();
      }
    }

    return getVarParent?.(name);
  };

  if (localFnKeys.length > 0) {
    for (const key of localFnKeys) {
      scopedFunctions[key] = replaceVars(
        lazyBindings[key]!,
        getVar,
        localFns,
        attachFns,
        undefined,
        context,
      ) as FunctionBody;
    }
    const environment = { functions: scopedFunctions, localFns, attachFns };
    for (const key of localFnKeys) {
      registerFunctionEnvironment(scopedFunctions[key] as FunctionBody, environment);
    }
  }

  return { getVar, functions: scopedFunctions, localFns, attachFns };
}

function materializeParameterBindings(
  args: JSONType[],
  layout: ParameterLayout,
): {
  evaluated: Record<string, JSONType>;
  lazy: Record<string, JSONType>;
} {
  const evaluated: Record<string, JSONType> = {};
  const lazy: Record<string, JSONType> = {};
  for (const slot of layout.slots) {
    if (slot.kind === "rest") {
      evaluated[slot.name] = args.slice(slot.index);
      continue;
    }
    if (slot.kind === "fields") {
      // Object pattern: destructure the positional argument into named locals.
      // Runtime validation guarantees a supplied plain object and all required
      // own fields. Absent defaulted properties register defaults lazily.
      const value = args[slot.index] as Record<string, JSONType>;
      for (const binding of slot.bindings) {
        if (Object.prototype.hasOwnProperty.call(value, binding.name)) {
          evaluated[binding.name] = value[binding.name]!;
        } else if (binding.kind === "defaulted") {
          lazy[binding.name] = binding.defaultExpression;
        } else if (binding.kind === "optional") {
          evaluated[binding.name] = null;
        }
      }
      continue;
    }
    if (slot.index < args.length) {
      evaluated[slot.name] = args[slot.index]!;
    } else if (slot.kind === "defaulted") {
      lazy[slot.name] = slot.defaultExpression;
    } else if (slot.kind === "optional") {
      evaluated[slot.name] = null;
    }
  }
  return { evaluated, lazy };
}

function bindParameters(
  layout: ParameterLayout,
  args: JSONType[],
  context: EvaluationContext,
): ScopeResult {
  const bindings = materializeParameterBindings(args, layout);
  return createLazyFrame(bindings.evaluated, bindings.lazy, context, {
    attachLocalFunctions: false,
  });
}

function bindExpressionBindings(
  bindings: Record<string, JSONType>,
  context: EvaluationContext,
): ScopeResult {
  return createLazyFrame({}, bindings, context, { attachLocalFunctions: true });
}

export function initializeModuleBindings(
  module: Record<string, JSONType>,
  context: EvaluationContext,
): ScopeResult {
  return createLazyFrame({}, module, context, { attachLocalFunctions: false });
}

function legacyFunctionBindings(fn: FunctionBody): Record<string, JSONType> {
  const bindings: Record<string, JSONType> = {};
  for (const [key, value] of Object.entries(fn)) {
    if (
      key === "$return" ||
      key === "$params" ||
      key === "$sig" ||
      key === "$types" ||
      key === "$captures" ||
      key === CONTRACT_KEY ||
      (key === "$comment" && typeof value === "string")
    ) {
      continue;
    }
    bindings[key] = value;
  }
  return bindings;
}

// TODO(let-phase4): delete once function bodies no longer contain inline locals.
function bindLegacyFunctionFrame(
  fn: FunctionBody,
  layout: ParameterLayout,
  args: JSONType[],
  context: EvaluationContext,
): ScopeResult {
  const parameters = materializeParameterBindings(args, layout);
  return createLazyFrame(
    parameters.evaluated,
    { ...legacyFunctionBindings(fn), ...parameters.lazy },
    context,
    { attachLocalFunctions: true },
  );
}

function seedFunctionCaptures(fn: FunctionBody, context: EvaluationContext): EvaluationContext {
  const captures = fn.$captures;
  if (captures === undefined) return context;
  if (captures === null || typeof captures !== "object" || Array.isArray(captures)) {
    exprError(fn, "Function $captures must be a non-null object of function bodies.");
  }

  const names = Object.keys(captures);
  if (names.length === 0) return context;
  const functions = { ...context.functions };
  for (const name of names) {
    const definition = captures[name];
    if (!isFunctionBody(definition)) {
      exprError(fn, `Function capture "${name}" must be a function body.`);
    }
    if (!context.localFns?.has(name) || !isFunctionBody(functions[name])) {
      functions[name] = definition;
    }
  }

  const localFns = new Set(context.localFns ?? EMPTY_LOCAL_FNS);
  const attachFns = new Set(context.attachFns ?? EMPTY_LOCAL_FNS);
  for (const name of names) {
    localFns.add(name);
    attachFns.add(name);
  }
  const getVarParent = context.getVar;
  const getVar = (name: string): JSONType | undefined =>
    Object.prototype.hasOwnProperty.call(captures, name)
      ? (functions[name] as FunctionBody)
      : getVarParent?.(name);
  const environment = { functions, localFns, attachFns };
  for (const name of names) {
    registerFunctionEnvironment(captures[name]!, environment);
  }
  return { ...context, functions, getVar, localFns, attachFns };
}

function callJSONFunction(fn: FunctionBody, args: JSONType[], context: EvaluationContext) {
  const { perf } = context;
  if (perf) perf.callJSONFunction++;
  const analysis = analyzeFunctionBodyStructure(fn);
  if (!analysis.ok) {
    exprError(fn, formatFunctionBodyStructureIssue(analysis.issues[0]!));
  }
  const { limits, state } = context;
  const contract = readRuntimeFunctionContract(fn);
  if (contract !== null) {
    const prepared = prepareRuntimeContractCall(contract, args);
    const result = callFunctionInternal(contract.target as FunctionDeclaration, prepared.args, {
      ...context,
      allowAdapterAlias: true,
    });
    return enforceRuntimeContractReturn(result, prepared.returns, contract.defs);
  }

  const layout = requireParameterLayout((fn as any).$params, fn);
  validateRuntimeArguments(layout, args);
  const captureContext = seedFunctionCaptures(fn, context);
  const legacyBindings = legacyFunctionBindings(fn);
  const { getVar, functions, localFns, attachFns } =
    Object.keys(legacyBindings).length > 0
      ? bindLegacyFunctionFrame(fn, layout, args, captureContext)
      : bindParameters(layout, args, captureContext);

  return evaluateExpression(fn.$return, {
    functions,
    getVar,
    localFns,
    attachFns,
    limits,
    state,
    perf,
    runtimeDefs: context.runtimeDefs,
  });
}

function evaluateLet(expression: LetExpression, context: EvaluationContext): JSONType {
  const scope = bindExpressionBindings(expression.$let, context);
  return evaluateExpression(expression.$in, {
    ...context,
    functions: scope.functions,
    getVar: scope.getVar,
    localFns: scope.localFns,
    attachFns: scope.attachFns,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evaluateExpression(expression: JSONType, context: EvaluationContext): JSONType {
  const { perf } = context;
  if (perf) perf.evaluateExpression++;

  checkInterrupt(context);

  chargeFuel(context, 1);

  if (expression !== null && typeof expression === "object") {
    // Raw values are values, not syntax. Check before expression
    // classification so data containing keys such as $call or $var remains
    // inert when it is captured into expression position.
    if (isInert(expression)) {
      if (perf) perf.rawSkips++;
      return expression;
    }
  }

  const { getVar } = context;
  const expressionType = getExpressionType(expression, perf);
  if (perf) {
    const name = ExpressionType[expressionType] ?? String(expressionType);
    perf.exprTypeCounts[name] = (perf.exprTypeCounts[name] ?? 0) + 1;
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

      if (!isFunctionDeclaration(evaluatedFnRef)) {
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
      return resolveVar(varRef.$var, getVar, context.functions, expression);

    case ExpressionType.FunctionBody:
      if (!getVar) {
        return expression;
      }
      return replaceVars(
        expression,
        getVar,
        context.localFns ?? EMPTY_LOCAL_FNS,
        context.attachFns ?? EMPTY_LOCAL_FNS,
        context.functions,
        context,
      );

    case ExpressionType.Let:
      return evaluateLet(expression as LetExpression, context);

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
      if ("$else" in cond) {
        return evaluateExpression(cond.$else!, context);
      }
      exprError(expression, "No $cond branch matched (add $else or a [true, ...] catch-all).");

    case ExpressionType.Match:
      const match = expression as Match;
      const matchedValue = evaluateExpression(match.$match, context);
      assertMatchScalar(matchedValue, expression);
      for (const [candidate, result] of match.$cases) {
        const evaluatedCandidate = evaluateExpression(candidate, context);
        assertMatchScalar(evaluatedCandidate, expression);
        if (evaluatedCandidate === matchedValue) {
          return evaluateExpression(result, context);
        }
      }
      return evaluateExpression(match.$else, context);

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

    case ExpressionType.NonNullAssertion:
      const assertion = expression as NonNullAssertion;
      const assertedValue = evaluateExpression(assertion.$nonnull, context);
      if (assertedValue === null) {
        exprError(expression, "Assertion failed: expected a non-null value.");
      }
      return assertedValue;

    case ExpressionType.CheckedAscription:
      const ascription = expression as CheckedAscription;
      const ascribedValue = evaluateExpression(ascription.$as, context);
      return enforceRuntimeContract(
        ascribedValue,
        ascription.$type,
        context.runtimeDefs ?? {},
        "checked ascription",
      );

    case ExpressionType.PropertyAccess:
      return evaluatePropertyAccess(expression as PropertyAccess, context);

    case ExpressionType.Raw:
      const rawValue = (expression as { $raw: JSONType }).$raw;
      raw(rawValue);
      return rawValue;

    // Kept as helper calls so their locals do not enlarge this function's
    // stack frame: evaluateExpression recurses deeply for nested expressions
    // and its frame size directly bounds the evaluable nesting depth.
    case ExpressionType.Array:
      return evaluateArrayLiteral(expression as JSONType[], context);

    case ExpressionType.Object:
      return evaluateObjectLiteral(expression as { [key: string]: JSONType }, context);

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

// Array/object literals: constant-subtree detection. Scalars evaluate to
// themselves, so a pure-data subtree evaluates to identical children at every
// level. Cache its original identity and evaluation-node count: later
// evaluations avoid classification and allocation but charge the same fuel as
// the first. Any dynamic child ($var, $call, ...) suppresses caching. Without a
// scope (getVar undefined), a function-body child also evaluates to itself, so
// identity would not prove const-ness and the cache is not populated.
function evaluateArrayLiteral(array: JSONType[], context: EvaluationContext): JSONType {
  const constantCost = constantEvaluationCosts.get(array);
  if (constantCost !== undefined) {
    chargeFuel(context, constantCost - 1);
    if (context.perf) context.perf.rawSkips++;
    return array;
  }
  if (isRaw(array)) {
    if (context.perf) context.perf.rawSkips++;
    return array;
  }
  let allSame = true;
  let evaluationCost = 1;
  const evaluatedItems = array.map((item) => {
    const evaluated = evaluateExpression(item, context);
    const childCost = constantChildCost(item, evaluated);
    if (childCost === null) allSame = false;
    else evaluationCost += childCost;
    return evaluated;
  });
  if (allSame) {
    if (context.getVar) constantEvaluationCosts.set(array, evaluationCost);
    return array;
  }
  return evaluatedItems;
}

function evaluateObjectLiteral(
  object: { [key: string]: JSONType },
  context: EvaluationContext,
): JSONType {
  const constantCost = constantEvaluationCosts.get(object);
  if (constantCost !== undefined) {
    chargeFuel(context, constantCost - 1);
    if (context.perf) context.perf.rawSkips++;
    return object;
  }
  if (isRaw(object)) {
    if (context.perf) context.perf.rawSkips++;
    return object;
  }
  const stripComment = isCommentKey(object);
  let allSame = !stripComment;
  let evaluationCost = 1;
  const evaluatedObject: Record<string, JSONType> = {};
  for (const [key, value] of Object.entries(object)) {
    if (stripComment && key === "$comment") continue;
    const evaluated = evaluateExpression(value, context);
    const childCost = constantChildCost(value, evaluated);
    if (childCost === null) allSame = false;
    else evaluationCost += childCost;
    evaluatedObject[key] = evaluated;
  }
  if (allSame) {
    if (context.getVar) constantEvaluationCosts.set(object, evaluationCost);
    return object;
  }
  return evaluatedObject;
}

function evaluatePropertyAccess(expression: PropertyAccess, context: EvaluationContext): JSONType {
  const evaluatedKey = evaluateExpression(expression.$get, context);
  const evaluatedTarget = evaluateExpression(expression.$from, context);
  return accessProperty(evaluatedTarget, evaluatedKey);
}

function evaluateFunctionCall(
  fnCall: FunctionCall,
  context: EvaluationContext,
): EvaluatedFunctionCall {
  const callee = fnCall.$call;

  let fnDeclaration: FunctionDeclaration;
  if (typeof callee === "string") {
    fnDeclaration = callee;
  } else {
    const evaluatedFn = evaluateExpression(callee, context);
    if (!isFunctionDeclaration(evaluatedFn)) {
      exprError(
        fnCall,
        `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFn}.`,
      );
    }
    fnDeclaration = evaluatedFn as FunctionDeclaration;
  }

  const args = fnCall.$args.map((arg) => evaluateExpression(arg, context));

  return { fnDeclaration, args };
}
