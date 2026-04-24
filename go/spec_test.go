package jsonfn

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type testCase struct {
	Description string           `json:"description"`
	Body        any              `json:"body"`
	Args        []any            `json:"args"`
	Functions   map[string]any   `json:"functions"`
	Limits      *ExecutionLimits `json:"limits"`
	Expected    any              `json:"expected"`
	Error       *string          `json:"error"`
}

type testSuite struct {
	Description string         `json:"description"`
	Functions   map[string]any `json:"functions"`
	Cases       []testCase     `json:"cases"`
}

func TestSpec(t *testing.T) {
	specDir := filepath.Join("..", "spec", "cases")

	entries, err := os.ReadDir(specDir)
	if err != nil {
		t.Fatalf("Failed to read spec directory: %v", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(specDir, file))
		if err != nil {
			t.Fatalf("Failed to read %s: %v", file, err)
		}

		var suite testSuite
		if err := json.Unmarshal(data, &suite); err != nil {
			t.Fatalf("Failed to parse %s: %v", file, err)
		}

		t.Run(suite.Description, func(t *testing.T) {
			for _, tc := range suite.Cases {
				t.Run(tc.Description, func(t *testing.T) {
					runTestCase(t, tc, suite.Functions)
				})
			}
		})
	}
}

func runTestCase(t *testing.T, tc testCase, suiteFunctions map[string]any) {
	t.Helper()

	functions := CreateStdlib()
	for k, v := range suiteFunctions {
		functions[k] = v
	}
	for k, v := range tc.Functions {
		functions[k] = v
	}

	args := tc.Args
	if args == nil {
		args = []any{}
	}

	if tc.Error != nil {
		result, err := CallFunction(tc.Body, args, functions, tc.Limits)
		if err == nil {
			t.Errorf("Expected error containing %q, but got result: %v", *tc.Error, result)
			return
		}
		if !strings.Contains(err.Error(), *tc.Error) {
			t.Errorf("Expected error containing %q, got: %q", *tc.Error, err.Error())
		}
		return
	}

	result, err := CallFunction(tc.Body, args, functions, tc.Limits)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !jsonEqual(result, tc.Expected) {
		resultJSON, _ := json.MarshalIndent(result, "", "  ")
		expectedJSON, _ := json.MarshalIndent(tc.Expected, "", "  ")
		t.Errorf("Result mismatch.\nGot:      %s\nExpected: %s", string(resultJSON), string(expectedJSON))
	}
}

func TestBasicSmoke(t *testing.T) {
	stdlib := CreateStdlib()

	body := map[string]any{
		"$params": []any{"a", "b"},
		"$return": map[string]any{
			"$fn": []any{"add", map[string]any{"$var": "a"}, map[string]any{"$var": "b"}},
		},
	}

	result, err := CallFunction(body, []any{float64(2), float64(3)}, stdlib, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	expected := float64(5)
	if result != expected {
		t.Errorf("Expected %v, got %v", expected, result)
	}

	fmt.Println("Smoke test passed: add(2, 3) =", result)
}
