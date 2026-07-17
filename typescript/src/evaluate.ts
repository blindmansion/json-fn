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
  Cast,
  PropertyAccess,
  EvaluatedFunctionCall,
  PerfStats,
  CallState,
  Meter,
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
import {
  CONTRACT_KEY,
  enforceRuntimeContractReturn,
  prepareRuntimeContractCall,
  readRuntimeFunctionContract,
} from "./runtime-contract";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionSources,
} from "./definition-pool";
import {
  boundParameterNames,
  defaultBindings,
  normalizeParams,
  requireParameterLayout,
  validateRuntimeArguments,
  type ParameterLayout,
} from "./params";

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
  definitions?: DefinitionSources,
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
      // The supplied registry is persistent, but locals declared by this
      // function are not. Seed explicit empty sets so escaping closures attach
      // those locals instead of treating the function body like module scope.
      localFns: EMPTY_LOCAL_FNS,
      attachFns: EMPTY_LOCAL_FNS,
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
      runtimeDefs: mergeDefinitionPools(definitions),
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
  definitions?: DefinitionSources,
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
  const runtimeDefs = mergeDefinitionPools(definitions, readModuleDefinitions(module));
  try {
    // The module is a function body with no `$params` and no `$return`.
    const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
      module as unknown as FunctionBody,
      [],
      EMPTY_PARAMETER_LAYOUT,
      {
        functions: baseRegistry,
        limits: resolved,
        state,
        perf,
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
      limits: resolved,
      state,
      perf,
      runtimeDefs,
    });
  } finally {
    if (usage) usage.fuel = state.fuel;
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
  const maxFuel = limits?.maxFuel ?? Infinity;
  const maxValueSize = limits?.maxValueSize ?? Infinity;
  const usage = limits?.usage;
  const timeoutMs = limits?.timeoutMs;
  const hasTimeout = timeoutMs !== undefined && timeoutMs >= 0;
  const state: CallState = { depth: 0, fuel: 0 };
  const resolved: ResolvedLimits = {
    maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
    maxFuel,
    maxValueSize,
    trackFuel: maxFuel < Infinity || usage !== undefined,
    signal: limits?.signal,
    deadline: hasTimeout ? Date.now() + timeoutMs! : Infinity,
  };
  const perf = limits?.perf;
  const runtimeDefs = mergeDefinitionPools(definitions, readModuleDefinitions(module));

  // The module is a function body with no `$params`/`$return`; build its scope
  // once (mirrors `callProgram`).
  const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
    module as unknown as FunctionBody,
    [],
    EMPTY_PARAMETER_LAYOUT,
    { functions: baseRegistry, limits: resolved, state, perf, runtimeDefs },
  );

  const context: EvaluationContext = {
    functions: scopedFunctions,
    getVar,
    localFns,
    attachFns,
    limits: resolved,
    state,
    perf,
    runtimeDefs,
  };

  const syncUsage = (): void => {
    if (usage) usage.fuel = state.fuel;
  };

  const call = (fn: JSONType, args: JSONType[]): JSONType => {
    const result = callFunctionInternal(fn as FunctionDeclaration, args, context);
    syncUsage();
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

  const refreshDeadline = (): void => {
    if (hasTimeout) resolved.deadline = Date.now() + timeoutMs!;
  };

  return { invokeEntry, call, meter, refreshDeadline };
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
          if (
            k === "$return" ||
            k === "$params" ||
            k === "$sig" ||
            k === "$types" ||
            k === CONTRACT_KEY
          )
            return false;
          if (k === "$comment" && typeof (expression as Record<string, JSONType>)[k] === "string")
            return false;
          return true;
        }),
      );

      const layout = requireParameterLayout(expression.$params, expression);
      for (const name of boundParameterNames(layout)) localNames.add(name);

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
    if ("$call" in expression) {
      const callee = (expression as Record<string, JSONType>).$call!;
      let newCallee: JSONType = callee;
      if (typeof callee === "string") {
        if (!localFns.has(callee)) {
          const captured = getVar(callee);
          if (captured !== undefined && isFnDeclaration(captured)) newCallee = captured;
        }
      } else {
        newCallee = replaceVars(callee, getVar, localFns, attachFns, localFnDefs, context);
      }
      const args = (expression as Record<string, JSONType>).$args;
      const newArgs = Array.isArray(args)
        ? args.map((item) => replaceVars(item, getVar, localFns, attachFns, localFnDefs, context))
        : args!;
      return { ...expression, $call: newCallee, $args: newArgs };
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
// call position (`{ $call: "name", $args: [...] }`) or as a function reference
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

  if ("$call" in node) {
    const callee = (node as Record<string, JSONType>).$call!;
    if (typeof callee === "string" && attachFns.has(callee)) out.add(callee);
    else collectLocalFnRefs(callee, attachFns, out);
    const args = (node as Record<string, JSONType>).$args;
    if (Array.isArray(args)) {
      for (const item of args) collectLocalFnRefs(item, attachFns, out);
    }
    return;
  }
  const fnVal = (node as Record<string, JSONType>).$fn;
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
  const layout = requireParameterLayout(body.$params, body);
  for (const binding of defaultBindings(layout)) {
    collectLocalFnRefs(binding.expression, attachFns, out);
  }

  for (const [key, value] of Object.entries(body)) {
    if (key === "$params") continue;
    if (key === "$sig" || key === "$types" || key === CONTRACT_KEY) continue;
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

/**
 * A short, human-readable description of a `$get` target, used only to make
 * property-access errors actionable (which shape, what keys were available).
 * Object key lists are truncated so the message stays readable on wide records.
 */
function describeTarget(value: JSONType): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "an empty object";
    const shown = keys.slice(0, 8).map((k) => JSON.stringify(k));
    const suffix = keys.length > shown.length ? `, … (${keys.length} keys)` : "";
    return `an object with keys ${shown.join(", ")}${suffix}`;
  }
  if (typeof value === "string") return `a string of length ${value.length}`;
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/**
 * The likely-cause hint for a key that is neither a string nor a number. A
 * `null` key is almost always a lookup expression that evaluated to nothing
 * (an out-of-range index, a missing field, an unmatched branch), so we call
 * that out explicitly — it's the single most common property-access mistake.
 */
function keyHint(key: JSONType): string {
  if (key === null) {
    return (
      " A null key usually means a lookup expression produced no value " +
      "(e.g. an out-of-range index or a missing field); guard it before indexing."
    );
  }
  return "";
}

function evaluatePropertyAccess(expression: PropertyAccess, context: EvaluationContext): JSONType {
  const evaluatedKey = evaluateExpression(expression.$get, context);
  const evaluatedTarget = evaluateExpression(expression.$from, context);

  if (
    evaluatedTarget === null ||
    (typeof evaluatedTarget !== "object" && typeof evaluatedTarget !== "string")
  ) {
    throw new Error(
      `Cannot access property ${JSON.stringify(evaluatedKey)}: the target is ` +
        `${describeTarget(evaluatedTarget)}, not an object, array, or string.`,
    );
  }

  if (typeof evaluatedTarget === "string") {
    if (typeof evaluatedKey === "number") {
      return evaluatedTarget[evaluatedKey] ?? null;
    }
    throw new Error(
      `Cannot index a string with key ${JSON.stringify(evaluatedKey)}: string ` +
        `indices must be numbers.${keyHint(evaluatedKey)}`,
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
          `Cannot access property ${JSON.stringify(segment)} partway through a ` +
            `path: the value at that point is ${describeTarget(current)}, not an ` +
            `object, array, or string.`,
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
    `Invalid property key ${JSON.stringify(evaluatedKey)}: a key must be a ` +
      `string, number, or array of strings/numbers. Target is ` +
      `${describeTarget(evaluatedTarget)}.${keyHint(evaluatedKey)}`,
  );
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
      if ("$fn" in json || "$call" in json || "$args" in json) {
        exprError(json, "Function bodies cannot have other keyword properties.");
      }
      if ("$params" in json) {
        normalizeParams(json.$params, json);
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

    if ("$cast" in json) {
      if (expressionKeyCount(json) > 1) {
        exprError(json, "$cast expressions cannot have other properties.");
      }
      return ExpressionType.Cast;
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
