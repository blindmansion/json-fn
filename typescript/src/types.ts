type JSONType = string | number | boolean | null | JSONType[] | { [key: string]: JSONType };

enum ExpressionType {
  FunctionCall,
  FunctionReference,
  VariableReference,
  FunctionBody,
  Let,
  Conditional,
  Cond,
  Match,
  And,
  Or,
  NonNullAssertion,
  CheckedAscription,
  PropertyAccess,
  Raw,
  Object,
  Array,
  String,
  Integer,
  Number,
  Boolean,
  Null,
}

type FunctionCall = {
  $call: JSONType;
  $args: JSONType[];
};

type FunctionReference = {
  $fn: JSONType;
};

type FunctionDeclaration = string | FunctionBody;

// A `$params` slot is a positional parameter name, an optional/defaulted
// positional binding, a `"...rest"` collector, or an object pattern
// destructuring one positional object argument into named locals. See
// plans/active/strict-parameter-semantics.md and plans/destructured-params.md.
type DefaultedParam = { $param: string; $default: JSONType };
type OptionalParam = { $param: string; $optional: true };
type DefaultedField = { $field: string; $default: JSONType };
type OptionalField = { $field: string; $optional: true };
type FieldBinding = string | DefaultedField | OptionalField;
type FieldPattern = { $fields: FieldBinding[] };
type Param = string | DefaultedParam | OptionalParam | FieldPattern;

type VariableReference = {
  $var: string;
};

type LetExpression = {
  $let: Record<string, JSONType>;
  $in: JSONType;
};

type FunctionCaptures = Record<string, FunctionBody>;

type FunctionBody = {
  [key: string]: JSONType;
  $return: JSONType;
} & {
  $captures?: FunctionCaptures;
};

type Conditional = {
  $if: JSONType;
  $then: JSONType;
  $else: JSONType;
};

type Cond = {
  $cond: [JSONType, JSONType][];
  $else?: JSONType;
};

type Match = {
  $match: JSONType;
  $cases: [JSONType, JSONType][];
  $else: JSONType;
};

type NonNullAssertion = {
  $nonnull: JSONType;
};

type CheckedAscription = {
  $as: JSONType;
  $type: JSONType;
};

type PropertyAccess = {
  $get: JSONType;
  $from: JSONType;
};

const BUILTIN_MARKER = Symbol("builtin");
const PURE_MARKER = Symbol("pure");
const METERED_PURE_MARKER = Symbol("meteredPure");
const ARITY_MARKER = Symbol("arity");

// Passed to builtins so they can account for work/size proportional to their
// inputs (native loops and allocations that don't otherwise flow through the
// per-node/per-call fuel chokepoints). See docs/execution-limits.md.
type Meter = {
  charge: (amount: number) => void;
  guardSize: (size: number) => void;
};

type RuntimeContext = {
  /** Merged builtin, contract, and module definitions for boundary contracts. */
  defs: Record<string, JSONType>;
};

type BuiltinFunction = ((
  args: JSONType[],
  call: (fn: JSONType, args: JSONType[]) => JSONType,
  functions: FunctionRegistry,
  meter: Meter,
  runtime: RuntimeContext,
) => JSONType) & { [BUILTIN_MARKER]: true };

type FunctionRegistry = Record<string, Function | FunctionBody>;

type EvaluatedFunctionCall = {
  fnDeclaration: FunctionDeclaration;
  args: JSONType[];
};

// Filled in by the interpreter so hosts can read how much fuel a run consumed.
// Fuel only accrues when tracking is enabled (a finite `maxFuel`, or when a
// `usage` object is supplied to force measurement).
type ExecutionUsage = {
  fuel: number;
};

type ExecutionLimits = {
  maxCallDepth?: number;
  /** Total work budget. Charged per node, per call, and per unit of builtin work. */
  maxFuel?: number;
  /** Max length of any produced array or string. */
  maxValueSize?: number;
  signal?: AbortSignal;
  /**
   * Host-only wall-clock backstop, in milliseconds. When set, evaluation
   * aborts with "Execution timed out" once the deadline (start time +
   * `timeoutMs`) passes. Checked at the same chokepoints as `signal` (every
   * node and every function invocation, so native higher-order loops are
   * covered). Deliberately non-deterministic and therefore NOT part of the
   * conformance spec — it is an implementation-level safety net only.
   */
  timeoutMs?: number;
  perf?: PerfStats;
  /** If provided, its `fuel` field is set to the fuel consumed by the run. */
  usage?: ExecutionUsage;
};

type PerfStats = {
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

export type {
  JSONType,
  FunctionCall,
  FunctionReference,
  BuiltinFunction,
  Meter,
  RuntimeContext,
  FunctionRegistry,
  FunctionDeclaration,
  DefaultedParam,
  DefaultedField,
  FieldBinding,
  FieldPattern,
  Param,
  ExecutionLimits,
  ExecutionUsage,
  PerfStats,
  FunctionBody,
  FunctionCaptures,
  LetExpression,
  VariableReference,
  Conditional,
  Cond,
  Match,
  NonNullAssertion,
  CheckedAscription,
  PropertyAccess,
  EvaluatedFunctionCall,
};
export { BUILTIN_MARKER, PURE_MARKER, METERED_PURE_MARKER, ARITY_MARKER, ExpressionType };
