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
  Match,
  Cast,
  PropertyAccess,
  EvaluatedFunctionCall,
  PerfStats,
  Meter,
} from "../types";
import { ExpressionType } from "../types";
import { exprError, isCommentKey, isPure, isBuiltin, isRaw, raw } from "../utils";
import {
  CONTRACT_KEY,
  enforceRuntimeContractReturn,
  prepareRuntimeContractCall,
  readRuntimeFunctionContract,
} from "../runtime-contract";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "../definition-pool";
import { requireParameterLayout, validateRuntimeArguments, type ParameterLayout } from "../params";
import { isFnDeclaration, replaceVars } from "./closures";
import {
  accountForResult,
  chargeFuel,
  checkInterrupt,
  createExecutionState,
  guardValueSize,
} from "./execution";
import { getExpressionType } from "./expression-type";
import { accessProperty } from "./property-access";

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
const EMPTY_PARAMETER_LAYOUT: ParameterLayout = {
  slots: [],
  fixedCount: 0,
  requiredCount: 0,
  omittableCount: 0,
  rest: null,
};

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

export function callFunction(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): JSONType {
  const execution = createExecutionState(limits);
  try {
    return callFunctionInternal(fn, args, {
      functions,
      // The supplied registry is persistent, but locals declared by this
      // function are not. Seed explicit empty sets so escaping closures attach
      // those locals instead of treating the function body like module scope.
      localFns: EMPTY_LOCAL_FNS,
      attachFns: EMPTY_LOCAL_FNS,
      limits: execution.limits,
      state: execution.state,
      perf: execution.perf,
      runtimeDefs: mergeDefinitionPools(definitions),
    });
  } finally {
    execution.syncUsage();
  }
}

// Run a program: treat the module (an object mapping names to expressions) as
// the outermost lexical `letrec` frame, layered over the host-supplied
// `baseRegistry` (stdlib + native builtins) as its parent frame, then invoke a
// chosen entry point within that scope. This makes top-level names — constants
// *and* functions — visible via `$var` and `$fn` throughout the module, the
// same semantics function bodies already have for their locals.
export function callProgram(
  module: Record<string, JSONType>,
  entry: string,
  args: JSONType[],
  baseRegistry: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): JSONType {
  const execution = createExecutionState(limits);
  const runtimeDefs = mergeDefinitionPools(definitions, readModuleDefinitions(module));
  try {
    // The module is a function body with no `$params` and no `$return`.
    const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
      module as unknown as FunctionBody,
      [],
      EMPTY_PARAMETER_LAYOUT,
      {
        functions: baseRegistry,
        limits: execution.limits,
        state: execution.state,
        perf: execution.perf,
        runtimeDefs,
      },
    );

    // Fail fast: the entry must be a function *defined by the module*. Check the
    // module's own keys (not the merged `scopedFunctions`, which layers stdlib
    // underneath) so a typo or a missing entry that collides with a stdlib name
    // (e.g. "map") errors instead of silently invoking the builtin, and a
    // non-function constant can't be handed to the caller as if callable.
    const moduleEntry = Object.prototype.hasOwnProperty.call(module, entry)
      ? module[entry]
      : undefined;
    const isModuleFunction =
      typeof moduleEntry === "object" &&
      moduleEntry !== null &&
      !Array.isArray(moduleEntry) &&
      "$return" in moduleEntry;
    if (!isModuleFunction) {
      throw new Error(`Program entry "${entry}" is not a function defined by the module`);
    }

    // Each captured module function already had its free `$var`s substituted
    // against the module scope, so `scopedFunctions[entry]` is the closed-over
    // version. Pass `getVar` as its parent frame for consistency with locals.
    return callFunctionInternal(scopedFunctions[entry] as FunctionDeclaration, args, {
      functions: scopedFunctions,
      getVar,
      localFns,
      attachFns,
      limits: execution.limits,
      state: execution.state,
      perf: execution.perf,
      runtimeDefs,
    });
  } finally {
    execution.syncUsage();
  }
}

/**
 * Prepare a program's module scope once and return the pieces a host trampoline
 * needs to drive a task across multiple synchronous hops
 * (`plans/effects-implementation.md` §4) without re-closing over the module each
 * time. `runTask` (see `host.ts`) is the sole intended consumer.
 *
 * - `invokeEntry` runs a chosen module entry (same validation as `callProgram`).
 * - `call` applies any function value in module scope — used by `stepTask` to
 *   run `bind` continuations and by the host to answer a suspended `resume`.
 *   Captured continuations and closed-over module functions are self-contained,
 *   so re-entry needs no fresh substitution.
 * - `meter` charges the shared budget for the `stepTask` normalization walk.
 * - `refreshDeadline` re-arms the wall-clock backstop before a hop, so time a
 *   host spends awaiting an async capability does not count against the task.
 *
 * All hops share one `state`/`limits`: fuel is a single budget for the whole
 * run, so a task cannot escape its budget by suspending. `signal`/`maxFuel`/
 * `maxValueSize`/`maxCallDepth` behave exactly as in `callFunction`.
 */
export function prepareProgram(
  module: Record<string, JSONType>,
  baseRegistry: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): {
  invokeEntry: (entry: string, args: JSONType[]) => JSONType;
  call: (fn: JSONType, args: JSONType[]) => JSONType;
  meter: Meter;
  refreshDeadline: () => void;
} {
  const execution = createExecutionState(limits);
  const runtimeDefs = mergeDefinitionPools(definitions, readModuleDefinitions(module));

  // The module is a function body with no `$params`/`$return`; build its scope
  // once (mirrors `callProgram`).
  const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
    module as unknown as FunctionBody,
    [],
    EMPTY_PARAMETER_LAYOUT,
    {
      functions: baseRegistry,
      limits: execution.limits,
      state: execution.state,
      perf: execution.perf,
      runtimeDefs,
    },
  );

  const context: EvaluationContext = {
    functions: scopedFunctions,
    getVar,
    localFns,
    attachFns,
    limits: execution.limits,
    state: execution.state,
    perf: execution.perf,
    runtimeDefs,
  };

  const call = (fn: JSONType, args: JSONType[]): JSONType => {
    const result = callFunctionInternal(fn as FunctionDeclaration, args, context);
    execution.syncUsage();
    return result;
  };

  const meter: Meter = {
    charge: (amount: number) => chargeFuel(context, amount),
    guardSize: (size: number) => guardValueSize(context, size),
  };

  const invokeEntry = (entry: string, args: JSONType[]): JSONType => {
    // Fail fast on a non-function or stdlib-shadowing entry, exactly as
    // `callProgram` does (check the module's own keys, not `scopedFunctions`).
    const moduleEntry = Object.prototype.hasOwnProperty.call(module, entry)
      ? module[entry]
      : undefined;
    const isModuleFunction =
      typeof moduleEntry === "object" &&
      moduleEntry !== null &&
      !Array.isArray(moduleEntry) &&
      "$return" in moduleEntry;
    if (!isModuleFunction) {
      throw new Error(`Program entry "${entry}" is not a function defined by the module`);
    }
    return call(scopedFunctions[entry] as FunctionDeclaration, args);
  };

  return { invokeEntry, call, meter, refreshDeadline: execution.refreshDeadline };
}

function callFunctionInternal(
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
      const lexical = context.getVar?.(fn);
      if (lexical !== undefined && isFnDeclaration(lexical)) {
        result = callFunctionInternal(lexical, args, context);
        raw(result);
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
          const meter: Meter = {
            charge: (amount: number) => chargeFuel(context, amount),
            guardSize: (size: number) => guardValueSize(context, size),
          };
          result = entry(args, call, functions, meter, { defs: context.runtimeDefs ?? {} });
          accountForResult(context, result);
        } else {
          result = callExternalFunction(entry, args, fn, context);
        }
      } else {
        result = callJSONFunction(entry as FunctionBody, args, {
          functions,
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
      result = callJSONFunction(fn as FunctionBody, args, context);
    }
    raw(result);
    return result;
  } finally {
    context.state.depth--;
  }
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
      result = fn(...args);
    } catch (e) {
      throw new Error(`Error calling external function ${name}: ${e}`);
    }
    accountForResult(context, result);
    return result;
  }
  const safeArgs = args.map((a) => cloneIfNeeded(a, perf));
  let result: JSONType;
  try {
    result = cloneIfNeeded(fn(...safeArgs), perf);
  } catch (e) {
    throw new Error(`Error calling external function ${name}: ${e}`);
  }
  accountForResult(context, result);
  return result;
}

// Construct the lazy, mutually-recursive `letrec` scope shared by every
// object-of-bindings — a function body's locals today, and (via `callProgram`)
// the top-level module. Registers function-valued siblings into a
// `scopedFunctions` table (callable via `$fn`), binds params, exposes every
// binding as a lazily-evaluated, memoized, cycle-checked `$var` through
// `getVar`, and closes the local functions over that scope with `replaceVars`.
// The caller decides what to do with the resulting scope (evaluate a `$return`,
// or invoke a chosen entry point).
function buildScope(
  fn: FunctionBody,
  args: JSONType[],
  layout: ParameterLayout,
  context: EvaluationContext,
): {
  getVar: (name: string) => JSONType | undefined;
  scopedFunctions: FunctionRegistry;
  localFns: ReadonlySet<string>;
  attachFns: ReadonlySet<string>;
} {
  const { functions, getVar: getVarParent, limits, state } = context;

  const localFnKeys: string[] = [];
  let scopedFunctions = functions;
  for (const key of Object.keys(fn)) {
    if (
      key === "$return" ||
      key === "$params" ||
      key === "$sig" ||
      key === "$types" ||
      key === CONTRACT_KEY
    )
      continue;
    const val = fn[key];
    if (key === "$comment" && typeof val === "string") continue;
    if (typeof val === "object" && val !== null && !Array.isArray(val) && "$return" in val) {
      if (scopedFunctions === functions) scopedFunctions = { ...functions };
      scopedFunctions[key] = val as FunctionBody;
      localFnKeys.push(key);
    }
  }

  // Accumulate this scope's local function names onto the parent chain. Only
  // allocate a new set when this scope actually introduces local functions.
  const parentLocalFns = context.localFns ?? EMPTY_LOCAL_FNS;
  let localFns = parentLocalFns;
  if (localFnKeys.length > 0) {
    const merged = new Set(parentLocalFns);
    for (const key of localFnKeys) merged.add(key);
    localFns = merged;
  }

  // Attachable subset for escaping-closure capture. `context.attachFns` is
  // `undefined` only at the root/module scope, whose functions are registry-
  // backed for the program's whole lifetime and so must never be attached
  // (attaching a self-referential module function is the source of the
  // capture blow-up). Nested scopes accumulate their own local functions.
  const parentAttachFns = context.attachFns;
  let attachFns: ReadonlySet<string>;
  if (parentAttachFns === undefined) {
    attachFns = EMPTY_LOCAL_FNS;
  } else if (localFnKeys.length > 0) {
    const merged = new Set(parentAttachFns);
    for (const key of localFnKeys) merged.add(key);
    attachFns = merged;
  } else {
    attachFns = parentAttachFns;
  }

  const evaluatedVars: Record<string, JSONType> = {};
  const pendingDefaults = new Map<string, JSONType>();
  for (const slot of layout.slots) {
    if (slot.kind === "rest") {
      evaluatedVars[slot.name] = args.slice(slot.index);
      continue;
    }
    if (slot.kind === "fields") {
      // Object pattern: destructure the positional argument into named locals.
      // Runtime validation guarantees a supplied plain object and all required
      // own fields. Absent defaulted properties register defaults lazily.
      const value = args[slot.index] as Record<string, JSONType>;
      for (const binding of slot.bindings) {
        if (Object.prototype.hasOwnProperty.call(value, binding.name)) {
          evaluatedVars[binding.name] = value[binding.name]!;
        } else if (binding.kind === "defaulted") {
          pendingDefaults.set(binding.name, binding.defaultExpression);
        } else if (binding.kind === "optional") {
          evaluatedVars[binding.name] = null;
        }
      }
      continue;
    }
    if (slot.index < args.length) {
      // Presence is positional, so explicit null and other falsy values suppress
      // a default.
      evaluatedVars[slot.name] = args[slot.index]!;
    } else if (slot.kind === "defaulted") {
      pendingDefaults.set(slot.name, slot.defaultExpression);
    } else if (slot.kind === "optional") {
      evaluatedVars[slot.name] = null;
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

    if (pendingDefaults.has(name)) {
      resolvingVars.push(name);
      try {
        const evaluated = evaluateExpression(pendingDefaults.get(name)!, {
          functions: scopedFunctions,
          getVar,
          localFns,
          attachFns,
          limits,
          state,
          perf: context.perf,
          runtimeDefs: context.runtimeDefs,
        });
        pendingDefaults.delete(name);
        evaluatedVars[name] = evaluated;
        return evaluated;
      } finally {
        resolvingVars.pop();
      }
    }

    const expression = fn[name];
    if (expression !== undefined && !(name === "$comment" && typeof expression === "string")) {
      resolvingVars.push(name);
      try {
        const evaluated = evaluateExpression(expression, {
          functions: scopedFunctions,
          getVar,
          localFns,
          attachFns,
          limits,
          state,
          perf: context.perf,
          runtimeDefs: context.runtimeDefs,
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
      // Close over for in-scope registry dispatch: substitute free `$var`s but
      // keep sibling function names literal (attach mode off), so recursion and
      // mutual recursion resolve through `scopedFunctions`. These closed-over
      // bodies are what `attachFreeLocalFns` later re-attaches to escaping
      // closures.
      scopedFunctions[key] = replaceVars(
        fn[key]!,
        getVar,
        localFns,
        attachFns,
        undefined,
        context,
      ) as FunctionBody;
    }
  }

  return { getVar, scopedFunctions, localFns, attachFns };
}

function callJSONFunction(fn: FunctionBody, args: JSONType[], context: EvaluationContext) {
  const { perf } = context;
  if (perf) perf.callJSONFunction++;
  const { limits, state } = context;
  const contract = readRuntimeFunctionContract(fn);
  if (contract !== null) {
    const prepared = prepareRuntimeContractCall(contract, args);
    const result = callFunctionInternal(
      contract.target as FunctionDeclaration,
      prepared.args,
      context,
    );
    return enforceRuntimeContractReturn(result, prepared.returns, contract.defs);
  }

  const layout = requireParameterLayout((fn as any).$params, fn);
  validateRuntimeArguments(layout, args);
  const { getVar, scopedFunctions, localFns, attachFns } = buildScope(fn, args, layout, context);

  return evaluateExpression(fn.$return, {
    functions: scopedFunctions,
    getVar,
    localFns,
    attachFns,
    limits,
    state,
    perf,
    runtimeDefs: context.runtimeDefs,
  });
}

function evaluateExpression(expression: JSONType, context: EvaluationContext): JSONType {
  const { perf } = context;
  if (perf) perf.evaluateExpression++;

  checkInterrupt(context);

  chargeFuel(context, 1);

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

    case ExpressionType.Cast:
      const cast = expression as Cast;
      const castValue = evaluateExpression(cast.$cast, context);
      if (castValue === null) {
        exprError(expression, "Assertion failed: expected a non-null value.");
      }
      return castValue;

    case ExpressionType.PropertyAccess:
      return evaluatePropertyAccess(expression as PropertyAccess, context);

    case ExpressionType.Raw:
      const rawValue = (expression as { $raw: JSONType }).$raw;
      raw(rawValue);
      return rawValue;

    case ExpressionType.Array:
      const array = expression as JSONType[];
      if (isRaw(array)) {
        if (perf) perf.rawSkips++;
        return array;
      }
      return array.map((item) => evaluateExpression(item, context));

    case ExpressionType.Object:
      const object = expression as { [key: string]: JSONType };
      if (isRaw(object)) {
        if (perf) perf.rawSkips++;
        return object;
      }
      const stripComment = isCommentKey(object);
      const evaluatedObject: Record<string, JSONType> = {};
      for (const [key, value] of Object.entries(object)) {
        if (stripComment && key === "$comment") continue;
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
    if (!isFnDeclaration(evaluatedFn)) {
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
