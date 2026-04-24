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
  Comparison,
  Not,
  PropertyAccess,
  Literal,
  Object,
  Array,
  String,
  Integer,
  Number,
  Boolean,
  Null,
}

type FunctionCall = {
  $fn: JSONType[];
};

type FunctionReference = {
  $fn: JSONType;
};

type FunctionDeclaration = string | FunctionBody;

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

type ComparisonOperator = "$eq" | "$neq" | "$lt" | "$lte" | "$gt" | "$gte";

type ComparisonExpression = {
  [K in ComparisonOperator]?: JSONType[];
};

type NotExpression = {
  $not: JSONType;
};

type PropertyAccess = {
  $get: JSONType;
  $from: JSONType;
};

type VarPropertyAccess = {
  $var: string;
  $get: JSONType;
};

const BUILTIN_MARKER = Symbol("builtin");
const PURE_MARKER = Symbol("pure");
const ARITY_MARKER = Symbol("arity");

type BuiltinFunction = ((
  args: JSONType[],
  call: (fn: JSONType, args: JSONType[]) => JSONType,
  functions: FunctionRegistry,
) => JSONType) & { [BUILTIN_MARKER]: true };

type FunctionRegistry = Record<string, Function | FunctionBody>;

type EvaluatedFunctionCall = {
  fnDeclaration: FunctionDeclaration;
  args: JSONType[];
};

type ExecutionLimits = {
  maxCallDepth?: number;
  maxOperations?: number;
  signal?: AbortSignal;
  perf?: PerfStats;
};

type ResolvedLimits = {
  maxCallDepth: number;
  maxOperations: number;
  signal?: AbortSignal;
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
  operations: number;
};

type EvaluationContext = {
  functions: FunctionRegistry;
  getVar?: (name: string) => JSONType | undefined;
  limits: ResolvedLimits;
  state: CallState;
  perf?: PerfStats;
};

export type {
  JSONType,
  FunctionCall,
  FunctionReference,
  BuiltinFunction,
  FunctionRegistry,
  FunctionDeclaration,
  EvaluationContext,
  ExecutionLimits,
  PerfStats,
  ResolvedLimits,
  CallState,
  FunctionBody,
  VariableReference,
  Conditional,
  Cond,
  Match,
  ComparisonOperator,
  ComparisonExpression,
  NotExpression,
  PropertyAccess,
  VarPropertyAccess,
  EvaluatedFunctionCall,
};
export { BUILTIN_MARKER, PURE_MARKER, ARITY_MARKER, ExpressionType };
