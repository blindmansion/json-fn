package jsonfn

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

func exprError(expr any, message string) error {
	b, _ := json.MarshalIndent(expr, "", "  ")
	return fmt.Errorf("Invalid JSON expression: %s. %s", string(b), message)
}

func objectKeyCount(obj map[string]any) int {
	return len(obj)
}

func isFnDeclaration(value any) bool {
	switch v := value.(type) {
	case string:
		return true
	case map[string]any:
		_, ok := v["$return"]
		return ok
	default:
		_ = v
		return false
	}
}

// parsedPath holds a decomposed $var path like "foo.bar[0].baz".
type parsedPath struct {
	variable string
	path     []any // string or int segments
}

var (
	pathCacheMu   sync.RWMutex
	pathCache     = make(map[string]parsedPath)
	pathCacheMax  = 1024
)

func parsePath(str string) (parsedPath, error) {
	pathCacheMu.RLock()
	if cached, ok := pathCache[str]; ok {
		pathCacheMu.RUnlock()
		return cached, nil
	}
	pathCacheMu.RUnlock()

	dotIdx := strings.Index(str, ".")
	bracketIdx := strings.Index(str, "[")

	if dotIdx == -1 && bracketIdx == -1 {
		result := parsedPath{variable: str, path: nil}
		cachePathResult(str, result)
		return result, nil
	}

	var splitIdx int
	switch {
	case dotIdx == -1:
		splitIdx = bracketIdx
	case bracketIdx == -1:
		splitIdx = dotIdx
	default:
		splitIdx = min(dotIdx, bracketIdx)
	}

	variable := str[:splitIdx]
	if variable == "" {
		return parsedPath{}, fmt.Errorf(`Invalid $var path: variable name cannot be empty in "%s"`, str)
	}

	var path []any
	i := splitIdx

	for i < len(str) {
		ch := str[i]
		switch ch {
		case '.':
			i++
			end := i
			for end < len(str) && str[end] != '.' && str[end] != '[' {
				end++
			}
			if end == i {
				return parsedPath{}, fmt.Errorf(`Invalid $var path: empty segment after "." in "%s"`, str)
			}
			path = append(path, str[i:end])
			i = end

		case '[':
			i++
			closeIdx := strings.Index(str[i:], "]")
			if closeIdx == -1 {
				return parsedPath{}, fmt.Errorf(`Invalid $var path: unclosed "[" in "%s"`, str)
			}
			closeIdx += i
			inner := str[i:closeIdx]
			if inner == "" {
				return parsedPath{}, fmt.Errorf(`Invalid $var path: empty "[]" in "%s"`, str)
			}
			if n, err := strconv.Atoi(inner); err == nil && strconv.Itoa(n) == inner {
				path = append(path, n)
			} else {
				path = append(path, inner)
			}
			i = closeIdx + 1

		default:
			return parsedPath{}, fmt.Errorf(`Invalid $var path: unexpected character "%c" in "%s"`, ch, str)
		}
	}

	result := parsedPath{variable: variable, path: path}
	cachePathResult(str, result)
	return result, nil
}

func cachePathResult(str string, result parsedPath) {
	pathCacheMu.Lock()
	if len(pathCache) >= pathCacheMax {
		for k := range pathCache {
			delete(pathCache, k)
			break
		}
	}
	pathCache[str] = result
	pathCacheMu.Unlock()
}

func walkPath(value any, path []any) any {
	current := value
	for _, segment := range path {
		switch c := current.(type) {
		case string:
			if idx, ok := segment.(int); ok {
				if idx >= 0 && idx < len(c) {
					current = string(c[idx])
				} else {
					return nil
				}
			} else {
				return nil
			}
		case map[string]any:
			switch s := segment.(type) {
			case string:
				v, ok := c[s]
				if !ok {
					return nil
				}
				current = v
			case int:
				return nil
			default:
				return nil
			}
		case []any:
			switch s := segment.(type) {
			case int:
				if s >= 0 && s < len(c) {
					current = c[s]
				} else {
					return nil
				}
			case string:
				return nil
			default:
				return nil
			}
		default:
			return nil
		}
	}
	return current
}

func resolveVar(varPath string, getVar func(string) (any, bool, error), expression any) (any, error) {
	parsed, err := parsePath(varPath)
	if err != nil {
		return nil, err
	}
	value, ok, err := getVar(parsed.variable)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, exprError(expression, fmt.Sprintf("Variable %s not found.", parsed.variable))
	}
	if len(parsed.path) > 0 {
		return walkPath(value, parsed.path), nil
	}
	return value, nil
}

func validateParamName(name string) error {
	if strings.Contains(name, ".") || strings.Contains(name, "[") {
		return fmt.Errorf(`Parameter name "%s" must not contain "." or "[". Use simple identifiers.`, name)
	}
	return nil
}

// isTruthy follows JavaScript truthiness rules for json-fn evaluation.
func isTruthy(v any) bool {
	if v == nil {
		return false
	}
	switch val := v.(type) {
	case bool:
		return val
	case float64:
		return val != 0
	case string:
		return val != ""
	default:
		return true
	}
}

// toFloat64 attempts to extract a float64 from a JSON number value.
func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}

// GetArity returns the arity of a function, or -1 if unknown.
func GetArity(fn any, registry FunctionRegistry) int {
	switch f := fn.(type) {
	case map[string]any:
		if _, ok := f["$return"]; ok {
			params, _ := f["$params"].([]any)
			if len(params) == 0 {
				return 0
			}
			last, _ := params[len(params)-1].(string)
			if strings.HasPrefix(last, "...") {
				return len(params) - 1
			}
			return len(params)
		}
	case string:
		if registry != nil {
			if entry, ok := registry[f]; ok {
				return GetArity(entry, registry)
			}
		}
	case *BuiltinFunc:
		return f.Arity
	case *PureFunc:
		return f.Arity
	}
	return -1
}
