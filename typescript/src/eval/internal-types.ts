import type { FunctionRegistry, JSONType, PerfStats } from "../types";

export type ResolvedLimits = {
  maxCallDepth: number;
  maxFuel: number;
  maxValueSize: number;
  trackFuel: boolean;
  signal?: AbortSignal;
  /** Absolute deadline (Date.now() ms) or Infinity when no timeout is set. */
  deadline: number;
};

export type CallState = {
  depth: number;
  fuel: number;
};

export type EvaluationContext = {
  functions: FunctionRegistry;
  getVar?: (name: string) => JSONType | undefined;
  // Names in the current definition-owned function registry environment.
  // Closure capture uses these to preserve registry-based recursion.
  localFns: ReadonlySet<string>;
  // Definition-owned subset eligible for attachment to escaping closures.
  // Persistent module functions are excluded because they remain addressable.
  attachFns: ReadonlySet<string>;
  /** Merged definition pool propagated through calls for runtime contracts. */
  runtimeDefs?: Record<string, JSONType>;
  /** Allows a trusted runtime-contract wrapper to invoke its private adapter alias. */
  allowAdapterAlias?: boolean;
  limits: ResolvedLimits;
  state: CallState;
  perf?: PerfStats;
};
