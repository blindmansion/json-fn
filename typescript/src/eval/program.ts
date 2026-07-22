import type {
  ExecutionLimits,
  FunctionBody,
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
import { isFunctionBody } from "../function-value";
import type { ParameterLayout } from "../params";
import { chargeFuel, createExecutionState, guardValueSize } from "./execution";
import type { EvaluationContext } from "./internal-types";
import { buildScope, callFunctionInternal } from "./interpreter";

const EMPTY_LOCAL_FNS: ReadonlySet<string> = new Set();
const EMPTY_PARAMETER_LAYOUT: ParameterLayout = {
  slots: [],
  fixedCount: 0,
  requiredCount: 0,
  omittableCount: 0,
  rest: null,
};

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
  const { getVar, scopedFunctions, localFns, attachFns } = buildScope(
    module as unknown as FunctionBody,
    [],
    EMPTY_PARAMETER_LAYOUT,
    session.context,
  );
  session.context = {
    ...session.context,
    functions: scopedFunctions,
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
  const session = createEvaluationSession(functions, limits, definitions);
  try {
    return callFunctionInternal(fn, args, {
      ...session.context,
      // The supplied registry is persistent, but locals declared by this
      // function are not. Seed explicit empty sets so escaping closures attach
      // those locals instead of treating the function body like module scope.
      localFns: EMPTY_LOCAL_FNS,
      attachFns: EMPTY_LOCAL_FNS,
    });
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
  const session = createProgramSession(module, baseRegistry, limits, definitions);
  try {
    initializeProgramScope(session, module);
    const fn = getProgramEntry(module, entry, session.context.functions);
    return callFunctionInternal(fn, args, session.context);
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
  const session = createProgramSession(module, baseRegistry, limits, definitions);
  initializeProgramScope(session, module);

  const call = (fn: JSONType, args: JSONType[]): JSONType => {
    const result = callFunctionInternal(fn as FunctionDeclaration, args, session.context);
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
