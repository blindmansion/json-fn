package jsonfn

import "context"

// JSONType represents any valid JSON value. After encoding/json unmarshalling:
//   - nil        → JSON null
//   - bool       → JSON boolean
//   - float64    → JSON number
//   - string     → JSON string
//   - []any      → JSON array
//   - map[string]any → JSON object
type JSONType = any

// ExpressionType classifies a JSON value as a json-fn expression.
type ExpressionType int

const (
	ExprFunctionCall ExpressionType = iota
	ExprFunctionReference
	ExprVariableReference
	ExprFunctionBody
	ExprConditional
	ExprCond
	ExprAnd
	ExprOr
	ExprPropertyAccess
	ExprLiteral
	ExprObject
	ExprArray
	ExprString
	ExprNumber
	ExprBoolean
	ExprNull
)

var exprTypeNames = map[ExpressionType]string{
	ExprFunctionCall:      "FunctionCall",
	ExprFunctionReference: "FunctionReference",
	ExprVariableReference: "VariableReference",
	ExprFunctionBody:      "FunctionBody",
	ExprConditional:       "Conditional",
	ExprCond:              "Cond",
	ExprAnd:               "And",
	ExprOr:                "Or",
	ExprPropertyAccess:    "PropertyAccess",
	ExprLiteral:           "Literal",
	ExprObject:            "Object",
	ExprArray:             "Array",
	ExprString:            "String",
	ExprNumber:            "Number",
	ExprBoolean:           "Boolean",
	ExprNull:              "Null",
}

func (e ExpressionType) String() string {
	if name, ok := exprTypeNames[e]; ok {
		return name
	}
	return "Unknown"
}

// CallFunc is the signature for calling a json-fn function from within a
// builtin. It mirrors the interpreter's internal call mechanism.
type CallFunc func(fn any, args []any) (any, error)

// PureFunc is a native Go function that operates only on its arguments and
// produces no side effects. The interpreter does not clone arguments or
// results for pure functions.
type PureFunc struct {
	Fn    func(args []any) (any, error)
	Arity int
}

// BuiltinFunc is a native Go function that receives the interpreter's call
// mechanism so it can invoke json-fn callbacks (e.g. map, filter, reduce).
type BuiltinFunc struct {
	Fn    func(args []any, call CallFunc, fns FunctionRegistry) (any, error)
	Arity int
}

// FunctionRegistry maps function names to implementations. Values are one of:
//   - PureFunc: a native Go function (no callback support)
//   - *BuiltinFunc: a native function that can call back into the interpreter
//   - map[string]any: a JSON function body (must contain "$return")
type FunctionRegistry map[string]any

// ExecutionLimits controls safety limits for evaluation.
type ExecutionLimits struct {
	MaxCallDepth  int
	MaxOperations int
	Ctx           context.Context
}

type resolvedLimits struct {
	maxCallDepth  int
	maxOperations int // 0 means unlimited
	ctx           context.Context
}

type callState struct {
	depth      int
	operations int
}

type evaluationContext struct {
	functions FunctionRegistry
	getVar    func(name string) (any, bool, error)
	limits    resolvedLimits
	state     *callState
}
