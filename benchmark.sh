#!/usr/bin/env bash
set -euo pipefail

# json-fn benchmark comparison: Go vs TypeScript (Bun)
# Runs identical workloads in both interpreters and displays a comparison table.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GO_DIR="$SCRIPT_DIR/go"
TS_DIR="$SCRIPT_DIR/typescript"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

printf "${BOLD}json-fn interpreter benchmark: Go vs TypeScript (Bun)${RESET}\n"
printf "${DIM}────────────────────────────────────────────────────────${RESET}\n\n"

# --- Run Go benchmarks ---
printf "${CYAN}Running Go benchmarks...${RESET}\n"
go_raw=$(cd "$GO_DIR" && go test -bench=. -benchtime=1s -count=1 -timeout=300s 2>&1) || {
  printf "Go benchmarks failed:\n%s\n" "$go_raw"
  exit 1
}

# --- Run TS benchmarks ---
printf "${CYAN}Running TypeScript benchmarks...${RESET}\n"
ts_raw=$(cd "$TS_DIR" && bun run examples/bench-compare.ts 2>&1) || {
  printf "TypeScript benchmarks failed:\n%s\n" "$ts_raw"
  exit 1
}

# --- Parse Go output ---
# Format: BenchmarkName/sub-10    N    XXXXX ns/op
declare -A go_results
while IFS= read -r line; do
  if [[ "$line" =~ ^Benchmark([A-Za-z0-9_]+)/?(.*)-[0-9]+[[:space:]]+[0-9]+[[:space:]]+([0-9]+)[[:space:]]ns/op ]]; then
    name="${BASH_REMATCH[1]}"
    sub="${BASH_REMATCH[2]}"
    ns="${BASH_REMATCH[3]}"
    key="${name}"
    [[ -n "$sub" ]] && key="${name}/${sub}"
    go_results["$key"]="$ns"
  fi
done <<< "$go_raw"

# --- Parse TS output ---
# Format: BENCH\tName\tXXXXX ns/op\t(...)
declare -A ts_results
while IFS= read -r line; do
  if [[ "$line" =~ ^BENCH$'\t'(.+)$'\t'([0-9]+)\ ns/op ]]; then
    key="${BASH_REMATCH[1]}"
    ns="${BASH_REMATCH[2]}"
    ts_results["$key"]="$ns"
  fi
done <<< "$ts_raw"

# --- Collect all keys and sort ---
declare -A all_keys
for k in "${!go_results[@]}"; do all_keys["$k"]=1; done
for k in "${!ts_results[@]}"; do all_keys["$k"]=1; done

sorted_keys=($(for k in "${!all_keys[@]}"; do echo "$k"; done | sort))

# --- Helper: format ns to human-readable ---
fmt_ns() {
  local ns=$1
  if (( ns >= 1000000000 )); then
    printf "%.2fs" "$(echo "$ns / 1000000000" | bc -l)"
  elif (( ns >= 1000000 )); then
    printf "%.1fms" "$(echo "$ns / 1000000" | bc -l)"
  elif (( ns >= 1000 )); then
    printf "%.1fµs" "$(echo "$ns / 1000" | bc -l)"
  else
    printf "%dns" "$ns"
  fi
}

# --- Print comparison table ---
printf "\n${BOLD}%-40s %12s %12s %10s${RESET}\n" "Benchmark" "Go" "TypeScript" "Ratio"
printf "%-40s %12s %12s %10s\n" "────────────────────────────────────────" "────────────" "────────────" "──────────"

for key in "${sorted_keys[@]}"; do
  go_ns="${go_results[$key]:-}"
  ts_ns="${ts_results[$key]:-}"

  go_fmt="—"
  ts_fmt="—"
  ratio="—"

  [[ -n "$go_ns" ]] && go_fmt=$(fmt_ns "$go_ns")
  [[ -n "$ts_ns" ]] && ts_fmt=$(fmt_ns "$ts_ns")

  if [[ -n "$go_ns" && -n "$ts_ns" && "$go_ns" -gt 0 ]]; then
    ratio_val=$(echo "scale=2; $ts_ns / $go_ns" | bc -l)
    if (( $(echo "$ratio_val > 1" | bc -l) )); then
      ratio="${GREEN}${ratio_val}x ← Go${RESET}"
    else
      inv=$(echo "scale=2; $go_ns / $ts_ns" | bc -l)
      ratio="${YELLOW}${inv}x ← TS${RESET}"
    fi
  fi

  printf "%-40s %12s %12s %b\n" "$key" "$go_fmt" "$ts_fmt" "$ratio"
done

printf "\n${DIM}Ratio: how many times slower the loser is (e.g. 3.50x ← Go means Go is 3.5x faster)${RESET}\n"

# --- Print raw output if -v flag ---
if [[ "${1:-}" == "-v" ]]; then
  printf "\n${BOLD}═══ Raw Go output ═══${RESET}\n"
  echo "$go_raw"
  printf "\n${BOLD}═══ Raw TypeScript output ═══${RESET}\n"
  echo "$ts_raw"
fi
