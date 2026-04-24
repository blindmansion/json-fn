#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  local label="$1"
  local dir="$2"
  shift 2

  printf "\n==> %s\n" "$label"
  (cd "$dir" && "$@")
}

run "TypeScript check" "$ROOT_DIR/typescript" bun run check
run "TypeScript tests" "$ROOT_DIR/typescript" bun test
run "Python lint" "$ROOT_DIR/python" uv run ruff check .
run "Python tests" "$ROOT_DIR/python" uv run pytest
run "Go vet" "$ROOT_DIR/go" go vet ./...
run "Go tests" "$ROOT_DIR/go" go test ./...
run "Rust clippy" "$ROOT_DIR/rust" cargo clippy --all-targets --all-features -- -D warnings
run "Rust tests" "$ROOT_DIR/rust" cargo test

printf "\nAll checks and tests passed.\n"
