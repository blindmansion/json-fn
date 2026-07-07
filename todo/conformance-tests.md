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

### P4 name resolution

No spec cases today; coverage is TS-only in
`typescript/test/p4-name-resolution.test.ts`. Add cases:

- param shadows operator (`{ f:(add,x)=> x+1 }`, `f(sub,10)`);
- param shadows stdlib in direct call (`{ f:(map)=> map(2) }`);
- param shadow survives an escaping closure (`{ f:(map)=> (x)=> map(x) }`);
- `where`-local shadows (`length`, `add`);
- local recursion / mutual recursion still green (canary);
- bare registry name value (`{ f:()=> length }` ⇒ `"length"`; `map(length,xss)`);
- bare-name shadowing (local `length` wins in value position);
- `length.foo` still errors (path guard);
- non-function local `add: 5` still uses stdlib `add`.
  Source of the matrix: `plans/p4-name-resolution.md` §7 / §8 step 4.

### New stdlib builtins

Every new builtin (see `todo/new-features.md`: `sum`, `unique`, `zip`, `take`,
`drop`, `count`, `sqrt`/`pow`, `replace`, `padStart`, `repeat`,
`startsWith`/`endsWith`, default `sort`) needs a `spec/cases` entry added
alongside the four-impl implementation.

## Parser cases (`spec/parse-cases/`) — new entries (TS + Rust)

- **Trailing `where`** on `cond`/`match` arms, `if/then/else` branches,
  `where`-binding values, and inside parenthesized groups — pins the TS parser
  behavior and flags the Rust gap (parity item 5).
- **`cond` requires `else ->`** — a negative parse case, once the policy lands
  in both parsers (parity item 6).
- **Bare reference / `&`-optional** value-position cases, to keep both parsers
  aligned with `docs/shorthand-spec.md` §4/§5.
- **Printer round-trip**: the print suite is TS-only
  (`typescript/test/print-spec.test.ts`); once the Rust printer lands (parity
  item 4), run the same cases against it.
