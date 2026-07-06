package jsonfn

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func sortedObjectKeys(obj map[string]any) []string {
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// LogFn is the host-provided sink used by the log stdlib function.
type LogFn func(value any, label ...any)

// StdlibOptions controls host-provided stdlib capabilities.
type StdlibOptions struct {
	// Logger receives log calls. When nil, log is a no-op tap.
	Logger LogFn
}

// CreateStdlib returns a FunctionRegistry populated with the standard library
// functions: arithmetic, comparison, logic, type checks, coercion, arrays,
// strings, objects, higher-order functions, and regex operations.
func CreateStdlib(options ...StdlibOptions) FunctionRegistry {
	var logger LogFn
	if len(options) > 0 {
		logger = options[0].Logger
	}

	return FunctionRegistry{
		// Arithmetic
		"add": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "add")
			if err != nil {
				return nil, err
			}
			return a + b, nil
		}},
		"sub": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "sub")
			if err != nil {
				return nil, err
			}
			return a - b, nil
		}},
		"mul": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "mul")
			if err != nil {
				return nil, err
			}
			return a * b, nil
		}},
		"div": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "div")
			if err != nil {
				return nil, err
			}
			if b == 0 {
				return nil, fmt.Errorf("div: division by zero")
			}
			return a / b, nil
		}},
		"mod": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "mod")
			if err != nil {
				return nil, err
			}
			return math.Mod(a, b), nil
		}},
		"abs": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			a, err := oneFloat(args, "abs")
			if err != nil {
				return nil, err
			}
			return math.Abs(a), nil
		}},
		"neg": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			a, err := oneFloat(args, "neg")
			if err != nil {
				return nil, err
			}
			return -a, nil
		}},
		"floor": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			a, err := oneFloat(args, "floor")
			if err != nil {
				return nil, err
			}
			return math.Floor(a), nil
		}},
		"ceil": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			a, err := oneFloat(args, "ceil")
			if err != nil {
				return nil, err
			}
			return math.Ceil(a), nil
		}},
		"round": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			a, err := oneFloat(args, "round")
			if err != nil {
				return nil, err
			}
			return math.Round(a), nil
		}},
		"max": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("max: argument must be an array")
			}
			if len(arr) == 0 {
				return math.Inf(-1), nil
			}
			best := math.Inf(-1)
			for _, v := range arr {
				n, ok := toFloat64(v)
				if !ok {
					return nil, fmt.Errorf("max: array element is not a number")
				}
				if n > best {
					best = n
				}
			}
			return best, nil
		}},
		"min": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("min: argument must be an array")
			}
			if len(arr) == 0 {
				return math.Inf(1), nil
			}
			best := math.Inf(1)
			for _, v := range arr {
				n, ok := toFloat64(v)
				if !ok {
					return nil, fmt.Errorf("min: array element is not a number")
				}
				if n < best {
					best = n
				}
			}
			return best, nil
		}},

		// Comparison
		"eq":      &PureFunc{Arity: 2, Fn: func(args []any) (any, error) { return strictEqual(args[0], args[1]), nil }},
		"neq":     &PureFunc{Arity: 2, Fn: func(args []any) (any, error) { return !strictEqual(args[0], args[1]), nil }},
		"jsonEq":  &PureFunc{Arity: 2, Fn: func(args []any) (any, error) { return jsonEqual(args[0], args[1]), nil }},
		"jsonNeq": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) { return !jsonEqual(args[0], args[1]), nil }},
		"gt": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "gt")
			if err != nil {
				return nil, err
			}
			return a > b, nil
		}},
		"gte": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "gte")
			if err != nil {
				return nil, err
			}
			return a >= b, nil
		}},
		"lt": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "lt")
			if err != nil {
				return nil, err
			}
			return a < b, nil
		}},
		"lte": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, b, err := twoFloats(args, "lte")
			if err != nil {
				return nil, err
			}
			return a <= b, nil
		}},

		// Logic
		"not": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			b, ok := args[0].(bool)
			if !ok {
				return nil, fmt.Errorf("not: argument must be a boolean")
			}
			return !b, nil
		}},
		"and": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, ok1 := args[0].(bool)
			b, ok2 := args[1].(bool)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("and: arguments must be booleans")
			}
			return a && b, nil
		}},
		"or": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, ok1 := args[0].(bool)
			b, ok2 := args[1].(bool)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("or: arguments must be booleans")
			}
			return a || b, nil
		}},

		// Type checking
		"isNull":   &PureFunc{Arity: 1, Fn: func(args []any) (any, error) { return args[0] == nil, nil }},
		"isBool":   &PureFunc{Arity: 1, Fn: func(args []any) (any, error) { _, ok := args[0].(bool); return ok, nil }},
		"isNumber": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) { _, ok := args[0].(float64); return ok, nil }},
		"isString": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) { _, ok := args[0].(string); return ok, nil }},
		"isArray":  &PureFunc{Arity: 1, Fn: func(args []any) (any, error) { _, ok := args[0].([]any); return ok, nil }},

		// Type coercion
		"str": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			if s, ok := args[0].(string); ok {
				return s, nil
			}
			b, err := json.Marshal(args[0])
			if err != nil {
				return nil, err
			}
			return string(b), nil
		}},
		"num": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			switch v := args[0].(type) {
			case float64:
				return v, nil
			case bool:
				if v {
					return float64(1), nil
				}
				return float64(0), nil
			case nil:
				return float64(0), nil
			case string:
				n, err := strconv.ParseFloat(v, 64)
				if err != nil {
					return nil, fmt.Errorf("num: cannot parse %q as number", v)
				}
				return n, nil
			default:
				return nil, fmt.Errorf("num: cannot convert %T to number", v)
			}
		}},

		// Arrays
		"length": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			switch v := args[0].(type) {
			case []any:
				return float64(len(v)), nil
			case string:
				return float64(len(v)), nil
			default:
				return nil, fmt.Errorf("length: argument must be an array or string")
			}
		}},
		"head": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("head: argument must be an array")
			}
			if len(arr) == 0 {
				return nil, nil
			}
			return arr[0], nil
		}},
		"last": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("last: argument must be an array")
			}
			if len(arr) == 0 {
				return nil, nil
			}
			return arr[len(arr)-1], nil
		}},
		"tail": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("tail: argument must be an array")
			}
			if len(arr) == 0 {
				return []any{}, nil
			}
			result := make([]any, len(arr)-1)
			copy(result, arr[1:])
			return result, nil
		}},
		"concat": &PureFunc{Arity: -1, Fn: func(args []any) (any, error) {
			var result []any
			for _, a := range args {
				arr, ok := a.([]any)
				if !ok {
					return nil, fmt.Errorf("concat: all arguments must be arrays")
				}
				result = append(result, arr...)
			}
			return result, nil
		}},
		"range": &BuiltinFunc{
			Arity: 1,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				n, ok := toFloat64(args[0])
				if !ok {
					return nil, fmt.Errorf("range: argument must be a number")
				}
				length := int(n)
				if length < 0 {
					length = 0
				}
				// Guard and charge before allocating so an oversized range is
				// rejected immediately rather than after building the array.
				if err := meter.GuardSize(length); err != nil {
					return nil, err
				}
				if err := meter.Charge(length); err != nil {
					return nil, err
				}
				result := make([]any, length)
				for i := 0; i < length; i++ {
					result[i] = float64(i)
				}
				return result, nil
			},
		},
		"slice": &PureFunc{Arity: -1, Fn: func(args []any) (any, error) {
			start, ok := toFloat64(args[1])
			if !ok {
				return nil, fmt.Errorf("slice: start must be a number")
			}
			s := int(start)
			switch v := args[0].(type) {
			case []any:
				if s < 0 {
					s = len(v) + s
				}
				if s < 0 {
					s = 0
				}
				if len(args) > 2 && args[2] != nil {
					end, ok := toFloat64(args[2])
					if !ok {
						return nil, fmt.Errorf("slice: end must be a number")
					}
					e := int(end)
					if e < 0 {
						e = len(v) + e
					}
					if e > len(v) {
						e = len(v)
					}
					if s > e {
						return []any{}, nil
					}
					result := make([]any, e-s)
					copy(result, v[s:e])
					return result, nil
				}
				if s >= len(v) {
					return []any{}, nil
				}
				result := make([]any, len(v)-s)
				copy(result, v[s:])
				return result, nil
			case string:
				if s < 0 {
					s = len(v) + s
				}
				if s < 0 {
					s = 0
				}
				if len(args) > 2 && args[2] != nil {
					end, ok := toFloat64(args[2])
					if !ok {
						return nil, fmt.Errorf("slice: end must be a number")
					}
					e := int(end)
					if e < 0 {
						e = len(v) + e
					}
					if e > len(v) {
						e = len(v)
					}
					if s > e {
						return "", nil
					}
					return v[s:e], nil
				}
				if s >= len(v) {
					return "", nil
				}
				return v[s:], nil
			default:
				return nil, fmt.Errorf("slice: first argument must be an array or string")
			}
		}},
		"reverse": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("reverse: argument must be an array")
			}
			result := make([]any, len(arr))
			for i, v := range arr {
				result[len(arr)-1-i] = v
			}
			return result, nil
		}},
		"includes": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			switch v := args[0].(type) {
			case []any:
				for _, item := range v {
					if strictEqual(item, args[1]) {
						return true, nil
					}
				}
				return false, nil
			case string:
				sub, ok := args[1].(string)
				if !ok {
					return false, nil
				}
				return strings.Contains(v, sub), nil
			default:
				return nil, fmt.Errorf("includes: first argument must be an array or string")
			}
		}},
		"indexOf": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			switch v := args[0].(type) {
			case []any:
				for i, item := range v {
					if strictEqual(item, args[1]) {
						return float64(i), nil
					}
				}
				return float64(-1), nil
			case string:
				sub, ok := args[1].(string)
				if !ok {
					return float64(-1), nil
				}
				return float64(strings.Index(v, sub)), nil
			default:
				return nil, fmt.Errorf("indexOf: first argument must be an array or string")
			}
		}},
		"flatten": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("flatten: argument must be an array")
			}
			var result []any
			for _, item := range arr {
				if inner, ok := item.([]any); ok {
					result = append(result, inner...)
				} else {
					result = append(result, item)
				}
			}
			return result, nil
		}},
		"setAt": &PureFunc{Arity: 3, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("setAt: first argument must be an array")
			}
			idxF, ok := toFloat64(args[1])
			if !ok {
				return nil, fmt.Errorf("setAt: second argument must be a number")
			}
			idx := int(idxF)
			if idx < 0 || idx >= len(arr) {
				return nil, fmt.Errorf("setAt: index %d out of bounds for array of length %d", idx, len(arr))
			}
			result := make([]any, len(arr))
			copy(result, arr)
			result[idx] = args[2]
			return result, nil
		}},

		// Strings
		"upper": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			s, ok := args[0].(string)
			if !ok {
				return nil, fmt.Errorf("upper: argument must be a string")
			}
			return strings.ToUpper(s), nil
		}},
		"lower": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			s, ok := args[0].(string)
			if !ok {
				return nil, fmt.Errorf("lower: argument must be a string")
			}
			return strings.ToLower(s), nil
		}},
		"trim": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			s, ok := args[0].(string)
			if !ok {
				return nil, fmt.Errorf("trim: argument must be a string")
			}
			return strings.TrimSpace(s), nil
		}},
		"strcat": &PureFunc{Arity: -1, Fn: func(args []any) (any, error) {
			var b strings.Builder
			for _, arg := range args {
				s, ok := arg.(string)
				if !ok {
					return nil, fmt.Errorf("strcat: arguments must be strings")
				}
				b.WriteString(s)
			}
			return b.String(), nil
		}},
		"split": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			s, ok1 := args[0].(string)
			sep, ok2 := args[1].(string)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("split: arguments must be strings")
			}
			parts := strings.Split(s, sep)
			result := make([]any, len(parts))
			for i, p := range parts {
				result[i] = p
			}
			return result, nil
		}},
		"join": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			arr, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("join: first argument must be an array")
			}
			sep, ok := args[1].(string)
			if !ok {
				return nil, fmt.Errorf("join: second argument must be a string")
			}
			strs := make([]string, len(arr))
			for i, v := range arr {
				switch s := v.(type) {
				case string:
					strs[i] = s
				default:
					b, _ := json.Marshal(v)
					strs[i] = string(b)
				}
			}
			return strings.Join(strs, sep), nil
		}},

		// Object utilities
		"keys": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("keys: argument must be an object")
			}
			objectKeys := sortedObjectKeys(obj)
			keys := make([]any, 0, len(objectKeys))
			for _, k := range objectKeys {
				keys = append(keys, k)
			}
			return keys, nil
		}},
		"values": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("values: argument must be an object")
			}
			objectKeys := sortedObjectKeys(obj)
			vals := make([]any, 0, len(objectKeys))
			for _, k := range objectKeys {
				vals = append(vals, obj[k])
			}
			return vals, nil
		}},
		"entries": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("entries: argument must be an object")
			}
			objectKeys := sortedObjectKeys(obj)
			entries := make([]any, 0, len(objectKeys))
			for _, k := range objectKeys {
				entries = append(entries, []any{k, obj[k]})
			}
			return entries, nil
		}},
		"fromEntries": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			pairs, ok := args[0].([]any)
			if !ok {
				return nil, fmt.Errorf("fromEntries: argument must be an array")
			}
			obj := make(map[string]any, len(pairs))
			for _, p := range pairs {
				pair, ok := p.([]any)
				if !ok || len(pair) < 2 {
					return nil, fmt.Errorf("fromEntries: each entry must be a [key, value] pair")
				}
				key, ok := pair[0].(string)
				if !ok {
					return nil, fmt.Errorf("fromEntries: keys must be strings")
				}
				obj[key] = pair[1]
			}
			return obj, nil
		}},
		"merge": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			a, ok1 := args[0].(map[string]any)
			b, ok2 := args[1].(map[string]any)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("merge: arguments must be objects")
			}
			result := make(map[string]any, len(a)+len(b))
			for k, v := range a {
				result[k] = v
			}
			for k, v := range b {
				result[k] = v
			}
			return result, nil
		}},
		"hasKey": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("hasKey: first argument must be an object")
			}
			key, ok := args[1].(string)
			if !ok {
				return nil, fmt.Errorf("hasKey: second argument must be a string")
			}
			_, exists := obj[key]
			return exists, nil
		}},
		"isObject": &PureFunc{Arity: 1, Fn: func(args []any) (any, error) {
			_, isMap := args[0].(map[string]any)
			return isMap, nil
		}},
		"pick": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("pick: first argument must be an object")
			}
			ks, ok := args[1].([]any)
			if !ok {
				return nil, fmt.Errorf("pick: second argument must be an array")
			}
			result := make(map[string]any)
			for _, k := range ks {
				key, ok := k.(string)
				if !ok {
					continue
				}
				if v, exists := obj[key]; exists {
					result[key] = v
				}
			}
			return result, nil
		}},
		"omit": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			obj, ok := args[0].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("omit: first argument must be an object")
			}
			ks, ok := args[1].([]any)
			if !ok {
				return nil, fmt.Errorf("omit: second argument must be an array")
			}
			exclude := make(map[string]bool, len(ks))
			for _, k := range ks {
				if key, ok := k.(string); ok {
					exclude[key] = true
				}
			}
			result := make(map[string]any)
			for k, v := range obj {
				if !exclude[k] {
					result[k] = v
				}
			}
			return result, nil
		}},

		// Higher-order builtins
		"map": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("map: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				result := make([]any, len(arr))
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					result[i] = val
				}
				return result, nil
			},
		},
		"filter": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("filter: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				var result []any
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if isTruthy(val) {
						result = append(result, item)
					}
				}
				if result == nil {
					result = []any{}
				}
				return result, nil
			},
		},
		"reduce": &BuiltinFunc{
			Arity: 3,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[2].([]any)
				if !ok {
					return nil, fmt.Errorf("reduce: third argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				acc := args[1]
				for i, item := range arr {
					val, err := call(args[0], []any{acc, item, float64(i)})
					if err != nil {
						return nil, err
					}
					acc = val
				}
				return acc, nil
			},
		},
		"find": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("find: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if isTruthy(val) {
						return item, nil
					}
				}
				return nil, nil
			},
		},
		"findIndex": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("findIndex: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if isTruthy(val) {
						return float64(i), nil
					}
				}
				return float64(-1), nil
			},
		},
		"some": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("some: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if isTruthy(val) {
						return true, nil
					}
				}
				return false, nil
			},
		},
		"every": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("every: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if !isTruthy(val) {
						return false, nil
					}
				}
				return true, nil
			},
		},
		"sort": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("sort: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				sorted := make([]any, len(arr))
				copy(sorted, arr)
				var sortErr error
				sort.SliceStable(sorted, func(i, j int) bool {
					if sortErr != nil {
						return false
					}
					val, err := call(args[0], []any{sorted[i], sorted[j]})
					if err != nil {
						sortErr = err
						return false
					}
					n, _ := toFloat64(val)
					return n < 0
				})
				if sortErr != nil {
					return nil, sortErr
				}
				return sorted, nil
			},
		},
		"mapValues": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				obj, ok := args[1].(map[string]any)
				if !ok {
					return nil, fmt.Errorf("mapValues: second argument must be an object")
				}
				if err := meter.Charge(len(obj)); err != nil {
					return nil, err
				}
				result := make(map[string]any, len(obj))
				for k, v := range obj {
					val, err := call(args[0], []any{v, k})
					if err != nil {
						return nil, err
					}
					result[k] = val
				}
				return result, nil
			},
		},
		"flatMap": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("flatMap: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				var result []any
				for i, item := range arr {
					val, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					if mapped, ok := val.([]any); ok {
						result = append(result, mapped...)
					} else {
						result = append(result, val)
					}
				}
				if err := meter.GuardSize(len(result)); err != nil {
					return nil, err
				}
				return result, nil
			},
		},
		"groupBy": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("groupBy: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				groups := make(map[string]any)
				for i, item := range arr {
					key, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					var k string
					switch kv := key.(type) {
					case string:
						k = kv
					case float64:
						k = strconv.FormatFloat(kv, 'f', -1, 64)
					default:
						return nil, fmt.Errorf("groupBy: key function must return a string or number, got %T", key)
					}
					if existing, ok := groups[k]; ok {
						groups[k] = append(existing.([]any), item)
					} else {
						groups[k] = []any{item}
					}
				}
				return groups, nil
			},
		},
		"sortBy": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				arr, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("sortBy: second argument must be an array")
				}
				if err := meter.Charge(len(arr)); err != nil {
					return nil, err
				}
				type decorated struct {
					item any
					key  any
				}
				items := make([]decorated, len(arr))
				for i, item := range arr {
					key, err := call(args[0], []any{item, float64(i)})
					if err != nil {
						return nil, err
					}
					items[i] = decorated{item: item, key: key}
				}
				sort.SliceStable(items, func(i, j int) bool {
					return jsonLess(items[i].key, items[j].key)
				})
				result := make([]any, len(items))
				for i, d := range items {
					result[i] = d.item
				}
				return result, nil
			},
		},
		"apply": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				argsArray, ok := args[1].([]any)
				if !ok {
					return nil, fmt.Errorf("apply: second argument must be an array")
				}
				return call(args[0], argsArray)
			},
		},
		"pipe": &BuiltinFunc{
			Arity: 2,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				fnsArr, ok := args[0].([]any)
				if !ok {
					return nil, fmt.Errorf("pipe: first argument must be an array of functions")
				}
				if err := meter.Charge(len(fnsArr)); err != nil {
					return nil, err
				}
				value := args[1]
				for _, fn := range fnsArr {
					val, err := call(fn, []any{value})
					if err != nil {
						return nil, err
					}
					value = val
				}
				return value, nil
			},
		},

		// Regex
		"reTest": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			pattern, ok1 := args[0].(string)
			str, ok2 := args[1].(string)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("reTest: arguments must be strings")
			}
			re, err := parsePattern(pattern)
			if err != nil {
				return nil, err
			}
			return re.MatchString(str), nil
		}},
		"reMatch": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			pattern, ok1 := args[0].(string)
			str, ok2 := args[1].(string)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("reMatch: arguments must be strings")
			}
			re, err := parsePattern(pattern)
			if err != nil {
				return nil, err
			}
			loc := re.FindStringIndex(str)
			if loc == nil {
				return nil, nil
			}
			m := re.FindStringSubmatch(str)
			return buildMatchResult(re, m, loc[0]), nil
		}},
		"reMatchAll": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			pattern, ok1 := args[0].(string)
			str, ok2 := args[1].(string)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("reMatchAll: arguments must be strings")
			}
			re, err := parsePattern(pattern)
			if err != nil {
				return nil, err
			}
			matches := re.FindAllStringSubmatchIndex(str, -1)
			results := make([]any, 0, len(matches))
			for _, loc := range matches {
				m := extractSubmatch(str, loc)
				results = append(results, buildMatchResult(re, m, loc[0]))
			}
			return results, nil
		}},
		"reReplace": &PureFunc{Arity: 3, Fn: func(args []any) (any, error) {
			pattern, ok1 := args[0].(string)
			replacement, ok2 := args[1].(string)
			str, ok3 := args[2].(string)
			if !ok1 || !ok2 || !ok3 {
				return nil, fmt.Errorf("reReplace: arguments must be strings")
			}
			re, err := parsePattern(pattern)
			if err != nil {
				return nil, err
			}
			return re.ReplaceAllString(str, replacement), nil
		}},
		"reSplit": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			pattern, ok1 := args[0].(string)
			str, ok2 := args[1].(string)
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("reSplit: arguments must be strings")
			}
			re, err := parsePattern(pattern)
			if err != nil {
				return nil, err
			}
			parts := re.Split(str, -1)
			result := make([]any, len(parts))
			for i, p := range parts {
				result[i] = p
			}
			return result, nil
		}},
		"reReplaceWith": &BuiltinFunc{
			Arity: 3,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				pattern, ok1 := args[0].(string)
				callback := args[1]
				str, ok3 := args[2].(string)
				if !ok1 {
					return nil, fmt.Errorf("reReplaceWith: first argument must be a pattern string")
				}
				if !ok3 {
					return nil, fmt.Errorf("reReplaceWith: third argument must be a string")
				}
				if err := meter.Charge(len(str)); err != nil {
					return nil, err
				}
				re, err := parsePattern(pattern)
				if err != nil {
					return nil, err
				}
				matches := re.FindAllStringSubmatchIndex(str, -1)
				if len(matches) == 0 {
					return str, nil
				}
				var b strings.Builder
				lastIndex := 0
				for _, loc := range matches {
					b.WriteString(str[lastIndex:loc[0]])
					m := extractSubmatch(str, loc)
					matchObj := buildMatchResult(re, m, loc[0])
					replaced, err := call(callback, []any{matchObj})
					if err != nil {
						return nil, err
					}
					b.WriteString(fmt.Sprint(replaced))
					lastIndex = loc[1]
				}
				b.WriteString(str[lastIndex:])
				return b.String(), nil
			},
		},

		// Introspection
		"arity": &BuiltinFunc{
			Arity: 1,
			Fn: func(args []any, call CallFunc, fns FunctionRegistry, meter *Meter) (any, error) {
				a := GetArity(args[0], fns)
				if a < 0 {
					return nil, nil
				}
				return float64(a), nil
			},
		},

		// Debugging
		"log": &PureFunc{Arity: 2, Fn: func(args []any) (any, error) {
			if logger != nil {
				if len(args) > 1 {
					logger(args[0], args[1])
				} else {
					logger(args[0])
				}
			}
			return args[0], nil
		}},
	}
}

// --- helpers ---

func oneFloat(args []any, name string) (float64, error) {
	a, ok := toFloat64(args[0])
	if !ok {
		return 0, fmt.Errorf("%s: argument must be a number", name)
	}
	return a, nil
}

func twoFloats(args []any, name string) (float64, float64, error) {
	a, ok1 := toFloat64(args[0])
	b, ok2 := toFloat64(args[1])
	if !ok1 || !ok2 {
		return 0, 0, fmt.Errorf("%s: arguments must be numbers", name)
	}
	return a, b, nil
}

// jsonEqual performs a deep equality check matching JavaScript === semantics
// for primitives and structural equality for arrays/objects.
func jsonEqual(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	switch av := a.(type) {
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !jsonEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			bVal, exists := bv[k]
			if !exists || !jsonEqual(v, bVal) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func jsonLess(a, b any) bool {
	switch av := a.(type) {
	case float64:
		if bv, ok := b.(float64); ok {
			return av < bv
		}
	case string:
		if bv, ok := b.(string); ok {
			return av < bv
		}
	}
	return false
}

var inlineFlagsRE = regexp.MustCompile(`^\(\?([imsu]*)\)`)

func parsePattern(pattern string) (*regexp.Regexp, error) {
	flags := ""
	source := pattern

	if m := inlineFlagsRE.FindStringSubmatch(pattern); m != nil {
		flags = m[1]
		source = pattern[len(m[0]):]
	}

	goFlags := ""
	for _, f := range flags {
		switch f {
		case 'i':
			goFlags += "i"
		case 'm':
			goFlags += "m"
		case 's':
			goFlags += "s"
		case 'u':
			// Go's regexp is always Unicode-aware
		default:
			return nil, fmt.Errorf("reTest: unsupported flag %q", string(f))
		}
	}

	if goFlags != "" {
		source = "(?" + goFlags + ")" + source
	}

	return regexp.Compile(source)
}

func buildMatchResult(re *regexp.Regexp, m []string, index int) map[string]any {
	groups := make([]any, 0, len(m)-1)
	for i := 1; i < len(m); i++ {
		if m[i] == "" && i < len(m) {
			groups = append(groups, nil)
		} else {
			groups = append(groups, m[i])
		}
	}

	named := make(map[string]any)
	for _, name := range re.SubexpNames() {
		if name != "" {
			idx := re.SubexpIndex(name)
			if idx >= 0 && idx < len(m) {
				if m[idx] == "" {
					named[name] = nil
				} else {
					named[name] = m[idx]
				}
			}
		}
	}

	return map[string]any{
		"match":  m[0],
		"index":  float64(index),
		"groups": groups,
		"named":  named,
	}
}

func extractSubmatch(str string, loc []int) []string {
	result := make([]string, len(loc)/2)
	for i := 0; i < len(loc); i += 2 {
		if loc[i] >= 0 {
			result[i/2] = str[loc[i]:loc[i+1]]
		}
	}
	return result
}
