# Plan: inline tests, assertion builtins, and the testing toolchain

Status: proposed; drafted 2026-08-05. Design-phase document — no
backwards-compatibility constraint. Sits alongside the headless-IDE work:
several deliverables here are runner/tooling specifications rather than
language semantics, and are marked as such.

Add a first-class inline `test` declaration that lowers to a distinguished
`$tests` module key excluded from program identity; a small family of
general-purpose assertion builtins with structured failure payloads; pure
seeded pseudorandom builtins; a runner-injected test prelude for effect
mocking; and spec'd, implementation-portable report formats for failures,
coverage, and fuel. Everything beyond that — fixtures, mocks, generators,
snapshot recording, test migration — is deliberately userspace or tooling.

## Motivation

Agents write many tests, quickly, and act on test output mechanically. The
language's existing properties are unusually well shaped for this, and the
design should exploit them rather than bolt on a conventional test framework:

- **Purity and determinism** (including deterministic fuel) mean a test's
  outcome is a pure function of the module and the builtins. There is no
  flake, no ordering sensitivity, no hidden environment. A test result is
  cacheable data.
- **Environment-selected entry points** mean a test runner is just another
  environment. Tests do not need `main` wiring, registration, or discovery
  conventions — the runner selects them as roots.
- **Static dependency structure** (flat modules, analyzable `$var`/`$call`
  references) means every binding has a computable dependency closure. Tests
  can be bound to subjects, invalidated precisely, and checked for vacuity.
- **Canonical normalization and hashing** provide stable identity for
  modules, bindings, values, and (below) tests — enabling content-addressed
  test-result caching and formatting-invariant coverage.
- **`handle` with multi-shot resume** is already a complete mocking
  mechanism; what remains is packaging its awkward patterns, not adding
  power.
- **One module per program, no imports** means tests can only live
  in-module. This matches the intended inline (Zig-like) authoring style and
  makes stripping a structural operation instead of a build-system feature.

Why not pure userspace (a `test_*` naming convention over ordinary
bindings)? Four concrete failures:

1. Named functions must be fully typed, so every convention-test pays
   `() -> null` signature boilerplate and returns a fake value.
2. Tests must not perturb `jfn:module:v1` (deployment identity should be
   invariant under adding/removing tests). A convention forces the
   normalizer to pattern-match binding names, which entangles program
   identity with a naming scheme.
3. Ordinary test bindings are unreferenced from any entry, so the checker
   has no principled reason to treat them as roots; a distinguished form
   gives the checker an explicit root set to typecheck without the tests
   being entries.
4. Subject binding (which test exercises which function) has nowhere to
   live, and it is the enabler for targeted runs, invalidation, coverage
   attribution, vacuity detection, and signature-change migration.

## Design

### 1. The `test` declaration

Shorthand grammar (module level, alongside bindings and `type`
declarations):

```text
testDecl := "test" [subjectName] [stringName] ["prop"] [propParams] "=>" body
propParams := "(" ident ":" "integer" ")"
```

- `subjectName` is an optional bare identifier naming a module function the
  test exercises. It must resolve to a module binding whose literal value is
  a function.
- `stringName` is an optional string literal. At least one of subject or
  name must be present. The pair `(subject, name)` must be unique per
  module; an unnamed test's name defaults to `""`.
- `prop` marks a property test. Its body is a one-parameter function of an
  integer seed supplied by the runner; the parameter is declared in
  `propParams`. Non-`prop` tests take no parameters.
- `body` is a **function body**, not a bare module-binding expression: an
  expression with an optional trailing `where`. This is deliberate — the
  dominant multi-assertion pattern is an array literal with a trailing
  `where` for setup, and it must not require parentheses. (Coordinate with
  [`module-where-blocks.md`](module-where-blocks.md): the `test` form takes
  the `parseBody()` path regardless of how that plan resolves plain module
  bindings.)
- A test body's implied signature is `() -> any` (`(integer) -> any` for
  `prop`). The completion value is discarded; a test passes iff evaluation
  completes without a hard error and without an escaped effect (§5).

Examples:

```jfn
test balanceOf "missing account reads zero" =>
  assertEq(balanceOf(seedBooks.ledger, "acc_zoe"), 0)

test apply "overdraft declines and logs" => [
  assertEq(out.ledger["acc_bob"].balance, 0, "balance untouched"),
  assert(includes(out.log, "decline: acc_bob lacks 25"))
] where {
  out: apply(seedBooks, { tag: "withdraw", from: "acc_bob", amount: 25 })
}

test run prop "balance equals sum of deposits" (seed: integer) =>
  assertEq(out.ledger["acc_ada"].balance, sum(amounts) + 100) where {
    amounts: randInts(splitSeed(seed, "amounts"), 20, 1, 500),
    txs: map((a) => { tag: "deposit", to: "acc_ada", amount: a }, amounts),
    out: booksWith(txs)
  }
```

Sequencing note: because arrays evaluate their elements in order and
assertion builtins hard-error on failure, an array literal is the assertion
sequence. No statements or `do` blocks are required for pure tests.

### 2. Lowering: the `$tests` module key

Tests lower to a `$tests` object at the module root, a sibling of `$types`.
Each entry keys `subject ++ "/" ++ name` (subjectless tests key `"/" ++
name`) to a closed object:

```json
{
  "$tests": {
    "balanceOf/missing account reads zero": {
      "subject": "balanceOf",
      "kind": "unit",
      "body": {
        "$sig": { "required": [], "optional": [], "returns": true },
        "$params": [],
        "$return": { "...": "..." }
      }
    },
    "run/balance equals sum of deposits": {
      "subject": "run",
      "kind": "prop",
      "body": {
        "$sig": { "required": [{ "type": "integer" }], "optional": [], "returns": true },
        "$params": ["seed"],
        "$return": { "...": "..." }
      }
    }
  }
}
```

- `subject` is absent for subjectless tests. `kind` is `"unit"` or
  `"prop"`.
- Test bodies are ordinary function bodies in module scope: they may
  reference any module binding, type, injected `effects` leaf, and builtin.
  They introduce no new scoping rules.
- Bare `$`-key restrictions already reserve the namespace; `$tests` joins
  `$types` as a structural module key, not a binding.

### 3. Identity and hashing

- **`jfn:module:v1` excludes `$tests`.** Program normalization deletes the
  key before hashing, exactly as contract-derived bindings are excluded
  today. Adding, editing, or removing tests never changes deployment
  identity.
- A new domain **`jfn:tests:v1`** identifies the normalized `$tests` object
  of a module.
- Each individual test has a derivable identity: the `jfn:value:v1` hash of
  its normalized entry. Runners key results by the triple
  `(test hash, subject-closure hash, builtins hash)`, where the
  subject-closure hash covers the normalized bodies of every module binding
  in the test body's static dependency closure. This is the content-addressed
  test cache: editing one function re-runs only tests whose closure changed,
  and structurally identical tests dedupe by construction.
- `jfn:module-artifact:v1` retains `$tests` (it is pre-normalization
  provenance).

Stripping tests for deployment is therefore: delete `$tests`, then
optionally delete bindings unreachable from the entry. The checker/IDE
classifies bindings reachable only from `$tests` as test-only (fixtures)
and reports rather than errors them.

### 4. Assertion builtins

New general-purpose builtins (registry entries, conformance cases, and
catalog docs like any other builtin — they are not test-scoped, matching
the `$nonnull` / `checked as` precedent of runtime-checked assertions):

- `assert(cond: any, msg?: string) -> null` — hard error unless `cond` is
  truthy.
- `assertEq(actual: any, expected: any, msg?: string) -> null` — structural
  equality (same relation as `==`); on failure, hard error carrying a
  structured payload with the **first divergent path**:

  ```json
  {
    "code": "ASSERTION_FAILED",
    "op": "assertEq",
    "path": ["ledger", "acc_bob", "balance"],
    "expected": 0,
    "actual": -25,
    "message": "balance untouched"
  }
  ```

  Path elements are object keys (strings) and array indices (integers).
  Divergence order: for objects, the lexicographically least diverging key
  by UTF-16 code units (aligned with canonical key order); for arrays, the
  least diverging index, with length mismatch reported at the shorter
  length. The payload truncates `expected`/`actual` leaves under the
  existing value-size limits.

- `fail(msg: string) -> never` — unconditional hard error.
- Optional, low priority: `assertHash(value: any, address: string) -> null`
  — asserts the `jfn:value:v1` address of `value`. Compact impl-portable
  golden tests; tooling fills the address in record mode. Deferrable: a
  hash mismatch carries no diff information, so inline `assertEq` remains
  the recommended default.

Assertion failures are **hard errors, not `raise`**: they are meta-level
claims with source positions, must halt the test unconditionally, and must
not be interceptable by the code under test's own handlers. Testing that
code _raises_ needs no new surface — it is a total `handle` over the raise
channel, packaged in the prelude (§6).

The structured payload is required, not advisory: agent loops act on
`path`/`expected`/`actual` mechanically, and the payload shape gets
conformance cases. Prose message text remains implementation-defined.

### 5. Runner execution model (tooling spec)

The test runner is an environment. Normative behavior, specified so all
implementations report identically:

- Tests run with **zero capabilities**: no contract functions, no live
  effects. An effect that escapes all in-test handlers fails the test with
  a distinguished `EFFECT_ESCAPED` report carrying `{ name, args }`. All
  effect testing therefore goes through `handle` — hermeticity by
  construction, aligned with the capability-contract model.
- A test passes iff its body (applied to the runner-chosen seed, for
  `prop`) evaluates to completion. The completion value is discarded; if it
  is a task, completing _as a value_ is fine, but note the zero-capability
  rule applies only to effects actually performed, and building a task
  performs nothing.
- `prop` tests run over a runner-chosen seed set (default: a contiguous
  range, size configurable). A failure report is the failing seed; replay
  is that one integer; sharding is seed-range partitioning.
- Tests run under the standard execution limits. Per-test fuel is reported
  (§7). Runners may set a per-test `maxFuel` default distinct from
  production profiles.
- Failure reports use one closed JSON shape:
  `{ test, subject?, kind, seed?, outcome, error?, fuel }` where `outcome ∈
{ "pass", "fail", "error", "effect-escaped" }` and `error` carries the
  assertion payload or evaluation error. Exact schema to be pinned with a
  `spec/cases/`-style suite.

### 6. Test prelude (injected json-fn, tooling spec)

The runner injects a small library of json-fn bindings into module scope,
the same mechanism by which a contract injects `effects`. Reserved
namespace: bindings under a single `test` object (name reserved in
test-linked modules, like `effects` in contract-linked ones). Contents are
ordinary pure json-fn — no evaluator support:

- `test.expectRaise(t: Task<any>) -> any` — total handler returning the
  raise payload; `fail`s if the task completes normally.
- `test.runMock(t: Task<any>, script) -> { result, calls, unused }` —
  scripted sequential replies per effect name (`"*"` for
  answer-null-passthrough), with full call capture:

  ```jfn
  m: test.runMock(greetTwice(), {
    "io.readLine": ["ada", "bob"],
    "io.print": "*"
  })
  // m.calls == [ { name: "io.readLine", args: [] },
  //              { name: "io.print", args: ["hi ada"] }, ... ]
  ```

  Internally this is the state-passing handler
  (`handle … returns (S) -> R with …`). It is fully expressible in
  userspace today; the prelude exists because the pattern is the single
  most fumble-prone piece of effect testing, and packaging it removes the
  need for any new language surface for mocks.

- Later, without spec changes: generator combinators over the seeded PRNG,
  integrated shrinking, effect-script generators.

The prelude ships in `spec/` as json-fn source with its own conformance
cases, so every implementation's runner injects identical semantics.

### 7. Seeded pseudorandom builtins

Pure, deterministic, seed-first, **batch-style** (no seed threading in
user code, which is the ergonomic trap):

- `splitSeed(seed: integer, key: string) -> integer` — derive an
  independent stream.
- `randInts(seed: integer, n: integer, lo: integer, hi: integer) ->
integer[]` — n uniform integers in `[lo, hi]`.
- `randFloats(seed: integer, n: integer) -> number[]` — n uniform floats in
  `[0, 1)`.
- `shuffle(seed: integer, xs: any[]) -> any[]`.
- `sample(seed: integer, xs: any[], k: integer) -> any[]` — without
  replacement, `k <= length(xs)`.

Constraints and rationale:

- Ambient randomness is ruled out; a `random` _effect_ is ruled out for
  tests (it would make test outcomes host-dependent). Seeded purity keeps
  the "test result is a pure function of module + builtins" invariant, and
  makes property tests replayable and shardable by a single integer.
- Bit-exact cross-implementation behavior is mandatory and gets
  `spec/cases/builtins` coverage. Preferred construction: derive the stream
  from **SHA-256**, which the spec already requires for hashing — e.g.
  counter-mode digests over a canonical `[seed, key?, counter]` encoding,
  consuming digest bits into values. This reuses an existing conformance
  surface instead of speccing a new bit-twiddling algorithm in a language
  whose numbers are float64 (values and seeds stay within the 53-bit safe
  integer range; the uniform-int and float derivations must be specified
  exactly, including rejection sampling for range uniformity).
- These are general-purpose builtins (simulations, sampling, load
  generation in modules), not test-only; they simply make property testing
  fall out.

### 8. Coverage (tooling spec)

No language changes. A spec'd, implementation-portable report so agents get
identical feedback everywhere:

- Node identity: `(jfn:module:v1 address, binding name, node path)` over the
  **normalized** program — formatting-invariant, diffable across runs and
  implementations. `$tests` bodies are attributed under their test key.
- The primary metric is **arm coverage**: per function, which `if` branches,
  `cond` arms, `match` cases (including `else`), and handler clauses were
  never taken, as a machine-readable list. Expression-level node coverage is
  secondary.
- **Vacuity check**: a subject-bound test that evaluates no node of its
  subject's body is flagged (`VACUOUS_TEST`). Cheap given per-test
  instrumentation, and it catches the common agent failure of asserting on
  fixtures or mocking the subject away.
- Report schema pinned like other conformance artifacts.

### 9. Fuel reports, not fuel assertions

Because fuel is deterministic, per-test fuel is an exact, portable number:
the runner reports it per test and the IDE diffs it over time —
noise-free performance regression testing. Explicitly **rejected for now**:
an in-language `metered()` builtin or fuel assertions. Making fuel
observable in-language would promote the fuel schedule to program
semantics and freeze the ability to retune it. Revisit only if runner-side
reports prove insufficient.

### 10. Enabled downstream (non-normative)

Subject binding + typed signatures + tests-as-data make signature-change
migration a tooling feature with no further spec surface: the runner
detects a changed subject signature via closure hashes, mechanically
migrates trivial cases (appended optional/defaulted parameters, arity-safe
reorders — calls are positional and typed), and hands the remainder to an
agent as `{ old signature, new signature, test JSON }` with re-typecheck as
the verification gate. Nothing in this plan needs to change to support it.

## Alternatives considered

- **Naming-convention tests in userspace.** Rejected; see Motivation
  (signature boilerplate, module-hash entanglement, no checker roots, no
  subject binding).
- **Zig-style positional adjacency as the subject binding.** Rejected:
  module bindings are order-independent, so adjacency has no semantic
  anchor. Adjacency remains a formatting convention; the subject is
  explicit.
- **Assertion failure as `raise`.** Rejected: interceptable by the code
  under test's handlers, loses the hard-error/source-position channel, and
  conflates domain errors with meta-level claims.
- **Stream-style PRNG (`rand(seed) -> [value, nextSeed]`).** Rejected as
  the primary API: seed threading through pure code is exactly the
  ergonomic failure mode agents hit; batch APIs plus `splitSeed` cover the
  cases. A stream API can be prelude-derived later if needed.
- **`describe`/nesting.** Rejected: flat `(subject, name)` identity;
  grouping is an IDE presentation concern.
- **Snapshot files.** Rejected: no imports and one-module programs make
  external snapshot storage a new artifact class; inline expected values
  (best diagnostics) and `assertHash` (compact) cover the space.

## Implementation steps

1. Spec: `$tests` module form in `docs/language/json/modules.md`; shorthand
   grammar and lowering in the shorthand reference; normalization exclusion
   and `jfn:tests:v1` in `docs/runtime/hashing.md`.
2. Builtins: registry entries for `assert`, `assertEq`, `fail`, `splitSeed`,
   `randInts`, `randFloats`, `shuffle`, `sample`; pin the SHA-derived PRNG
   construction; conformance cases including assertion payload shapes and
   PRNG bit-exactness (`spec/cases/builtins`).
3. TypeScript impl: parser/printer for the `test` form (via `parseBody()`),
   checker root handling for `$tests` (typecheck bodies, `prop` seed
   parameter, subject resolution, test-only reachability classification),
   normalization changes, builtins.
4. Runner: zero-capability execution, seed driving, failure/fuel report
   schemas, prelude injection (`test.expectRaise`, `test.runMock`) with
   prelude source and cases under `spec/`.
5. Coverage instrumentation in the tree-walker; report schema; vacuity
   check.
6. Docs: testing section in `guides/writing-jfn.md`; a
   `docs/testing/` runner-and-report reference.

## Acceptance criteria

- A module with tests and one without them, otherwise identical, produce
  the same `jfn:module:v1` address; the former's tests hash under
  `jfn:tests:v1`.
- `test` declarations round-trip shorthand ⇄ JSON, including trailing
  `where` bodies without parentheses.
- Checker: test bodies typecheck against module scope; unknown subject or
  non-function subject is a static error; test-only fixtures are
  classified, not errored.
- Assertion builtins pass shared cases, including exact divergent-path
  payloads.
- PRNG builtins are bit-exact across implementations per shared cases.
- Runner: escaped effects fail with `EFFECT_ESCAPED`; a failing `prop`
  reports a seed whose single-seed replay reproduces the failure; results
  are cacheable and cache-correct under the
  `(test, subject-closure, builtins)` key.
- Coverage reports are identical across implementations for the same
  module and test set; the vacuity check flags a subject-bound test that
  never enters its subject.

## Open questions

- **Effectful subjects and contract linkage.** Should test bodies of a
  contract-linked module see the injected `effects` namespace (building
  tasks is pure, so yes by default), and should the runner offer an opt-in
  scripted implementation of _contract_ effects wholesale (a
  contract-shaped mock), or is per-test `handle` always the boundary?
- **`prop` parameter generality.** Single integer seed now; later versions
  might allow typed generated parameters
  (`(txs: Tx[] from genTxs)`) once prelude generators exist. Does the
  lowered form reserve room (e.g. `kind: "prop"` plus a params array) now?
- **Failure-payload value truncation.** Exact truncation rule for large
  `expected`/`actual` leaves in assertion payloads — reuse the value-size
  limit machinery or define a smaller report bound?
- **`assertHash` inclusion.** Ship in the first cut or defer until record
  mode exists in the IDE?
- **Test names in diagnostics.** Should evaluation errors inside a test
  body prefix the `(subject, name)` key in the standard error rendering, or
  is that runner-report-only?
- **Unused-binding policy.** Confirm checker policy that module bindings
  reachable only from `$tests` warn/classify rather than error, and that a
  binding reachable from nothing (not even tests) remains reportable.
