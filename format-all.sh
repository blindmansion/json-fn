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

run "TypeScript typecheck, lint fix, and format" "$ROOT_DIR/typescript" bun run fix
run "Python lint fix" "$ROOT_DIR/python" uv run ruff check --fix .
run "Python format" "$ROOT_DIR/python" uv run ruff format .
run "Go format" "$ROOT_DIR/go" gofmt -w .
run "Rust format" "$ROOT_DIR/rust" cargo fmt

printf "\nFormatting and auto-fixes complete.\n"
