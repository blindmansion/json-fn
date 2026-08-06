# AGENTS.md

json-fn is built for agents that write programs rather than issuing one tool call at a time — but instead of sandboxing a general-purpose language after the fact, it makes agent-written code safe by construction: pure JSON programs with no I/O and no capability beyond what an operator-owned contract explicitly declares. Because the program is inert data, it's an auditable artifact — typecheckable against its contract, hashable, diffable, and human-readable — so operators can review exactly what an agent's automation can do before embedding it in their application. And because continuations are JSON too, agent-written workflows suspend, persist, and resume across process restarts natively, giving durable orchestration without replay machinery.

json-fn is a pure-JSON functional expression language evaluated by a tree-walking interpreter. See `spec/docs/index.md` for the documentation map and `spec/docs/language/json/index.md` for the full reference; `spec/docs/` is the source of truth for language details. (There is no root `README.md` right now — it will be rewritten once the project stabilizes.)

## Reference docs & working notes

- `spec/docs/` — language, authoring, deployment, runtime, and conformance documentation.
  - `spec/docs/index.md` — documentation map and recommended reading paths.
  - `spec/docs/guides/` — authoring guides.
  - `spec/docs/language/` — language, shorthand, type syntax, and narrowing references.
  - `spec/docs/builtins/` — generated builtin catalog and signature-registry specification.
  - `spec/docs/conformance/` — parsing, builtin, and checker adapter requirements.
  - `spec/docs/runtime/` — execution limits, hashing, and durable host behavior.
  - `spec/docs/deployment/` — portable environment contract and deployment profile.
- `plans/` — design plans and sketches for in-progress or proposed language work.
- `examples/` — sample `.jfn` programs with portable environment contracts and deployment profiles (e.g. `dungeon`, `thermostat`, `orbital-traffic`, `parcel-sorter`).

## Implementations

The TypeScript implementation (`typescript/`) is the canonical interpreter and source of truth.

- `typescript/` — **canonical.** All new language work lands here first.

The shared, language-agnostic conformance suites live in `spec/cases/`.
Checker cases live in `spec/cases/check/`; their adapter contract is documented
in `spec/docs/conformance/checking.md`.

## TypeScript project (`typescript/`)

Uses **Bun** (not node/npm). Common commands, run inside `typescript/`:

- `bun run check` — `tsc --noEmit`, oxlint, oxfmt --check, spec-case format check.
- `bun run fix` — typecheck, lint --fix, format (TS + spec-case JSON).
- `bun test` — run the test suite.
- `bun run generate:builtins-doc` — regenerate `spec/docs/builtins/builtins.md`; run whenever `spec/builtins/builtins.json` is updated.
- `bun run validate:spec-cases <spec-dir>` — validate conformance case files against their suite schemas; `<spec-dir>` is relative to the repo root (e.g. `spec` or `spec-v2`). Run after altering any spec cases.
- `bun test test/check-spec.test.ts` — run the shared checker conformance corpus.

### The `jfn` CLI

The CLI lives at `typescript/src/cli.ts` and is exposed as the `jfn` bin. From inside `typescript/`, run it with `bun run src/cli.ts <command>` (or `bun run cli <command>`).

Input is read from a positional argument, `--file <path>`, or stdin (in that order). The positional argument is the source text itself, not a path — use `--file` for files. Use `-` to force stdin. This composes well with pipes and heredocs.

Commands:

- `to-shorthand` (aliases `j2s`, `print`) — canonical json-fn JSON → `.jfn` shorthand.
- `to-json` (aliases `s2j`, `parse`) — `.jfn` shorthand → canonical json-fn JSON. `-c/--compact` for minified output.
- `eval` (alias `e`) — evaluate a `.jfn` expression and print the result.
  - `--contract <path>` — treat input as a module and run the
    environment-contract entry with an empty live runtime adapter/profile; the
    contract must declare no direct host functions.
  - `--function <name>` — development-evaluate any named module function through the shared linker; `--contract` is optional.
  - `--args <json>` — JSON array of arguments (default `[]`).
  - `--json-input` — read canonical json-fn JSON instead of `.jfn` shorthand.
  - `-j/--json` (default) or `-s/--shorthand` — output format; `-c/--compact` minifies JSON.
- `check` (alias `c`) — typecheck a module or expression; `--contract <path>`
  links the operator-owned environment contract and checks its entry boundary.
  `--json` (alias `--json-input`) reads canonical json-fn JSON instead of `.jfn`
  shorthand. Diagnostics on shorthand input carry source positions
  (`(at [file:]line:col)`; `line`/`col` fields with `--json-diagnostics`).
- `builtin <name>` — print a builtin's signatures and description.
- `validate-contract` — validate portable environment-contract JSON.
- `validate-profile --contract <path>` — validate portable deployment profile JSON.

Examples:

```bash
cd typescript

# Parse shorthand to canonical JSON
bun run src/cli.ts to-json --expr '1 + 2 * 3'

# Print canonical JSON as shorthand
echo '{ "$call": "add", "$args": [1, 2] }' | bun run src/cli.ts to-shorthand --expr

# Evaluate a function applied to args
bun run src/cli.ts eval --expr '(x) => x * x' --args '[9]'

# Evaluate and print as shorthand
bun run src/cli.ts eval --expr 'map((n) => n + 1, [1, 2, 3])' --shorthand

# Run a module entry that needs no host function/effect implementations
bun run src/cli.ts eval --file module.jfn --contract module.contract.json

# Development-run a self-contained module function
bun run src/cli.ts eval --file module.jfn --function demo

# Development-run an in-language demo through the shared linker
bun run src/cli.ts eval --file module.jfn --contract module.contract.json --function demo

# Validate the portable deployment artifacts
bun run src/cli.ts validate-contract --file module.contract.json
bun run src/cli.ts validate-profile --contract module.contract.json --file module.profile.json
```

Run `bun run src/cli.ts --help` for the full usage text.
