import type { ExecutionLimits, JSONType, PerfStats } from "../types";
import { codePointLength } from "../unicode";
import type { CallState, EvaluationContext, ResolvedLimits } from "./internal-types";

const DEFAULT_MAX_CALL_DEPTH = 256;

export type ExecutionState = {
  limits: ResolvedLimits;
  state: CallState;
  perf: PerfStats | undefined;
  syncUsage: () => void;
  refreshDeadline: () => void;
};

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
    rawBoundaries: 0,
    runtimeValueSkips: 0,
    preseededStaticSkips: 0,
    discoveredStaticSkips: 0,
    // Null-prototype so counter reads/writes keyed by guest-controlled names
    // (e.g. a function named "__proto__" or "constructor") stay own-property.
    exprTypeCounts: Object.create(null) as Record<string, number>,
    functionCallCounts: Object.create(null) as Record<string, number>,
    maxCallDepth: 0,
  };
}

export function createExecutionState(limits?: ExecutionLimits): ExecutionState {
  const maxFuel = limits?.maxFuel ?? Infinity;
  const usage = limits?.usage;
  const configuredTimeoutMs = limits?.timeoutMs;
  const timeoutMs =
    configuredTimeoutMs !== undefined && configuredTimeoutMs >= 0 ? configuredTimeoutMs : undefined;
  const state: CallState = { depth: 0, fuel: 0, nesting: 0 };
  const resolved: ResolvedLimits = {
    maxCallDepth: limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
    maxFuel,
    maxValueSize: limits?.maxValueSize ?? Infinity,
    trackFuel: maxFuel < Infinity || usage !== undefined,
    signal: limits?.signal,
    deadline: timeoutMs === undefined ? Infinity : Date.now() + timeoutMs,
  };

  return {
    limits: resolved,
    state,
    perf: limits?.perf,
    syncUsage: () => {
      if (usage) usage.fuel = state.fuel;
    },
    refreshDeadline: () => {
      if (timeoutMs !== undefined) resolved.deadline = Date.now() + timeoutMs;
    },
  };
}

// Cooperative interrupt check: cancellation signal + wall-clock deadline. Both
// are host-only backstops (never charge fuel, so anchor fuel counts are
// unaffected). Checked at every node *and* every invocation so native
// higher-order loops over pure builtins — which never re-enter
// evaluateExpression — can still be cancelled/timed out.
export function checkInterrupt(context: EvaluationContext): void {
  const { signal, deadline } = context.limits;
  if (signal?.aborted) {
    throw new Error("Execution aborted");
  }
  if (deadline !== Infinity && Date.now() > deadline) {
    throw new Error("Execution timed out");
  }
}

export function chargeFuel(context: EvaluationContext, amount: number): void {
  if (!context.limits.trackFuel) return;
  context.state.fuel += amount;
  if (context.state.fuel > context.limits.maxFuel) {
    throw new Error(`Maximum fuel limit of ${context.limits.maxFuel} exceeded`);
  }
}

export function guardValueSize(context: EvaluationContext, size: number): void {
  if (size > context.limits.maxValueSize) {
    throw new Error(`Maximum value size of ${context.limits.maxValueSize} exceeded`);
  }
}

// Charges fuel and enforces the size cap for values produced by host functions,
// proportional to the length of any produced array or string. This is the
// chokepoint that accounts for allocation by size-growing pure builtins. A
// metered pure function may additionally charge for input traversal when its
// output can be smaller than the work it performs.
export function accountForResult(context: EvaluationContext, result: JSONType): void {
  if (typeof result === "string" || Array.isArray(result)) {
    const size = typeof result === "string" ? codePointLength(result) : result.length;
    guardValueSize(context, size);
    chargeFuel(context, size);
  }
}
