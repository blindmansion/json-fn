# Conformance tests to add

Cross-impl behavior is pinned by two shared suites:

- **`spec/cases/*.json`** — evaluator conformance, run by **all four** impls
  (TS, Rust, Go, Python).
- **`spec/parse-cases/*.json`** — shorthand parser conformance, run by **TS +
  Rust** (Go/Python have no parser).
- **`spec/validation-cases/*.json`** — portable artifact and linking validation
  vectors. TypeScript currently runs them; every runtime that implements
  contracts/profiles should consume the same JSON vectors.

Several features landed in TS (sometimes Rust) with **only impl-local unit
tests**. Promoting them to the shared suites will make the un-ported
implementations **fail loudly** — which is the point: the failures become the
port checklist in `todo/impl-feature-parity.md`.

## Portable validation cases (`spec/validation-cases/`)

These files describe cross-runtime **structural validation**, not TypeScript
unit-test fixtures. They cover:

- `contracts.json` — versioned environment-contract structure and stable
  validation code/path results;
- `deployment-profiles.json` — live/durable profile structure and contract
  effect-subset checks;
- `schema-fragments.json` — the portable schema dialect;
- `module-linking.json` — contract/module composition, reserved bindings, and
  definition collisions.

Ports should keep the case format language-neutral and compare the expected
`valid`, `code`, and `path` fields. Add vectors whenever a portable artifact
rule changes; implementation-specific exception text is not a shared contract.

Structural acceptance does not establish **behavioral adapter conformance**.
Future shared vectors need an executable host harness to compare exact function
and effect binding, direct-entry versus task-entry execution, argument/result
contract timing, omitted-effect behavior, live `UnhandledEffectError`
classification, and durable inline/suspending outcomes. Keep those future
behavioral vectors separate from `spec/validation-cases/`: the existing suite
must remain runnable without native adapter implementations.

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

## Parser cases (`spec/parse-cases/`) — new entries (TS + Rust)

- **`cond` requires `else ->`** — a negative parse case, once the policy lands
  in both parsers (parity item 6).
- **Bare reference / `&`-optional** value-position cases, to keep both parsers
  aligned with `docs/shorthand-spec.md` §4/§5.
- **Printer round-trip**: the print suite is TS-only
  (`typescript/test/print-spec.test.ts`); once the Rust printer lands (parity
  item 4), run the same cases against it.
