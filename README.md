# json-fn

json-fn is a pure JSON expression language — programs are plain JSON values evaluated by a tree-walking interpreter. Every expression is valid JSON, making programs trivially serializable, inspectable, and portable across languages.

## Language

See [docs/language.md](docs/language.md) for the full language reference.

## Conformance Tests

The [spec/cases/](spec/cases/) directory contains language-agnostic test suites as JSON files. Each file defines a suite of test cases with inputs and expected outputs. Every implementation should pass all of these.

## Examples

The [examples/](examples/) directory contains complete programs written in json-fn (`.jsonc` files), including a tic-tac-toe game with minimax AI and a chess engine.

## Implementations

| Language | Directory | Package | Status |
|----------|-----------|---------|--------|
| TypeScript | [typescript/](typescript/) | `json-fn` (npm) | Complete |
| Go | `go/` | — | Complete |
| Python | [python/](python/) | `json-fn` (PyPI) | Complete |
| Rust | [rust/](rust/) | `jsonfn` (crates.io) | Complete |

Each implementation lives in its own directory with its own build config and can be published independently.
