# Conformance tests to add

Cross-impl behavior is pinned by two shared suites:

- **`spec/cases/*.json`** — evaluator conformance, run by **all four** impls
  (TS, Rust, Go, Python).
- **`spec/parse-cases/*.json`** — shorthand parser conformance, run by **TS +
  Rust** (Go/Python have no parser).

Several features landed in TS (sometimes Rust) with **only impl-local unit
tests**. Promoting them to the shared suites will make the un-ported
implementations **fail loudly** — which is the point: the failures become the
port checklist in `todo/impl-feature-parity.md`.

## Evaluator cases (`spec/cases/`) — new files/entries

### Module scope

No spec cases exist today; coverage is TS-only in
`typescript/test/module-scope.test.ts`. Add cases (the plan explicitly wants
these in the _shared_ suite, not TS-only, since module scope makes the
collisions common):

- top-level constant read via `$var`; a top-level function reading a top-level
  constant; constant depending on another constant (`SIZE: mul(W, H)`);
- dead constant never evaluated; `$var` cycle detected;
- stdlib shadowing by a module binding;
- inner-binder shadowing (param/local `W` masks module `W`, incl. nested);
- Lisp-2 asymmetry (module _constant_ `map` vs module _function_ `map`);
- module function passed by name as a value (`$var` and `&` forms);
- entry validation (unknown entry, non-function entry, stdlib-colliding entry).
  Source of the matrix: `plans/module-scope.md` (Testing section).

Blocked on a harness change: the current runners only call `callFunction(body,
args, registry)`, which has no module frame or entry concept and can't represent
top-level constants. Testing these needs a new case variant, e.g.
`{ "module": {...}, "entry": "name", "args": [...] }`, that dispatches to
`callProgram` instead — implemented in all four runners (TS/Rust/Go/Python).

### New stdlib builtins

Every new builtin (see `todo/new-features.md`: `sum`, `unique`, `zip`, `take`,
`drop`, `count`, `sqrt`/`pow`, `replace`, `padStart`, `repeat`,
`startsWith`/`endsWith`, default `sort`) needs a `spec/cases` entry added
alongside the four-impl implementation.

## Parser cases (`spec/parse-cases/`) — new entries (TS + Rust)

- **`cond` requires `else ->`** — a negative parse case, once the policy lands
  in both parsers (parity item 6).
- **Bare reference / `&`-optional** value-position cases, to keep both parsers
  aligned with `docs/shorthand-spec.md` §4/§5.
- **Printer round-trip**: the print suite is TS-only
  (`typescript/test/print-spec.test.ts`); once the Rust printer lands (parity
  item 4), run the same cases against it.
