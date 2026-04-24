package jsonfn

import (
	"io"
	"os"
	"testing"
)

func TestLogReturnsValueAndPrints(t *testing.T) {
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

	oldStdout := os.Stdout
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer func() {
		os.Stdout = oldStdout
		readPipe.Close()
	}()
	os.Stdout = writePipe

	result, err := CallFunction(body, []any{}, stdlib, nil)
	writePipe.Close()
	os.Stdout = oldStdout
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if !jsonEqual(result, map[string]any{"answer": float64(42), "ok": true}) {
		t.Fatalf("Unexpected result: %#v", result)
	}
	output, err := io.ReadAll(readPipe)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	expected := "[debug] {\n  \"answer\": 42,\n  \"ok\": true\n}\n"
	if string(output) != expected {
		t.Fatalf("Unexpected log output.\nGot:  %q\nWant: %q", string(output), expected)
	}
}
