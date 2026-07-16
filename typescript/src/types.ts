type JSONType = string | number | boolean | null | JSONType[] | { [key: string]: JSONType };

enum ExpressionType {
  FunctionCall,
  FunctionReference,
  VariableReference,
  FunctionBody,
  Conditional,
  Cond,
  Match,
  And,
  Or,
  Cast,
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

// A `$params` slot is a positional parameter name, a `"...rest"` collector, or
// an object pattern destructuring one positional object argument into named
// locals. See plans/destructured-params.md.
type FieldPattern = { $fields: string[] };
type Param = string | FieldPattern;

type VariableReference = {
  $var: string;
};

type FunctionBody = {
  [key: string]: JSONType;
  $return: JSONType;
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

type Cast = {
  $cast: JSONType;
};

type PropertyAccess = {
  $get: JSONType;
  $from: JSONType;
};

const BUILTIN_MARKER = Symbol("builtin");
const PURE_MARKER = Symbol("pure");
const ARITY_MARKER = Symbol("arity");

// Passed to builtins so they can account for work/size proportional to their
// inputs (native loops and allocations that don't otherwise flow through the
// per-node/per-call fuel chokepoints). See docs/execution-limits.md.
type Meter = {
  charge: (amount: number) => void;
  guardSize: (size: number) => void;
};

type RuntimeContext = {
  /** Merged builtin, environment, and module definitions for boundary contracts. */
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

type ResolvedLimits = {
  maxCallDepth: number;
  maxFuel: number;
  maxValueSize: number;
  trackFuel: boolean;
  signal?: AbortSignal;
  /** Absolute deadline (Date.now() ms) or Infinity when no timeout is set. */
  deadline: number;
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

type CallState = {
  depth: number;
  fuel: number;
};

type EvaluationContext = {
  functions: FunctionRegistry;
  getVar?: (name: string) => JSONType | undefined;
  // P4/Site 2: names of scoped local *function* declarations, accumulated down
  // the scope chain. `replaceVars` uses this to decide whether a free callee is
  // capturable: a callee that is not a local function name but resolves via
  // `getVar` to a function declaration (i.e. a shadowing parameter/local) is
  // inlined into an escaping closure, while local function names stay literal so
  // they keep dispatching through the registry (recursion is preserved).
  localFns?: ReadonlySet<string>;
  // Subset of `localFns` eligible for escaping-closure *attachment* (see
  // `attachFreeLocalFns`). Unlike `localFns`, this EXCLUDES the persistent
  // module/registry scope: those functions resolve by name for the whole
  // program, so an in-program reference never dangles, and inlining a
  // self-referential module function into an escaping value blows capture up
  // super-exponentially. Seeded empty at the root/module scope
  // (`attachFns === undefined`); each nested scope adds its own local functions.
  attachFns?: ReadonlySet<string>;
  /** Merged definition pool propagated through calls for runtime contracts. */
  runtimeDefs?: Record<string, JSONType>;
  limits: ResolvedLimits;
  state: CallState;
  perf?: PerfStats;
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
  FieldPattern,
  Param,
  EvaluationContext,
  ExecutionLimits,
  ExecutionUsage,
  PerfStats,
  ResolvedLimits,
  CallState,
  FunctionBody,
  VariableReference,
  Conditional,
  Cond,
  Match,
  Cast,
  PropertyAccess,
  EvaluatedFunctionCall,
};
export { BUILTIN_MARKER, PURE_MARKER, ARITY_MARKER, ExpressionType };
