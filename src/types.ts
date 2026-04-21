type JSONType = string | number | boolean | null | JSONType[] | { [key: string]: JSONType };

enum ExpressionType {
  FunctionCall,
  FunctionReference,
  VariableReference,
  FunctionBody,
  Conditional,
  Cond,
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
  $fn: JSONType;
  $args: JSONType;
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
};

type ResolvedLimits = {
  maxCallDepth: number;
  maxOperations: number;
  signal?: AbortSignal;
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
  ResolvedLimits,
  CallState,
  FunctionBody,
  VariableReference,
  Conditional,
  Cond,
  PropertyAccess,
  VarPropertyAccess,
  EvaluatedFunctionCall,
};
export { BUILTIN_MARKER, PURE_MARKER, ARITY_MARKER, ExpressionType };
