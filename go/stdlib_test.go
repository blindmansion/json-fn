package jsonfn

import "testing"

func TestLogReturnsValueWithoutPrintingByDefault(t *testing.T) {
	stdlib := CreateStdlib()
	body := map[string]any{
		"$return": map[string]any{
			"$fn": []any{
				"log",
				map[string]any{"answer": float64(42), "ok": true},
				"debug",
			},
		},
	}

	result, err := CallFunction(body, []any{}, stdlib, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !jsonEqual(result, map[string]any{"answer": float64(42), "ok": true}) {
		t.Fatalf("Unexpected result: %#v", result)
	}
}

func TestLogCallsConfiguredLogger(t *testing.T) {
	var calls [][]any
	stdlib := CreateStdlib(StdlibOptions{
		Logger: func(value any, label ...any) {
			calls = append(calls, append([]any{value}, label...))
		},
	})
	body := map[string]any{
		"$return": map[string]any{
			"$fn": []any{
				"log",
				map[string]any{"answer": float64(42), "ok": true},
				"debug",
			},
		},
	}

	result, err := CallFunction(body, []any{}, stdlib, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !jsonEqual(result, map[string]any{"answer": float64(42), "ok": true}) {
		t.Fatalf("Unexpected result: %#v", result)
	}
	if len(calls) != 1 ||
		!jsonEqual(calls[0][0], map[string]any{"answer": float64(42), "ok": true}) ||
		calls[0][1] != "debug" {
		t.Fatalf("Unexpected logger calls: %#v", calls)
	}
}
