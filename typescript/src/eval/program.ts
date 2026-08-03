import type {
  ExecutionLimits,
  FunctionDeclaration,
  FunctionRegistry,
  JSONType,
  Meter,
} from "../types";
import {
  mergeDefinitionPools,
  readModuleDefinitions,
  type DefinitionPool,
  type DefinitionSources,
} from "../definition-pool";
import { isFunctionBody, isFunctionDeclaration } from "../function-value";
import { markRuntimeValue } from "../runtime-values";
import { assertStructuralDepth } from "../structural-depth";
import { chargeFuel, createExecutionState, guardValueSize } from "./execution";
import type { EvaluationContext } from "./internal-types";
import { callFunctionInternal, initializeModuleBindings } from "./interpreter";

const EMPTY_LOCAL_FNS: ReadonlySet<string> = new Set();

// Public entry arguments are already-produced values, never syntax; mark them
// so expression-shaped host data stays inert without the host knowing about
// interpreter identity metadata. Function-shaped arguments stay live so they
// go through closure construction, mirroring `replaceVars` substitution.
function markEntryArguments(args: JSONType[]): void {
  for (const arg of args) {
    if (typeof arg === "object" && arg !== null && !isFunctionDeclaration(arg)) {
      markRuntimeValue(arg);
    }
  }
}

type EvaluationSession = {
  context: EvaluationContext;
  syncUsage: () => void;
  refreshDeadline: () => void;
};

function createEvaluationSession(
  functions: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
  moduleDefinitions?: DefinitionPool,
): EvaluationSession {
  const execution = createExecutionState(limits);
  return {
    context: {
      functions,
      localFns: EMPTY_LOCAL_FNS,
      attachFns: EMPTY_LOCAL_FNS,
      limits: execution.limits,
      state: execution.state,
      perf: execution.perf,
      runtimeDefs: mergeDefinitionPools(definitions, moduleDefinitions),
    },
    syncUsage: execution.syncUsage,
    refreshDeadline: execution.refreshDeadline,
  };
}

function createProgramSession(
  module: Record<string, JSONType>,
  baseRegistry: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): EvaluationSession {
  return createEvaluationSession(baseRegistry, limits, definitions, readModuleDefinitions(module));
}

function initializeProgramScope(
  session: EvaluationSession,
  module: Record<string, JSONType>,
): void {
  const { getVar, functions, localFns, attachFns } = initializeModuleBindings(
    module,
    session.context,
  );
  session.context = {
    ...session.context,
    functions,
    getVar,
    localFns,
    attachFns,
  };
}

function getProgramEntry(
  module: Record<string, JSONType>,
  entry: string,
  scopedFunctions: FunctionRegistry,
): FunctionDeclaration {
  // Check the module's own keys rather than the layered registry so a missing
  // entry that collides with a builtin cannot silently invoke that builtin.
  const moduleEntry = Object.prototype.hasOwnProperty.call(module, entry)
    ? module[entry]
    : undefined;
  if (!isFunctionBody(moduleEntry)) {
    throw new Error(`Program entry "${entry}" is not a function defined by the module`);
  }
  return scopedFunctions[entry] as FunctionDeclaration;
}

export function callFunction(
  fn: FunctionDeclaration,
  args: JSONType[],
  functions: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): JSONType {
  assertStructuralDepth(fn);
  for (const arg of args) assertStructuralDepth(arg);
  markEntryArguments(args);
  const session = createEvaluationSession(functions, limits, definitions);
  try {
    // Results are asserted on the way out too: guest programs can construct
    // values level by level (each construction step is shallow), so the exit
    // boundary is where an over-deep runtime-built value is caught.
    const result = callFunctionInternal(fn, args, session.context);
    assertStructuralDepth(result);
    return result;
  } finally {
    session.syncUsage();
  }
}

// Run a program with its top-level bindings as the outermost lexical `letrec`
// frame, layered over the host-supplied registry.
export function callProgram(
  module: Record<string, JSONType>,
  entry: string,
  args: JSONType[],
  baseRegistry: FunctionRegistry,
  limits?: ExecutionLimits,
  definitions?: DefinitionSources,
): JSONType {
  assertStructuralDepth(module);
  for (const arg of args) assertStructuralDepth(arg);
  markEntryArguments(args);
  const session = createProgramSession(module, baseRegistry, limits, definitions);
  try {
    initializeProgramScope(session, module);
    const fn = getProgramEntry(module, entry, session.context.functions);
    const result = callFunctionInternal(fn, args, session.context);
    // See callFunction: over-deep runtime-built values are caught on exit.
    assertStructuralDepth(result);
    return result;
  } finally {
    session.syncUsage();
  }
}

/**
 * Prepare a program's module scope once for a host trampoline that drives a
 * task across multiple synchronous hops. All operations share one execution
 * state, so suspension cannot reset fuel or other limits.
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
  fuelUsed: () => number;
} {
  assertStructuralDepth(module);
  const session = createProgramSession(module, baseRegistry, limits, definitions);
  initializeProgramScope(session, module);

  const call = (fn: JSONType, args: JSONType[]): JSONType => {
    assertStructuralDepth(fn);
    for (const arg of args) assertStructuralDepth(arg);
    markEntryArguments(args);
    const result = callFunctionInternal(fn as FunctionDeclaration, args, session.context);
    // See callFunction: over-deep runtime-built values are caught on exit.
    assertStructuralDepth(result);
    session.syncUsage();
    return result;
  };

  const invokeEntry = (entry: string, args: JSONType[]): JSONType =>
    call(getProgramEntry(module, entry, session.context.functions), args);

  const meter: Meter = {
    charge: (amount: number) => chargeFuel(session.context, amount),
    guardSize: (size: number) => guardValueSize(session.context, size),
  };

  return {
    invokeEntry,
    call,
    meter,
    refreshDeadline: session.refreshDeadline,
    fuelUsed: () => {
      session.syncUsage();
      return session.context.state.fuel;
    },
  };
}
