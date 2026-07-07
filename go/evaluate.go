package jsonfn

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"strings"
)

const defaultMaxCallDepth = 256

var comparisonOperators = []string{"$eq", "$neq", "$gt", "$gte", "$lt", "$lte"}

// CallFunction is the main entry point for evaluating a json-fn program.
// fn must be a function name (string) or a JSON function body (map with "$return").
// Returns the evaluated result or an error.
func CallFunction(fn any, args []any, functions FunctionRegistry, limits *ExecutionLimits) (any, error) {
	resolved := resolvedLimits{
		maxCallDepth: defaultMaxCallDepth,
		maxFuel:      math.MaxInt,
		maxValueSize: math.MaxInt,
		ctx:          context.Background(),
	}
	var usage *ExecutionUsage
	if limits != nil {
		if limits.MaxCallDepth > 0 {
			resolved.maxCallDepth = limits.MaxCallDepth
		}
		if limits.MaxFuel > 0 {
			resolved.maxFuel = limits.MaxFuel
			resolved.trackFuel = true
		}
		if limits.MaxValueSize > 0 {
			resolved.maxValueSize = limits.MaxValueSize
		}
		if limits.Usage != nil {
			usage = limits.Usage
			resolved.trackFuel = true
		}
		if limits.Ctx != nil {
			resolved.ctx = limits.Ctx
		}
	}

	state := &callState{}
	if usage != nil {
		defer func() { usage.Fuel = state.fuel }()
	}
	ctx := &evaluationContext{
		functions: functions,
		limits:    resolved,
		state:     state,
	}
	return callFunctionInternal(fn, args, ctx)
}

// checkInterrupt is the cooperative cancellation + wall-clock backstop. Hosts
// supply cancellation and/or a deadline through the standard context.Context
// (e.g. context.WithTimeout / context.WithDeadline / context.WithCancel), so
// no extra limit field is needed. It never charges fuel, so anchor fuel counts
// are unaffected. Checked at every node *and* every invocation so native
// higher-order loops over pure builtins — which never re-enter
// evaluateExpression — can still be cancelled/timed out. The deadline is
// intentionally non-deterministic and therefore not part of the conformance
// spec (see docs/execution-limits.md §3.4).
func checkInterrupt(ctx *evaluationContext) error {
	if ctx.limits.ctx == nil {
		return nil
	}
	select {
	case <-ctx.limits.ctx.Done():
		if ctx.limits.ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("Execution timed out")
		}
		return fmt.Errorf("Execution aborted")
	default:
		return nil
	}
}

// chargeFuel decrements the shared fuel budget by amount, returning an error
// when the budget is exhausted. It is a no-op when fuel tracking is disabled.
func chargeFuel(ctx *evaluationContext, amount int) error {
	if !ctx.limits.trackFuel {
		return nil
	}
	ctx.state.fuel += amount
	if ctx.state.fuel > ctx.limits.maxFuel {
		return fmt.Errorf("Maximum fuel limit of %d exceeded", ctx.limits.maxFuel)
	}
	return nil
}

// guardValueSize enforces the maximum produced array/string length. Unlike
// fuel, size is always enforced (independent of trackFuel).
func guardValueSize(ctx *evaluationContext, size int) error {
	if size > ctx.limits.maxValueSize {
		return fmt.Errorf("Maximum value size of %d exceeded", ctx.limits.maxValueSize)
	}
	return nil
}

// accountForResult charges fuel and enforces the size cap for values produced
// by pure host functions, proportional to the length of any produced array or
// string. This keeps size-growing pure builtins (concat, flatten, split, join,
// ...) honest without each needing to self-meter.
func accountForResult(ctx *evaluationContext, result any) error {
	var size int
	switch v := result.(type) {
	case string:
		size = len(v)
	case []any:
		size = len(v)
	default:
		return nil
	}
	if err := guardValueSize(ctx, size); err != nil {
		return err
	}
	return chargeFuel(ctx, size)
}

func callFunctionInternal(fn any, args []any, ctx *evaluationContext) (any, error) {
	if err := checkInterrupt(ctx); err != nil {
		return nil, err
	}
	// Charge one fuel per invocation. This single charge closes the op-bomb:
	// every HOF callback dispatch and every pure-builtin call now costs fuel,
	// regardless of whether it re-enters evaluateExpression.
	if err := chargeFuel(ctx, 1); err != nil {
		return nil, err
	}

	ctx.state.depth++
	defer func() { ctx.state.depth-- }()

	if ctx.state.depth > ctx.limits.maxCallDepth {
		return nil, fmt.Errorf("Maximum call depth of %d exceeded", ctx.limits.maxCallDepth)
	}

	switch f := fn.(type) {
	case string:
		entry, ok := ctx.functions[f]
		if !ok {
			return nil, fmt.Errorf("Function %s not found", f)
		}
		switch impl := entry.(type) {
		case *BuiltinFunc:
			call := func(cfn any, cargs []any) (any, error) {
				return callFunctionInternal(cfn, cargs, ctx)
			}
			return impl.Fn(args, call, ctx.functions, &Meter{ctx: ctx})
		case *PureFunc:
			result, err := callPureFunction(impl, args, f)
			if err != nil {
				return nil, err
			}
			if err := accountForResult(ctx, result); err != nil {
				return nil, err
			}
			return result, nil
		case map[string]any:
			return callJSONFunction(impl, args, ctx)
		default:
			return nil, fmt.Errorf("Function %s has unsupported type %T", f, entry)
		}

	case map[string]any:
		return callJSONFunction(f, args, ctx)

	default:
		return nil, fmt.Errorf("cannot call non-function value of type %T", fn)
	}
}

func callPureFunction(fn *PureFunc, args []any, name string) (any, error) {
	result, err := fn.Fn(args)
	if err != nil {
		return nil, fmt.Errorf("Error calling external function %s: %w", name, err)
	}
	return result, nil
}

func callJSONFunction(fn map[string]any, args []any, ctx *evaluationContext) (any, error) {
	parentGetVar := ctx.getVar

	localFnKeys := []string{}
	scopedFunctions := ctx.functions
	copied := false
	for key, val := range fn {
		if key == "$return" || key == "$params" {
			continue
		}
		if key == "$comment" {
			if _, isStr := val.(string); isStr {
				continue
			}
		}
		if body, ok := val.(map[string]any); ok {
			if _, hasReturn := body["$return"]; hasReturn {
				if !copied {
					scopedFunctions = copyRegistry(ctx.functions)
					copied = true
				}
				scopedFunctions[key] = body
				localFnKeys = append(localFnKeys, key)
			}
		}
	}

	evaluatedVars := make(map[string]any)

	if params, ok := fn["$params"].([]any); ok {
		for i, p := range params {
			name, _ := p.(string)
			if name == "" {
				continue
			}
			if len(name) > 3 && name[:3] == "..." {
				restName := name[3:]
				if err := validateParamName(restName); err != nil {
					return nil, err
				}
				if i < len(args) {
					rest := make([]any, len(args)-i)
					copy(rest, args[i:])
					evaluatedVars[restName] = rest
				} else {
					evaluatedVars[restName] = []any{}
				}
				break
			}
			if err := validateParamName(name); err != nil {
				return nil, err
			}
			if i < len(args) {
				evaluatedVars[name] = args[i]
			} else {
				evaluatedVars[name] = nil
			}
		}
	}

	resolvingVars := []string{}

	var getVar func(name string) (any, bool, error)
	getVar = func(name string) (any, bool, error) {
		if val, ok := evaluatedVars[name]; ok {
			return val, true, nil
		}

		for i, r := range resolvingVars {
			if r == name {
				cycle := append(resolvingVars[i:], name)
				return nil, false, fmt.Errorf("Circular variable dependency detected: %s", strings.Join(cycle, " -> "))
			}
		}

		if expression, ok := fn[name]; ok {
			if name == "$comment" {
				if _, isStr := expression.(string); isStr {
					if parentGetVar != nil {
						return parentGetVar(name)
					}
					return nil, false, nil
				}
			}
			resolvingVars = append(resolvingVars, name)
			evaluated, err := evaluateExpression(expression, &evaluationContext{
				functions: scopedFunctions,
				getVar:    getVar,
				limits:    ctx.limits,
				state:     ctx.state,
			})
			resolvingVars = resolvingVars[:len(resolvingVars)-1]
			if err != nil {
				return nil, false, err
			}
			evaluatedVars[name] = evaluated
			return evaluated, true, nil
		}

		if parentGetVar != nil {
			return parentGetVar(name)
		}

		return nil, false, nil
	}

	if len(localFnKeys) > 0 {
		for _, key := range localFnKeys {
			replaced, err := replaceVars(fn[key], getVar)
			if err != nil {
				return nil, err
			}
			if body, ok := replaced.(map[string]any); ok {
				scopedFunctions[key] = body
			}
		}
	}

	return evaluateExpression(fn["$return"], &evaluationContext{
		functions: scopedFunctions,
		getVar:    getVar,
		limits:    ctx.limits,
		state:     ctx.state,
	})
}

func evaluateExpression(expression any, ctx *evaluationContext) (any, error) {
	if err := checkInterrupt(ctx); err != nil {
		return nil, err
	}

	if err := chargeFuel(ctx, 1); err != nil {
		return nil, err
	}

	exprType, err := getExpressionType(expression)
	if err != nil {
		return nil, err
	}

	switch exprType {
	case ExprFunctionCall:
		obj := expression.(map[string]any)
		fnArray := obj["$fn"].([]any)
		var evaluatedFn any
		if name, ok := fnArray[0].(string); ok {
			evaluatedFn = name
		} else {
			evaluatedFn, err = evaluateExpression(fnArray[0], ctx)
			if err != nil {
				return nil, err
			}
			if !isFnDeclaration(evaluatedFn) {
				return nil, exprError(expression,
					fmt.Sprintf("Evaluated function references must be strings or function bodies. Got %T.", evaluatedFn))
			}
		}
		args := make([]any, 0, len(fnArray)-1)
		for i := 1; i < len(fnArray); i++ {
			arg, err := evaluateExpression(fnArray[i], ctx)
			if err != nil {
				return nil, err
			}
			args = append(args, arg)
		}
		return callFunctionInternal(evaluatedFn, args, ctx)

	case ExprFunctionReference:
		obj := expression.(map[string]any)
		evaluatedFnRef, err := evaluateExpression(obj["$fn"], ctx)
		if err != nil {
			return nil, err
		}
		if !isFnDeclaration(evaluatedFnRef) {
			return nil, exprError(expression,
				fmt.Sprintf("Evaluated function references must be strings or function bodies. Got %T.", evaluatedFnRef))
		}
		return evaluatedFnRef, nil

	case ExprVariableReference:
		obj := expression.(map[string]any)
		varName := obj["$var"].(string)
		if ctx.getVar == nil {
			return nil, exprError(expression, "getVar is not defined.")
		}
		return resolveVar(varName, ctx.getVar, expression)

	case ExprFunctionBody:
		if ctx.getVar == nil {
			return expression, nil
		}
		return replaceVars(expression, ctx.getVar)

	case ExprConditional:
		obj := expression.(map[string]any)
		cond, err := evaluateExpression(obj["$if"], ctx)
		if err != nil {
			return nil, err
		}
		if isTruthy(cond) {
			return evaluateExpression(obj["$then"], ctx)
		}
		return evaluateExpression(obj["$else"], ctx)

	case ExprCond:
		obj := expression.(map[string]any)
		pairs := obj["$cond"].([]any)
		for _, pair := range pairs {
			branch := pair.([]any)
			cond, err := evaluateExpression(branch[0], ctx)
			if err != nil {
				return nil, err
			}
			if isTruthy(cond) {
				return evaluateExpression(branch[1], ctx)
			}
		}
		if elseExpr, ok := obj["$else"]; ok {
			return evaluateExpression(elseExpr, ctx)
		}
		return nil, exprError(expression, `No $cond branch matched (add $else or a [true, ...] catch-all).`)

	case ExprMatch:
		obj := expression.(map[string]any)
		matchedValue, err := evaluateExpression(obj["$match"], ctx)
		if err != nil {
			return nil, err
		}
		if !isScalarValue(matchedValue) {
			return nil, exprError(expression, "$match values must be null, boolean, number, or string.")
		}
		pairs := obj["$cases"].([]any)
		for _, pair := range pairs {
			branch := pair.([]any)
			candidate, err := evaluateExpression(branch[0], ctx)
			if err != nil {
				return nil, err
			}
			if !isScalarValue(candidate) {
				return nil, exprError(expression, "$match values must be null, boolean, number, or string.")
			}
			if strictEqual(candidate, matchedValue) {
				return evaluateExpression(branch[1], ctx)
			}
		}
		return evaluateExpression(obj["$else"], ctx)

	case ExprAnd:
		obj := expression.(map[string]any)
		exprs := obj["$and"].([]any)
		var result any = true
		for _, expr := range exprs {
			result, err = evaluateExpression(expr, ctx)
			if err != nil {
				return nil, err
			}
			if !isTruthy(result) {
				return result, nil
			}
		}
		return result, nil

	case ExprOr:
		obj := expression.(map[string]any)
		exprs := obj["$or"].([]any)
		var result any = false
		for _, expr := range exprs {
			result, err = evaluateExpression(expr, ctx)
			if err != nil {
				return nil, err
			}
			if isTruthy(result) {
				return result, nil
			}
		}
		return result, nil

	case ExprComparison:
		return evaluateComparisonExpression(expression.(map[string]any), ctx)

	case ExprNot:
		obj := expression.(map[string]any)
		result, err := evaluateExpression(obj["$not"], ctx)
		if err != nil {
			return nil, err
		}
		return !isTruthy(result), nil

	case ExprPropertyAccess:
		return evaluatePropertyAccess(expression.(map[string]any), ctx)

	case ExprRaw:
		obj := expression.(map[string]any)
		return obj["$raw"], nil

	case ExprArray:
		arr := expression.([]any)
		result := make([]any, len(arr))
		for i, item := range arr {
			val, err := evaluateExpression(item, ctx)
			if err != nil {
				return nil, err
			}
			result[i] = val
		}
		return result, nil

	case ExprObject:
		obj := expression.(map[string]any)
		stripComment := hasStringComment(obj)
		size := len(obj)
		if stripComment {
			size--
		}
		result := make(map[string]any, size)
		for key, value := range obj {
			if stripComment && key == "$comment" {
				continue
			}
			val, err := evaluateExpression(value, ctx)
			if err != nil {
				return nil, err
			}
			result[key] = val
		}
		return result, nil

	case ExprString, ExprNumber, ExprBoolean, ExprNull:
		return expression, nil

	default:
		return nil, exprError(expression, "Unrecognized expression type.")
	}
}

func evaluatePropertyAccess(expr map[string]any, ctx *evaluationContext) (any, error) {
	evaluatedKey, err := evaluateExpression(expr["$get"], ctx)
	if err != nil {
		return nil, err
	}

	var evaluatedTarget any
	if varName, ok := expr["$var"].(string); ok {
		if ctx.getVar == nil {
			return nil, exprError(expr, "getVar is not defined.")
		}
		evaluatedTarget, err = resolveVar(varName, ctx.getVar, expr)
		if err != nil {
			return nil, err
		}
	} else {
		evaluatedTarget, err = evaluateExpression(expr["$from"], ctx)
		if err != nil {
			return nil, err
		}
	}

	if evaluatedTarget == nil {
		return nil, fmt.Errorf("Invalid $get target: expected object, array, or string, got null")
	}

	switch target := evaluatedTarget.(type) {
	case string:
		if idx, ok := toFloat64(evaluatedKey); ok {
			i := int(idx)
			if i >= 0 && i < len(target) {
				return string(target[i]), nil
			}
			return nil, nil
		}
		b, _ := json.Marshal(evaluatedKey)
		return nil, fmt.Errorf("Invalid $get key for string: expected number, got %s", string(b))

	case map[string]any:
		return propertyLookup(target, evaluatedKey)

	case []any:
		return propertyLookup(target, evaluatedKey)

	default:
		b, _ := json.Marshal(evaluatedTarget)
		return nil, fmt.Errorf("Invalid $get target: expected object, array, or string, got %s", string(b))
	}
}

func propertyLookup(target any, key any) (any, error) {
	switch k := key.(type) {
	case string:
		if obj, ok := target.(map[string]any); ok {
			val, exists := obj[k]
			if !exists {
				return nil, nil
			}
			return val, nil
		}
		return nil, nil

	case float64:
		idx := int(k)
		if arr, ok := target.([]any); ok {
			if idx >= 0 && idx < len(arr) {
				return arr[idx], nil
			}
			return nil, nil
		}
		return nil, nil

	case []any:
		current := target
		for _, segment := range k {
			if current == nil {
				return nil, nil
			}
			switch s := segment.(type) {
			case string:
				if obj, ok := current.(map[string]any); ok {
					val, exists := obj[s]
					if !exists {
						return nil, nil
					}
					current = val
				} else {
					return nil, nil
				}
			case float64:
				if arr, ok := current.([]any); ok {
					idx := int(s)
					if idx >= 0 && idx < len(arr) {
						current = arr[idx]
					} else {
						return nil, nil
					}
				} else {
					return nil, nil
				}
			default:
				b, _ := json.Marshal(segment)
				return nil, fmt.Errorf("Invalid $get path segment: %s", string(b))
			}
		}
		return current, nil

	default:
		b, _ := json.Marshal(key)
		return nil, fmt.Errorf("Invalid $get key: expected string, number, or array of strings/numbers, got %s", string(b))
	}
}

func replaceVars(expression any, getVar func(string) (any, bool, error)) (any, error) {
	switch expr := expression.(type) {
	case []any:
		result := make([]any, len(expr))
		for i, item := range expr {
			replaced, err := replaceVars(item, getVar)
			if err != nil {
				return nil, err
			}
			result[i] = replaced
		}
		return result, nil

	case map[string]any:
		if varName, ok := expr["$var"].(string); ok {
			parsed, err := parsePath(varName)
			if err != nil {
				return nil, err
			}
			if _, hasGet := expr["$get"]; hasGet {
				varValue, found, err := getVar(parsed.variable)
				if err != nil {
					return nil, err
				}
				replacedKey, err := replaceVars(expr["$get"], getVar)
				if err != nil {
					return nil, err
				}
				if found {
					if len(parsed.path) > 0 {
						var pathKey any
						if len(parsed.path) == 1 {
							pathKey = parsed.path[0]
						} else {
							pathKey = parsed.path
						}
						return map[string]any{"$get": replacedKey, "$from": map[string]any{"$get": pathKey, "$from": varValue}}, nil
					}
					return map[string]any{"$get": replacedKey, "$from": varValue}, nil
				}
				return map[string]any{"$var": varName, "$get": replacedKey}, nil
			}
			varValue, found, err := getVar(parsed.variable)
			if err != nil {
				return nil, err
			}
			if !found {
				return expression, nil
			}
			if len(parsed.path) > 0 {
				var pathKey any
				if len(parsed.path) == 1 {
					pathKey = parsed.path[0]
				} else {
					pathKey = parsed.path
				}
				return map[string]any{"$get": pathKey, "$from": varValue}, nil
			}
			return varValue, nil
		}

		if _, hasReturn := expr["$return"]; hasReturn {
			localNames := make(map[string]bool)
			for k, v := range expr {
				if k == "$return" || k == "$params" {
					continue
				}
				if k == "$comment" {
					if _, isStr := v.(string); isStr {
						continue
					}
				}
				localNames[k] = true
			}
			if params, ok := expr["$params"].([]any); ok {
				for _, p := range params {
					if s, ok := p.(string); ok {
						if len(s) > 3 && s[:3] == "..." {
							localNames[s[3:]] = true
						} else {
							localNames[s] = true
						}
					}
				}
			}
			maskedGetVar := getVar
			if len(localNames) > 0 {
				maskedGetVar = func(name string) (any, bool, error) {
					if localNames[name] {
						return nil, false, nil
					}
					return getVar(name)
				}
			}
			newObj := make(map[string]any, len(expr))
			for key, value := range expr {
				replaced, err := replaceVars(value, maskedGetVar)
				if err != nil {
					return nil, err
				}
				newObj[key] = replaced
			}
			return newObj, nil
		}

		newObj := make(map[string]any, len(expr))
		for key, value := range expr {
			replaced, err := replaceVars(value, getVar)
			if err != nil {
				return nil, err
			}
			newObj[key] = replaced
		}
		return newObj, nil

	default:
		return expression, nil
	}
}

func getExpressionType(json any) (ExpressionType, error) {
	if json == nil {
		return ExprNull, nil
	}
	switch v := json.(type) {
	case []any:
		return ExprArray, nil
	case string:
		return ExprString, nil
	case float64:
		return ExprNumber, nil
	case bool:
		return ExprBoolean, nil
	case map[string]any:
		return getObjectExpressionType(v)
	default:
		return 0, exprError(json, "Unrecognized expression type.")
	}
}

func getComparisonOperator(obj map[string]any) (string, bool) {
	for _, op := range comparisonOperators {
		if _, ok := obj[op]; ok {
			return op, true
		}
	}
	return "", false
}

func strictEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch av := a.(type) {
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	case int:
		switch bv := b.(type) {
		case int:
			return av == bv
		case float64:
			return float64(av) == bv
		default:
			return false
		}
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	default:
		return false
	}
}

func isScalarValue(v any) bool {
	if v == nil {
		return true
	}
	switch v.(type) {
	case bool, float64, int, string:
		return true
	default:
		return false
	}
}

func evaluateComparisonExpression(expr map[string]any, ctx *evaluationContext) (any, error) {
	op, _ := getComparisonOperator(expr)
	args := expr[op].([]any)
	left, err := evaluateExpression(args[0], ctx)
	if err != nil {
		return nil, err
	}
	right, err := evaluateExpression(args[1], ctx)
	if err != nil {
		return nil, err
	}

	switch op {
	case "$eq":
		return strictEqual(left, right), nil
	case "$neq":
		return !strictEqual(left, right), nil
	case "$lt", "$lte", "$gt", "$gte":
		a, b, err := twoFloats([]any{left, right}, op[1:])
		if err != nil {
			return nil, err
		}
		switch op {
		case "$lt":
			return a < b, nil
		case "$lte":
			return a <= b, nil
		case "$gt":
			return a > b, nil
		case "$gte":
			return a >= b, nil
		}
	}
	return nil, fmt.Errorf("unknown comparison operator: %s", op)
}

func getObjectExpressionType(obj map[string]any) (ExpressionType, error) {
	if _, hasVar := obj["$var"]; hasVar {
		varVal, ok := obj["$var"].(string)
		if !ok {
			return 0, exprError(obj, "Variable references must have a string $var property.")
		}
		_ = varVal
		keyCount := expressionKeyCount(obj)
		if _, hasGet := obj["$get"]; hasGet {
			if keyCount > 2 {
				return 0, exprError(obj, "$var/$get property access cannot have other properties.")
			}
			return ExprPropertyAccess, nil
		}
		if keyCount > 1 {
			return 0, exprError(obj, "Variable references cannot have other properties.")
		}
		return ExprVariableReference, nil
	}

	_, hasGet := obj["$get"]
	_, hasFrom := obj["$from"]
	if hasGet || hasFrom {
		if !(hasGet && hasFrom) {
			return 0, exprError(obj, "Property access expressions must have both $get and $from.")
		}
		if expressionKeyCount(obj) > 2 {
			return 0, exprError(obj, "Property access expressions cannot have more than two properties.")
		}
		return ExprPropertyAccess, nil
	}

	if _, hasReturn := obj["$return"]; hasReturn {
		if _, hasFn := obj["$fn"]; hasFn {
			return 0, exprError(obj, "Function bodies cannot have other keyword properties.")
		}
		if params, hasParams := obj["$params"]; hasParams {
			paramsArr, ok := params.([]any)
			if !ok {
				return 0, exprError(obj, "$params must be an array of strings.")
			}
			for _, p := range paramsArr {
				s, ok := p.(string)
				if !ok {
					return 0, exprError(obj, "$params must be an array of strings.")
				}
				name := s
				if len(s) > 3 && s[:3] == "..." {
					name = s[3:]
				}
				if err := validateParamName(name); err != nil {
					return 0, err
				}
			}
		}
		return ExprFunctionBody, nil
	}

	if fnVal, hasFn := obj["$fn"]; hasFn {
		if fnArr, ok := fnVal.([]any); ok {
			_ = fnArr
			if expressionKeyCount(obj) > 1 {
				return 0, exprError(obj, "Function calls cannot have other properties.")
			}
			return ExprFunctionCall, nil
		}
		switch fnVal.(type) {
		case string, map[string]any:
			if expressionKeyCount(obj) > 1 {
				return 0, exprError(obj, "Function references cannot have other properties.")
			}
			return ExprFunctionReference, nil
		}
	}

	if condVal, hasCond := obj["$cond"]; hasCond {
		maxKeys := 1
		if _, hasElse := obj["$else"]; hasElse {
			maxKeys = 2
		}
		if expressionKeyCount(obj) > maxKeys {
			return 0, exprError(obj, "$cond expressions can only have $cond and optional $else properties.")
		}
		pairs, ok := condVal.([]any)
		if !ok {
			return 0, exprError(obj, "$cond must be an array of [condition, result] pairs.")
		}
		for _, pair := range pairs {
			pairArr, ok := pair.([]any)
			if !ok || len(pairArr) != 2 {
				return 0, exprError(obj, "Each $cond branch must be a [condition, result] pair.")
			}
		}
		return ExprCond, nil
	}

	_, hasMatch := obj["$match"]
	casesVal, hasCases := obj["$cases"]
	_, hasMatchElse := obj["$else"]
	if hasMatch || hasCases {
		if !(hasMatch && hasCases && hasMatchElse) {
			return 0, exprError(obj, "$match expressions must have $match, $cases, and $else properties.")
		}
		if expressionKeyCount(obj) > 3 {
			return 0, exprError(obj, "$match expressions can only have $match, $cases, and $else properties.")
		}
		pairs, ok := casesVal.([]any)
		if !ok {
			return 0, exprError(obj, "$cases must be an array of [value, result] pairs.")
		}
		for _, pair := range pairs {
			pairArr, ok := pair.([]any)
			if !ok || len(pairArr) != 2 {
				return 0, exprError(obj, "Each $match case must be a [value, result] pair.")
			}
		}
		return ExprMatch, nil
	}

	_, hasIf := obj["$if"]
	_, hasThen := obj["$then"]
	_, hasElse := obj["$else"]
	if hasIf || hasThen || hasElse {
		if !(hasIf && hasThen && hasElse) {
			return 0, exprError(obj, "Conditional expressions must have all three properties: $if, $then, $else.")
		}
		if expressionKeyCount(obj) > 3 {
			return 0, exprError(obj, "Conditional expressions cannot have more than three properties.")
		}
		return ExprConditional, nil
	}

	if andVal, hasAnd := obj["$and"]; hasAnd {
		if expressionKeyCount(obj) > 1 {
			return 0, exprError(obj, "$and expressions cannot have other properties.")
		}
		if _, ok := andVal.([]any); !ok {
			return 0, exprError(obj, "$and must be an array of expressions.")
		}
		return ExprAnd, nil
	}

	if orVal, hasOr := obj["$or"]; hasOr {
		if expressionKeyCount(obj) > 1 {
			return 0, exprError(obj, "$or expressions cannot have other properties.")
		}
		if _, ok := orVal.([]any); !ok {
			return 0, exprError(obj, "$or must be an array of expressions.")
		}
		return ExprOr, nil
	}

	if comparisonOperator, ok := getComparisonOperator(obj); ok {
		if expressionKeyCount(obj) > 1 {
			return 0, exprError(obj, fmt.Sprintf("%s expressions cannot have other properties.", comparisonOperator))
		}
		args, ok := obj[comparisonOperator].([]any)
		if !ok || len(args) != 2 {
			return 0, exprError(obj, fmt.Sprintf("%s must be an array of two expressions.", comparisonOperator))
		}
		return ExprComparison, nil
	}

	if _, hasNot := obj["$not"]; hasNot {
		if expressionKeyCount(obj) > 1 {
			return 0, exprError(obj, "$not expressions cannot have other properties.")
		}
		return ExprNot, nil
	}

	if _, hasRaw := obj["$raw"]; hasRaw {
		if expressionKeyCount(obj) > 1 {
			return 0, exprError(obj, "$raw expressions cannot have other properties.")
		}
		return ExprRaw, nil
	}

	return ExprObject, nil
}

func copyRegistry(src FunctionRegistry) FunctionRegistry {
	dst := make(FunctionRegistry, len(src))
	maps.Copy(dst, src)
	return dst
}
