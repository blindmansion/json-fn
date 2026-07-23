# AGENTS.md

json-fn is a pure-JSON functional expression language evaluated by a tree-walking interpreter. See `README.md` for the language pitch and `docs/language.md` for the full reference.

> Note: `README.md` is currently out of date. We're not updating it yet, so treat `docs/` as the source of truth for language details.

## Reference docs & working notes

- `docs/` — language reference documentation.
  - `docs/language.md` — full language reference.
  - `docs/shorthand-spec.md` — the `.jfn` shorthand syntax spec.
  - `docs/environment-contract.md` — portable operator-owned boundary contract.
  - `docs/deployment-profile.md` — portable live/durable deployment selection.
  - `docs/durable-host.md` — TypeScript durable task-host configuration, persistence, recovery, and failure semantics.
- `plans/` — design plans and sketches for in-progress / proposed language work (e.g. `module-scope.md`, `effects-sketch.md`, `type-sketch.md`).
- `todo/` — outstanding work items and tracking notes (e.g. `conformance-tests.md`, `impl-feature-parity.md`, `new-features.md`).
- `examples/` — sample programs in `.jfn` shorthand and canonical `.json` (e.g. `chess`, `tictactoe`, `life`, `stretch`).

## Implementations

There are four interpreters. **The TypeScript implementation (`typescript/`) is the canonical one** — treat it as the source of truth when behaviors disagree.

- `typescript/` — **canonical.** All new language work lands here first.
- `go/` — known to be out of spec.
- `python/` — known to be out of spec.
- `rust/` — known to be out of spec.

The Go, Python, and Rust implementations are **known to lag / be out of spec** right now while we iterate on the language itself. Don't assume they're correct, and don't spend effort reconciling them unless explicitly asked.

The shared, language-agnostic conformance suites live in `spec/cases/` (and `spec/parse-cases/`). Every implementation is meant to pass them, but currently only TypeScript is expected to.

## Root scripts

Run from the repo root:

- `./format-all.sh` — format + safe auto-fixes across all four implementations.
- `./test-all.sh` — run all checks/tests: TS check+tests, Python lint+pytest, Go vet+tests, Rust clippy+tests.
- `./benchmark.sh` — Go vs TypeScript (Bun) benchmark comparison table (`-v` for raw output).

When working only on TypeScript, prefer the scoped commands below over the whole-repo scripts.

## TypeScript project (`typescript/`)

Uses **Bun** (not node/npm). Common commands, run inside `typescript/`:

- `bun run check` — `tsc --noEmit`, oxlint, oxfmt --check, spec-case format check.
- `bun run fix` — typecheck, lint --fix, format (TS + spec-case JSON).
- `bun test` — run the test suite.
- `bun run generate:builtins-doc` — regenerate `docs/builtins.md`; run whenever `spec/builtins.json` is updated.

### The `jfn` CLI

The CLI lives at `typescript/src/cli.ts` and is exposed as the `jfn` bin. From inside `typescript/`, run it with `bun run src/cli.ts <command>` (or `bun run cli <command>`).

Input is read from a positional argument, `--file <path>`, or stdin (in that order). Use `-` to force stdin. This composes well with pipes and heredocs.

Commands:

- `to-shorthand` (aliases `j2s`, `print`) — canonical json-fn JSON → `.jfn` shorthand.
- `to-json` (aliases `s2j`, `parse`) — `.jfn` shorthand → canonical json-fn JSON. `-c/--compact` for minified output.
- `eval` (alias `e`) — evaluate a `.jfn` expression and print the result.
  - `--contract <path>` — treat input as a module and run the
    environment-contract entry with an empty live runtime adapter/profile; the
    contract must declare no direct host functions.
  - `--function <name>` — with `--contract`, development-evaluate any named module function through the shared linker.
  - `--args <json>` — JSON array of arguments (default `[]`).
 - `--json-input` — read canonical json-fn JSON instead of `.jfn` shorthand.
  - `-j/--json` (default) or `-s/--shorthand` — output format; `-c/--compact` minifies JSON.
- `check` (alias `c`) — typecheck a module or expression; `--contract <path>`
  links the operator-owned environment contract and checks its entry boundary.
- `validate-contract` — validate portable environment-contract JSON.
- `validate-profile --contract <path>` — validate portable deployment profile JSON.

Examples:

```bash
cd typescript

# Parse shorthand to canonical JSON
bun run src/cli.ts to-json '1 + 2 * 3'

# Print canonical JSON as shorthand
echo '{ "$fn": ["add", 1, 2] }' | bun run src/cli.ts to-shorthand

# Evaluate a function applied to args
bun run src/cli.ts eval '(x) => x * x' --args '[9]'

# Evaluate and print as shorthand
bun run src/cli.ts eval 'map((n) => n + 1, [1, 2, 3])' --shorthand

# Run a module entry that needs no host function/effect implementations
bun run src/cli.ts eval --file module.jfn --contract module.contract.json

# Development-run an in-language demo through the shared linker
bun run src/cli.ts eval --file module.jfn --contract module.contract.json --function demo

# Validate the portable deployment artifacts
bun run src/cli.ts validate-contract --file module.contract.json
bun run src/cli.ts validate-profile --contract module.contract.json --file module.profile.json
```

Run `bun run src/cli.ts --help` for the full usage text.
