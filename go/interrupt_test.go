package jsonfn

import (
	"context"
	"strings"
	"testing"
	"time"
)

// fibRegistry returns the stdlib plus a recursive `fib` JSON function, useful
// for producing a long-running evaluation.
func fibRegistry() FunctionRegistry {
	reg := CreateStdlib()
	reg["fib"] = map[string]any{
		"$params": []any{"n"},
		"$return": map[string]any{
			"$if":   map[string]any{"$fn": []any{"lte", map[string]any{"$var": "n"}, float64(1)}},
			"$then": map[string]any{"$var": "n"},
			"$else": map[string]any{
				"$fn": []any{
					"add",
					map[string]any{"$fn": []any{"fib", map[string]any{"$fn": []any{"sub", map[string]any{"$var": "n"}, float64(1)}}}},
					map[string]any{"$fn": []any{"fib", map[string]any{"$fn": []any{"sub", map[string]any{"$var": "n"}, float64(2)}}}},
				},
			},
		},
	}
	return reg
}

func TestCancelledContextAborts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body := map[string]any{"$return": map[string]any{"$fn": []any{"fib", float64(30)}}}
	_, err := CallFunction(body, nil, fibRegistry(), &ExecutionLimits{Ctx: ctx})
	if err == nil || !strings.Contains(err.Error(), "Execution aborted") {
		t.Fatalf("expected abort, got %v", err)
	}
}

func TestDeadlineTimesOut(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now())
	defer cancel()
	body := map[string]any{"$return": map[string]any{"$fn": []any{"fib", float64(30)}}}
	_, err := CallFunction(body, nil, fibRegistry(), &ExecutionLimits{Ctx: ctx})
	if err == nil || !strings.Contains(err.Error(), "Execution timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
}

// A deadline must also interrupt a native higher-order loop over a pure
// builtin — the op-bomb shape that never re-enters evaluateExpression.
func TestDeadlineTimesOutInHigherOrderLoop(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now())
	defer cancel()
	body := map[string]any{
		"$return": map[string]any{
			"$fn": []any{"map", "neg", map[string]any{"$fn": []any{"range", float64(2_000_000)}}},
		},
	}
	_, err := CallFunction(body, nil, CreateStdlib(), &ExecutionLimits{Ctx: ctx})
	if err == nil || !strings.Contains(err.Error(), "Execution timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
}

func TestNoContextIsFine(t *testing.T) {
	body := map[string]any{"$return": map[string]any{"$fn": []any{"add", float64(1), float64(2)}}}
	result, err := CallFunction(body, nil, CreateStdlib(), &ExecutionLimits{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != float64(3) {
		t.Fatalf("unexpected result: %#v", result)
	}
}
