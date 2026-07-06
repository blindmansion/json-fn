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
	ExprMatch
	ExprAnd
	ExprOr
	ExprComparison
	ExprNot
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
	ExprMatch:             "Match",
	ExprAnd:               "And",
	ExprOr:                "Or",
	ExprComparison:        "Comparison",
	ExprNot:               "Not",
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

// Meter lets a builtin account for work and allocation that its native loops
// perform off the per-node/per-call fuel chokepoints (e.g. iterating an input
// array or allocating a large result). See docs/execution-limits.md.
//
// Both methods return an error when a limit is exceeded; builtins must
// propagate it rather than continuing.
type Meter struct {
	ctx *evaluationContext
}

// Charge consumes the given amount of fuel from the shared budget. It returns
// an error if the budget is exceeded.
func (m *Meter) Charge(amount int) error {
	return chargeFuel(m.ctx, amount)
}

// GuardSize enforces the maximum produced value size. It returns an error if
// size exceeds the configured maxValueSize.
func (m *Meter) GuardSize(size int) error {
	return guardValueSize(m.ctx, size)
}

// PureFunc is a native Go function that operates only on its arguments and
// does not call back into the interpreter. The interpreter does not clone
// arguments or results for pure functions.
type PureFunc struct {
	Fn    func(args []any) (any, error)
	Arity int
}

// BuiltinFunc is a native Go function that receives the interpreter's call
// mechanism so it can invoke json-fn callbacks (e.g. map, filter, reduce). It
// also receives a Meter so it can account for input-size- and output-size-
// proportional work (see docs/execution-limits.md).
type BuiltinFunc struct {
	Fn    func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error)
	Arity int
}

// FunctionRegistry maps function names to implementations. Values are one of:
//   - PureFunc: a native Go function (no callback support)
//   - *BuiltinFunc: a native function that can call back into the interpreter
//   - map[string]any: a JSON function body (must contain "$return")
type FunctionRegistry map[string]any

// ExecutionUsage is filled in by the interpreter so hosts can read how much
// fuel a run consumed. Fuel only accrues when tracking is enabled (a positive
// MaxFuel, or a non-nil Usage supplied to force measurement).
type ExecutionUsage struct {
	Fuel int
}

// ExecutionLimits controls safety limits for evaluation.
type ExecutionLimits struct {
	MaxCallDepth int
	// MaxFuel is the total work budget. It is charged per AST node, per
	// function invocation, and per unit of size-proportional builtin work.
	// Zero means unlimited.
	MaxFuel int
	// MaxValueSize is the maximum length of any produced array or string.
	// Zero means unlimited.
	MaxValueSize int
	// Ctx carries cooperative cancellation and the optional wall-clock
	// backstop. Cancel a run with context.WithCancel; bound its wall-clock
	// time with context.WithTimeout / context.WithDeadline. Its Done channel
	// is checked at every node and every function invocation (so native
	// higher-order loops are covered): a cancelled context aborts with
	// "Execution aborted" and an exceeded deadline with "Execution timed out".
	// The deadline is non-deterministic and is not part of the conformance
	// spec (see docs/execution-limits.md §3.4).
	Ctx context.Context
	// Usage, if non-nil, has its Fuel field set to the fuel consumed by the run.
	Usage *ExecutionUsage
}

type resolvedLimits struct {
	maxCallDepth int
	maxFuel      int // valid only when trackFuel is true
	maxValueSize int
	trackFuel    bool
	ctx          context.Context
}

type callState struct {
	depth int
	fuel  int
}

type evaluationContext struct {
	functions FunctionRegistry
	getVar    func(name string) (any, bool, error)
	limits    resolvedLimits
	state     *callState
}
