import type {
  JSONType,
  FunctionCall,
  FunctionReference,
  FunctionDeclaration,
  EvaluationContext,
  ExecutionLimits,
  FunctionBody,
  FunctionRegistry,
  ResolvedLimits,
  VariableReference,
  Conditional,
  Cond,
  Match,
  ComparisonExpression,
  ComparisonOperator,
  NotExpression,
  PropertyAccess,
  EvaluatedFunctionCall,
  PerfStats,
  CallState,
  Meter,
  Param,
} from "./types";
import { ExpressionType } from "./types";
import {
  exprError,
  expressionKeyCount,
  isCommentKey,
  isPure,
  isBuiltin,
  isRaw,
  raw,
} from "./utils";

export function createPerfStats(): PerfStats {
  return {
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
}

const COMPARISON_OPERATORS: ComparisonOperator[] = ["$eq", "$neq", "$lt", "$lte", "$gt", "$gte"];

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

function isFnDeclaration(value: JSONType): value is FunctionDeclaration {
  return (
    typeof value === "string" ||
    (typeof value === "object" && value !== null && !Array.isArray(value) && "$return" in value)
  );
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

const DEFAULT_MAX_CALL_DEPTH = 256;

export function callFunction(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry,
  limits?: ExecutionLimits,
): JSONType {
  const maxFuel = limits?.maxFuel ?? Infinity;
  const maxValueSize = limits?.maxValueSize ?? Infinity;
  const usage = limits?.usage;
  const timeoutMs = limits?.timeoutMs;
  const deadline = timeoutMs !== undefined && timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
  const state: CallState = { depth: 0, fuel: 0 };
  try {
    return callFunctionInternal(fn, args, {
      functions,
      limits: {
        maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
        maxFuel,
        maxValueSize,
        trackFuel: maxFuel < Infinity || usage !== undefined,
        signal: limits?.signal,
        deadline,
      },
      state,
      perf: limits?.perf,
    });
  } finally {
    if (usage) usage.fuel = state.fuel;
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
): JSONType {
  const maxFuel = limits?.maxFuel ?? Infinity;
  const maxValueSize = limits?.maxValueSize ?? Infinity;
  const usage = limits?.usage;
  const timeoutMs = limits?.timeoutMs;
  const deadline = timeoutMs !== undefined && timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
  const state: CallState = { depth: 0, fuel: 0 };
  const resolved: ResolvedLimits = {
    maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
    maxFuel,
    maxValueSize,
    trackFuel: maxFuel < Infinity || usage !== undefined,
    signal: limits?.signal,
    deadline,
  };
  const perf = limits?.perf;
  try {
    // The module is a function body with no `$params` and no `$return`.
    const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
      module as unknown as FunctionBody,
      [],
      {
        functions: baseRegistry,
        limits: resolved,
        state,
        perf,
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
      limits: resolved,
      state,
      perf,
    });
  } finally {
    if (usage) usage.fuel = state.fuel;
  }
}

// Cooperative interrupt check: cancellation signal + wall-clock deadline. Both
// are host-only backstops (never charge fuel, so anchor fuel counts are
// unaffected). Checked at every node *and* every invocation so native
// higher-order loops over pure builtins — which never re-enter
// evaluateExpression — can still be cancelled/timed out.
function checkInterrupt(context: EvaluationContext): void {
  const { signal, deadline } = context.limits;
  if (signal?.aborted) {
    throw new Error("Execution aborted");
  }
  if (deadline !== Infinity && Date.now() > deadline) {
    throw new Error("Execution timed out");
  }
}

function chargeFuel(context: EvaluationContext, amount: number): void {
  if (!context.limits.trackFuel) return;
  context.state.fuel += amount;
  if (context.state.fuel > context.limits.maxFuel) {
    throw new Error(`Maximum fuel limit of ${context.limits.maxFuel} exceeded`);
  }
}

function guardValueSize(context: EvaluationContext, size: number): void {
  if (size > context.limits.maxValueSize) {
    throw new Error(`Maximum value size of ${context.limits.maxValueSize} exceeded`);
  }
}

// Charges fuel and enforces the size cap for values produced by host functions,
// proportional to the length of any produced array or string. This is the
// chokepoint that keeps size-growing pure builtins (concat, flatten, split,
// join, ...) honest without each needing to self-meter.
function accountForResult(context: EvaluationContext, result: JSONType): void {
  if (typeof result === "string" || Array.isArray(result)) {
    guardValueSize(context, result.length);
    chargeFuel(context, result.length);
  }
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
          result = entry(args, call, functions, meter);
        } else {
          result = callExternalFunction(entry, args, fn, context);
        }
      } else {
        result = callJSONFunction(entry as FunctionBody, args, {
          functions,
          limits: context.limits,
          state: context.state,
          perf,
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
    if (key === "$return" || key === "$params") continue;
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

  const params = (fn as any).$params as Param[] | undefined;
  if (params) {
    for (let i = 0; i < params.length; i++) {
      const slot = params[i]!;
      if (typeof slot === "string") {
        if (slot.startsWith("...")) {
          const restName = slot.slice(3);
          evaluatedVars[restName] = args.slice(i);
          break;
        }
        evaluatedVars[slot] = args[i] ?? null;
      } else {
        // Object pattern: destructure the i-th positional argument into named
        // locals. Lenient — a missing/null/non-object/array argument binds
        // every field to null (mirrors positional params defaulting to null).
        const v = args[i] ?? null;
        const isPlainObject = typeof v === "object" && v !== null && !Array.isArray(v);
        for (const field of slot.$fields) {
          evaluatedVars[field] = isPlainObject ? ((v as any)[field] ?? null) : null;
        }
      }
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

  const { getVar, scopedFunctions, localFns, attachFns } = buildScope(fn, args, context);

  return evaluateExpression(fn.$return, {
    functions: scopedFunctions,
    getVar,
    localFns,
    attachFns,
    limits,
    state,
    perf,
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

    case ExpressionType.Comparison:
      return evaluateComparisonExpression(expression as ComparisonExpression, context);

    case ExpressionType.Not:
      return !evaluateExpression((expression as NotExpression).$not, context);

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

// Closure capture. Substitutes free `$var`s and captures function-valued
// callees, and — when `localFnDefs` is supplied ("attach mode") — makes an
// escaping function body self-contained by re-attaching the enclosing local
// functions it still references by name (see `attachFreeLocalFns`). Attach mode
// is off while `buildScope` closes over local functions for *in-scope*
// registry dispatch: those must keep sibling names literal, and `localFnDefs`
// is exactly the set of closed-over bodies produced there.
function replaceVars(
  expression: JSONType,
  getVar: (name: string) => JSONType | undefined,
  localFns: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry | undefined,
  context: EvaluationContext,
): JSONType {
  const { perf } = context;
  if (perf) perf.replaceVars++;
  if (typeof expression === "object" && expression !== null && isRaw(expression)) {
    if (perf) perf.rawSkips++;
    return expression;
  }
  if (Array.isArray(expression)) {
    return expression.map((item) =>
      replaceVars(item, getVar, localFns, attachFns, localFnDefs, context),
    );
  }

  if (typeof expression === "object" && expression !== null) {
    if ("$var" in expression && typeof expression.$var === "string") {
      const varValue = getVar(expression.$var);
      return varValue === undefined ? expression : varValue;
    }

    if ("$return" in expression) {
      const localNames = new Set(
        Object.keys(expression).filter((k) => {
          if (k === "$return" || k === "$params") return false;
          if (k === "$comment" && typeof (expression as Record<string, JSONType>)[k] === "string")
            return false;
          return true;
        }),
      );

      const params = expression.$params;
      if (Array.isArray(params)) {
        for (const p of params) {
          if (typeof p === "string") {
            localNames.add(p.startsWith("...") ? p.slice(3) : p);
          } else if (p && typeof p === "object" && Array.isArray((p as any).$fields)) {
            for (const f of (p as any).$fields as string[]) localNames.add(f);
          }
        }
      }

      const maskedGetVar =
        localNames.size > 0
          ? (name: string) => (localNames.has(name) ? undefined : getVar(name))
          : getVar;

      const newObject: Record<string, JSONType> = {};
      for (const [key, value] of Object.entries(expression)) {
        newObject[key] = replaceVars(
          value,
          maskedGetVar,
          localFns,
          attachFns,
          localFnDefs,
          context,
        );
      }
      // Re-attach the enclosing local functions this escaping body still calls
      // by name, so it stays callable once it leaves its defining scope. Off
      // during in-scope close-over (localFnDefs undefined), where sibling names
      // must remain literal for registry dispatch. Only *attachable* names are
      // considered (`attachFns`): registry-backed module functions are excluded,
      // since they resolve by name for the program's lifetime and inlining a
      // self-referential one blows capture up (see `attachFns` in types.ts).
      if (localFnDefs !== undefined && attachFns.size > 0) {
        attachFreeLocalFns(newObject, localNames, attachFns, localFnDefs, context);
      }
      return newObject;
    }

    // FunctionCall: capture a free callee identifier into the closure, mirroring
    // $var capture above. A bare-identifier callee lowers to a literal registry
    // name, so a combinator's function argument (e.g. `f` in `twice`/`compose`)
    // or a shadowing parameter (a param named like a stdlib builtin) would be
    // lost once the inner lambda escapes the defining scope.
    //
    // P4/Site 2 (Option A): capture when the callee resolves via `getVar` to a
    // function declaration *and* it is not a scoped local function name. Local
    // function names stay literal so they keep dispatching through the registry
    // (recursion/mutual-recursion are preserved). The current body's own
    // params/locals are masked out of `getVar` upstream, so only free lexical
    // bindings of *enclosing* scopes are captured — which is exactly what lets a
    // shadowing parameter survive an escaping closure (`{ f:(map)=> (x)=> map(x) }`).
    const fnArr = (expression as Record<string, JSONType>).$fn;
    if (Array.isArray(fnArr)) {
      const callee = fnArr[0];
      const newArr = fnArr.map((item, idx) => {
        if (idx === 0 && typeof callee === "string" && !localFns.has(callee)) {
          const captured = getVar(callee);
          return captured !== undefined && isFnDeclaration(captured) ? captured : item;
        }
        return replaceVars(item, getVar, localFns, attachFns, localFnDefs, context);
      });
      return { ...expression, $fn: newArr };
    }

    const newObject: Record<string, JSONType> = {};
    for (const [key, value] of Object.entries(expression)) {
      newObject[key] = replaceVars(value, getVar, localFns, attachFns, localFnDefs, context);
    }
    return newObject;
  }

  return expression;
}

// Collect names in `attachFns` referenced by `node` at its own scope level, in
// call position (`{ $fn: ["name", ...] }`) or as a function reference
// (`{ $fn: "name" }`). Nested function bodies are scope boundaries: they are
// skipped here because they re-attach their own free local functions when they
// are themselves captured. `$var`-position references to local functions are
// already inlined by `replaceVars`, so they never reach this scan as names.
function collectLocalFnRefs(
  node: JSONType,
  attachFns: ReadonlySet<string>,
  out: Set<string>,
): void {
  if (node === null || typeof node !== "object") return;
  if (isRaw(node)) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLocalFnRefs(item, attachFns, out);
    return;
  }
  if ("$return" in node) return;

  const fnVal = (node as Record<string, JSONType>).$fn;
  if (Array.isArray(fnVal)) {
    const callee = fnVal[0];
    if (typeof callee === "string" && attachFns.has(callee)) out.add(callee);
    for (const item of fnVal) collectLocalFnRefs(item, attachFns, out);
    return;
  }
  if (typeof fnVal === "string") {
    if (attachFns.has(fnVal)) out.add(fnVal);
    return;
  }
  for (const value of Object.values(node)) collectLocalFnRefs(value, attachFns, out);
}

// Scan a function body's own level (its `$return` and locals, not nested
// lambdas) for referenced attachable-function names.
function collectBodyLevelLocalFnRefs(
  body: Record<string, JSONType>,
  attachFns: ReadonlySet<string>,
  out: Set<string>,
): void {
  for (const [key, value] of Object.entries(body)) {
    if (key === "$params") continue;
    if (key === "$comment" && typeof value === "string") continue;
    collectLocalFnRefs(value, attachFns, out);
  }
}

// Count the JSON nodes in a value — used to meter escaping-closure attachment
// so a runaway capture fails against the value-size/fuel limits instead of
// hanging (the safety net for pathological but bounded capture growth).
function countNodes(node: JSONType): number {
  if (node === null || typeof node !== "object") return 1;
  let n = 1;
  if (Array.isArray(node)) {
    for (const item of node) n += countNodes(item);
  } else {
    for (const value of Object.values(node)) n += countNodes(value);
  }
  return n;
}

// Make an escaping function body self-contained: for every enclosing local
// function it still references by name (kept literal so recursion/mutual
// recursion dispatch through the scope), attach that function's closed-over
// definition as a sibling local. Only `attachFns` names are eligible —
// registry-backed module functions are deliberately excluded (see
// `attachFns` in types.ts). Definitions come from `localFnDefs` (the scope's
// closed-over registry) rather than `getVar`, so mutually recursive clusters
// do not trip the lazy-`$var` cycle detector. The walk is transitive (an
// attached function pulls in the siblings it calls) and cycle-safe (names
// already present are skipped). Names bound by this body — its own params and
// locals — are never attached, preserving shadowing. Each attached definition
// is charged to the fuel/value-size budget so runaway capture fails fast.
function attachFreeLocalFns(
  body: Record<string, JSONType>,
  boundNames: ReadonlySet<string>,
  attachFns: ReadonlySet<string>,
  localFnDefs: FunctionRegistry,
  context: EvaluationContext,
): void {
  const queue: string[] = [];
  const seen = new Set<string>();
  collectBodyLevelLocalFnRefs(body, attachFns, seen);
  queue.push(...seen);

  let attachedNodes = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (name in body || boundNames.has(name)) continue;
    const def = localFnDefs[name];
    if (def === undefined || typeof def !== "object" || def === null || !("$return" in def)) {
      continue;
    }
    // Meter the attachment (Part B safety net): charge and size-guard before
    // embedding, so an unexpectedly large or growing capture raises a clean
    // limit error rather than silently ballooning.
    attachedNodes += countNodes(def as JSONType);
    guardValueSize(context, attachedNodes);
    chargeFuel(context, attachedNodes);
    body[name] = def as JSONType;
    const more = new Set<string>();
    collectBodyLevelLocalFnRefs(def as Record<string, JSONType>, attachFns, more);
    for (const ref of more) {
      if (!(ref in body) && !boundNames.has(ref) && !seen.has(ref)) {
        seen.add(ref);
        queue.push(ref);
      }
    }
  }
}

function getComparisonOperator(json: Record<string, JSONType>): ComparisonOperator | undefined {
  for (const key of Object.keys(json)) {
    if (COMPARISON_OPERATORS.includes(key as ComparisonOperator)) {
      return key as ComparisonOperator;
    }
  }
  return undefined;
}

function evaluateComparisonExpression(
  expression: ComparisonExpression,
  context: EvaluationContext,
): boolean {
  const op = getComparisonOperator(expression as Record<string, JSONType>)!;
  const args = expression[op]!;
  const left = evaluateExpression(args[0]!, context);
  const right = evaluateExpression(args[1]!, context);

  switch (op) {
    case "$eq":
      return left === right;
    case "$neq":
      return left !== right;
    case "$lt":
      return (left as number) < (right as number);
    case "$lte":
      return (left as number) <= (right as number);
    case "$gt":
      return (left as number) > (right as number);
    case "$gte":
      return (left as number) >= (right as number);
  }
}

function evaluatePropertyAccess(expression: PropertyAccess, context: EvaluationContext): JSONType {
  const evaluatedKey = evaluateExpression(expression.$get, context);
  const evaluatedTarget = evaluateExpression(expression.$from, context);

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
    // Walk a folded static path one segment at a time, with the same per-step
    // semantics as a single `$get`: index into strings by number, return null
    // for a missing object key, and throw on a non-object/non-string target.
    // Keeping this in lockstep with the scalar case makes static-segment
    // folding purely an optimization (it never changes results).
    let current: JSONType = evaluatedTarget;
    for (const segment of evaluatedKey) {
      if (typeof current === "string") {
        if (typeof segment !== "number") {
          throw new Error(
            `Invalid $get key for string: expected number, got ${JSON.stringify(segment)}`,
          );
        }
        const ch: JSONType | undefined = current[segment];
        if (ch === undefined) return null;
        current = ch;
      } else if (current === null || typeof current !== "object") {
        throw new Error(
          `Invalid $get path traversal: cannot access property ${JSON.stringify(
            segment,
          )} on ${JSON.stringify(current)}`,
        );
      } else {
        const next: JSONType | undefined = (current as any)[segment as string | number];
        if (next === undefined) return null;
        current = next;
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

  let fnDeclaration: FunctionDeclaration;
  if (typeof fnExpr === "string") {
    fnDeclaration = fnExpr;
  } else {
    const evaluatedFn = evaluateExpression(fnExpr, context);
    if (!isFnDeclaration(evaluatedFn)) {
      exprError(
        fnCall,
        `Evaluated function references must be strings or function bodies. Got ${typeof evaluatedFn}.`,
      );
    }
    fnDeclaration = evaluatedFn as FunctionDeclaration;
  }

  const args: JSONType[] = [];
  for (let i = 1; i < fnArray.length; i++) {
    args.push(evaluateExpression(fnArray[i]!, context));
  }

  return { fnDeclaration, args };
}

function getExpressionType(json: JSONType, perf?: PerfStats): ExpressionType {
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

    if ("$return" in json) {
      if ("$fn" in json) {
        exprError(json, "Function bodies cannot have other keyword properties.");
      }
      if ("$params" in json) {
        const params = json.$params;
        if (!Array.isArray(params)) {
          exprError(json, "$params must be an array.");
        }
        for (const p of params) {
          if (typeof p === "string") continue;
          if (p !== null && typeof p === "object" && !Array.isArray(p) && "$fields" in p) {
            const fields = (p as { $fields: JSONType }).$fields;
            if (
              !Array.isArray(fields) ||
              fields.length === 0 ||
              !fields.every((f) => typeof f === "string")
            ) {
              exprError(json, "$fields must be a non-empty array of strings.");
            }
            continue;
          }
          exprError(json, "$params entries must be strings or { $fields: [...] } patterns.");
        }
      }
      return ExpressionType.FunctionBody;
    }

    if ("$fn" in json) {
      if (Array.isArray(json.$fn)) {
        if (expressionKeyCount(json) > 1) {
          exprError(json, "Function calls cannot have other properties.");
        }
        return ExpressionType.FunctionCall;
      }

      if (typeof json.$fn === "string" || typeof json.$fn === "object") {
        if (expressionKeyCount(json) > 1) {
          exprError(json, "Function references cannot have other properties.");
        }
        return ExpressionType.FunctionReference;
      }
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

    const comparisonOperator = getComparisonOperator(json as Record<string, JSONType>);
    if (comparisonOperator) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, `${comparisonOperator} expressions cannot have other properties.`);
      }
      const args = json[comparisonOperator];
      if (!Array.isArray(args) || args.length !== 2) {
        exprError(json, `${comparisonOperator} must be an array of two expressions.`);
      }
      return ExpressionType.Comparison;
    }

    if ("$not" in json) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, "$not expressions cannot have other properties.");
      }
      return ExpressionType.Not;
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
