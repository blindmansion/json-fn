# Execution Limits Redesign (Plan)

Status: proposal / not yet implemented.

This document describes the strategy for resource limits in json-fn, the flaws in
the current design (including a confirmed sandbox-escape "op-bomb"), a redesigned
limit model, and — critically — how the language-agnostic conformance spec and
its runners must change so the new guarantees are actually enforced across all
four implementations (TypeScript, Go, Python, Rust).

There is **no backward-compatibility constraint**: we are free to change the
limit semantics, the host API, and the spec case schema.

---

## 1. Background: the op-bomb

`maxOperations` is intended as a total-work budget that stops runaway or
malicious programs. Today it is incremented in exactly one place — once per AST
node visited in `evaluateExpression`:

- TypeScript: `typescript/src/evaluate.ts` (the `context.state.operations` bump)
- Go: `go/evaluate.go` (`ctx.state.operations++`)
- Python: `python/src/jsonfn/evaluate.py` (`self._operations += 1`)
- Rust: `rust/src/eval.rs` (`ctx.state.operations += 1`)

The higher-order builtins (`map`, `filter`, `reduce`, `find`, `some`, `every`,
`sort`, `sortBy`, `groupBy`, `flatMap`, `mapValues`, `apply`, `pipe`,
`reReplaceWith`) iterate **natively** over their input and dispatch each callback
through the internal call path (`callFunctionInternal`), which increments call
**depth** but never **operations**. When the callback is a pure builtin (a string
name like `"neg"` or `"add"`), the dispatch lands in the external-call path and
skips `evaluateExpression` entirely.

Confirmed empirically (TS, `maxOperations = 1000`):

| Program | Counted ops | Actual builtin calls | Limit enforced? |
| --- | --- | --- | --- |
| `map("neg", range(5_000_000))` | 4 | 5,000,001 | No |
| `reduce("add", 0, range(5_000_000))` | 5 | 5,000,001 | No |
| honest recursion (control) | 1001 | 249 | Yes (threw) |

The amplification is effectively unbounded (raise `N` and it runs for minutes
while the counter reads ~4). The same structural gap exists in all four
implementations. `range(N)` additionally allocates an `N`-element array from a
tiny literal — a memory bomb that is also invisible to the meter.

---

## 2. Current strategy and its assumptions

Three knobs, threaded through a shared context with mutable counters:

- **`maxCallDepth`** — per function invocation; guards host stack overflow.
- **`maxOperations`** — per AST node; intended to bound total work.
- **`signal` / cancel** — cooperative cancellation, checked at each node.

Implicit assumptions:

1. **Uniform cost per node** — one node ≈ one constant unit of work.
2. **All work flows through `evaluateExpression`** — that node visit is the only
   chokepoint through which meaningful work passes.
3. **CPU time is proportional to the operation count.**
4. **Memory is not a modeled resource** — nothing caps value/array/string sizes.

Assumptions (1) and (2) are false:

- (2) is violated by every host builtin. HOF callback dispatch and pure-builtin
  calls do real work off the metered path — this is the op-bomb.
- (1) is violated even for a single node: `range(n)`, `concat`, `flatten`, `sort`
  (n·log n comparisons), large-string `split`/`upper`/`join`, and regex
  (catastrophic backtracking) are each one counted operation but O(n) or worse.
- (4) means allocation-based DoS is entirely unbounded.

Root cause: the meter counts **interpreter node-visits**, but attacker-controlled
work partly lives on the **other side of the host-function boundary**, where cost
is neither uniform nor metered.

---

## 3. Proposed design

Guiding principle: **every unit of attacker-controllable work must pass through a
metered chokepoint, and the charge must be proportional to actual work.**

Model the *distinct* resources separately instead of overloading one counter.

### 3.1 Stack depth — keep `maxCallDepth`

Correctly placed and correct in intent. No change beyond renaming for
consistency (optional).

### 3.2 CPU / work — a "fuel" (gas) model charged at every chokepoint

Rename the concept to **fuel** and charge it in three places, all decrementing a
single shared budget:

1. **Per AST node** in `evaluateExpression` (as today) — control-flow cost.
2. **Per function invocation** in `callFunctionInternal` — this single addition
   closes the pure-builtin and HOF-dispatch leak, because every callback dispatch
   now costs at least 1 fuel regardless of whether it re-enters
   `evaluateExpression`.
3. **Proportional to input size inside size-sensitive builtins** — each such
   builtin declares a **cost function** of its inputs and charges it before/after
   executing (see the canonical cost model below). This is what makes
   `range(n)`, `concat`, `sort`, `map`, `reduce`, string, and regex ops honest.

The cleanest architectural enforcement point for HOFs is the `call` closure
handed to builtins: builtins should iterate through a metered helper (or the
interpreter should charge `len(array)` fuel before dispatching), so no callback —
JSON body or pure builtin — can outrun the meter.

### 3.3 Memory / size — a new, separate budget

Add limits independent of fuel, e.g.:

- `maxValueSize` — max length of any produced array / string (bounds `range`,
  `concat`, `flatten`, `split`, `join`, `repeat`-like ops).
- Optionally `maxAllocation` — cumulative budget of allocated
  elements/characters across the whole run, to stop many-medium-allocations.

Without this, no amount of CPU metering stops allocation bombs, and it also
bounds the deep clone performed on the external-call boundary.

### 3.4 Wall-clock deadline — coarse backstop (host-only, NOT conformance)

Correlating any instruction count to real time is fundamentally fragile. A
monotonic-clock **deadline**, checked at the same yield points as the cancel
signal *and* inside long-running builtin loops, is the most robust ultimate
ceiling. The existing cancel/`signal` plumbing already provides the mechanism.

This is inherently **non-deterministic** and therefore **cannot be a conformance
case** — it is an implementation-level safety feature only. The spec must say so
explicitly.

### 3.5 Default posture

Decide explicitly whether limits are opt-in (today's default is unlimited) or
safe-by-default with an explicit `unlimited` opt-out. If json-fn is meant to run
untrusted programs, safe-by-default is the correct posture. (Recommend
safe-by-default with generous ceilings.)

---

## 4. The canonical cost model (normative)

For conformance to assert anything portable, **all four implementations must
charge identical fuel for identical programs.** The cost model therefore becomes
part of the spec, not an implementation detail.

Finalized canonical charges. Every charge decrements the single shared fuel
budget; a program's cost is the sum over all chokepoints it triggers.

| Chokepoint | Fuel charged |
| --- | --- |
| Evaluate any AST node (`evaluateExpression` entry) | 1 |
| Invoke any function — JSON body or host builtin (`callFunctionInternal` entry) | 1 |
| `map`/`filter`/`find`/`some`/`every`/`flatMap`/`mapValues`/`groupBy`/`sortBy` | `len(input)` surcharge (each callback dispatch is *additionally* charged 1 by the invoke chokepoint) |
| `reduce` | `len(input)` surcharge |
| `sort` | `len(input)` surcharge (comparisons dominate; `len` is the floor) |
| `range(n)` | `n` |
| `concat` / `flatten` | element count of the output |
| string builtins (`split`, `join`, `upper`, `lower`, `trim`, `strcat`, `reverse` of a string) | output length |
| regex (`reTest`/`reMatch`/`reMatchAll`/`reReplace`/`reSplit`/`reReplaceWith`) | input string length (hard-capped; see §7) |

Notes:

- The two base charges (node + invoke) are the load-bearing fix: charging on the
  **invoke** chokepoint is what makes HOF callback dispatch and pure-builtin
  calls cost fuel, closing the op-bomb.
- The size surcharges make single O(n) nodes honest so `range`/`concat`/`sort`
  cannot be one-fuel work amplifiers.
- The table is **normative**: all four implementations MUST charge identically so
  `expectedFuel` anchor cases (§5.3) agree to the integer.

### 4.1 Canonical error messages

Conformance matches on substrings, so the messages only need a stable prefix:

- Fuel exhaustion: `Maximum fuel limit of {N} exceeded` (substring: `Maximum fuel`).
- Value-size exceeded: `Maximum value size of {N} exceeded` (substring:
  `Maximum value size`).

Size limits (`maxValueSize`) are deterministic by construction and directly
portable.

---

## 5. Spec format changes (conformance)

### 5.1 Current schema

A spec case (see `spec/cases/*.json`) today supports:

```jsonc
{
  "description": "...",
  "body": <expression>,
  "args": [ ... ],           // optional
  "functions": { ... },      // optional
  "limits": { "maxCallDepth": N, "maxOperations": N },  // optional
  "expected": <value>        // OR
  "error": "<substring>"
}
```

Runners: `typescript/test/run-cases.ts`, `go/spec_test.go`,
`python/tests/test_spec.py`, `rust/tests/spec.rs`.

Limits are currently only a passthrough, and assertions are limited to
`expected` value or `error` substring.

### 5.2 New `limits` fields

Extend the `limits` object (all optional):

```jsonc
"limits": {
  "maxCallDepth": N,
  "maxFuel": N,          // total work budget (replaces the old maxOperations)
  "maxValueSize": N      // new: max produced array/string length
}
```

There is no external consumer, so `maxOperations` is removed outright rather than
aliased — the TypeScript implementation and all spec cases use `maxFuel`. As each
of the other implementations is ported (§6), its runner switches from
`maxOperations` to `maxFuel` in the same step.

Wall-clock deadline is intentionally **not** part of the spec schema (§3.4).

### 5.3 New assertion mechanisms

Two complementary mechanisms, added to the case schema:

**(a) Threshold assertions (primary, robust).** Because the canonical cost model
guarantees identical fuel across implementations, a program has a single, shared
rejection threshold. Author cases as pairs on the *same* body:

```jsonc
// must be rejected at a tight budget
{ "description": "op-bomb via map is metered — rejected",
  "body": { "$return": { "$fn": ["map", "neg", { "$fn": ["range", 100000] }] } },
  "limits": { "maxFuel": 1000 },
  "error": "Maximum fuel" },

// must succeed with an adequate budget
{ "description": "same program completes under an adequate budget",
  "body": { "$return": { "$fn": ["map", "neg", { "$fn": ["range", 100000] }] } },
  "limits": { "maxFuel": 500000 },
  "expected": [ /* ... */ ] }
```

This is the decisive op-bomb regression test: pre-fix the first case *passes*
(returns a value) instead of erroring, so it fails conformance; post-fix it
errors as required.

**(b) Exact-fuel assertions (optional, for anchor cases).** To lock the cost
model down precisely, add an optional field checked against a reported counter:

```jsonc
{ "description": "range(10) costs exactly N fuel",
  "body": { "$return": { "$fn": ["range", 10] } },
  "limits": { "maxFuel": 1000 },
  "expectedFuel": 22   // exact; must match across all four implementations
}
```

This requires each implementation to **expose consumed fuel** from its public
API (a returned stat or an out-param on the call function). Use exact-fuel only
for a small set of anchor cases that pin the canonical model; rely on threshold
pairs for breadth (they are robust to minor cost-table revisions).

### 5.4 Runner changes (all four)

For each runner:

1. Parse the new `limits` fields (`maxFuel` + `maxValueSize`), replacing the old
   `maxOperations` parsing. This touches:
   - TS: the `ExecutionLimits` mapping in `run-cases.ts` (already structural).
   - Go: `ExecutionLimits` struct tags used by `spec_test.go`.
   - Python: the `maxFuel`/`maxValueSize` → kwargs mapping in `test_spec.py`.
   - Rust: `LimitsSpec` in `spec.rs` (add `serde` fields + map into
     `ExecutionLimits`).
2. If a case has `expectedFuel`, call the fuel-reporting API and assert the
   returned count equals the expected value (exact integer compare).
3. Keep the existing `expected` / `error` behavior unchanged.

### 5.5 New conformance suites

Add spec suites under `spec/cases/`:

- `fuel-limits.json` — fuel metering, including:
  - the op-bomb via each HOF (`map`/`filter`/`reduce`/`find`/`some`/`every`/
    `sort`/`flatMap`/`groupBy`/`sortBy`/`apply`/`pipe`/`reReplaceWith`) with a
    **pure-builtin** callback, asserted to be rejected at a tight budget and to
    succeed at an adequate one (threshold pairs);
  - nested-HOF amplification (`map` of `map`);
  - pure-builtin-callback dispatch charged (the exact leak);
  - a few `expectedFuel` anchor cases (`range`, `concat`, a simple call chain).
- `memory-limits.json` — `maxValueSize` rejections:
  - `range(hugeN)` rejected;
  - `concat` / `flatten` producing an oversized array rejected;
  - large-string builtins rejected;
  - matching sub-limit cases that succeed.

The existing `safety-limits.json` cases stay; their limit cases already use
`maxFuel` and assert the `Maximum fuel limit of N exceeded` message.

---

## 6. Implementation phases

1. **Spec first. (DONE)** Canonical cost model (§4) finalized in this doc;
   `spec/cases/fuel-limits.json` + `spec/cases/memory-limits.json` added. The
   rejection ("must error") cases are intentionally **red** on the current
   implementations (they return a value because `maxFuel`/`maxValueSize` are not
   yet enforced), which proves the suites catch the op-bomb. The `expectedFuel`
   anchor cases are deferred to phase 3 when runners can read consumed fuel.
2. **Reference implementation (TypeScript). (DONE)** Fuel is charged per node
   (`evaluateExpression`) and per call (`callFunctionInternal`), plus size
   surcharges: HOFs charge `len(input)` via a `Meter` passed to builtins, and
   size-growing host results (`range`, `concat`, `flatten`, string builtins,
   ...) are charged/guarded centrally in `callExternalFunction` /
   `accountForResult`. `range` guards + charges *before* allocating.
   `maxValueSize` bounds produced array/string length. Consumed fuel is exposed
   via an optional `usage` object on `ExecutionLimits`. `maxOperations` is removed
   outright (no alias). The op-bomb PoC is now blocked in ~0ms and both new suites
   are green (full TS suite: 506 pass / 0 fail). Note: builtin size surcharges are
   charged atomically, so `usage.fuel` may overshoot `maxFuel` on a *rejected*
   run; completing runs report exact fuel.
3. **Port to Go, Python, Rust.** Mirror the exact cost model; replace each impl's
   `maxOperations`/operation-counter with the fuel model and `maxValueSize`, and
   update each runner to parse the new fields and check `expectedFuel`. All four
   must produce identical fuel counts on the anchor cases.
   - **Go. (DONE)** `ExecutionLimits` now exposes `MaxFuel`, `MaxValueSize`, and
     an optional `Usage *ExecutionUsage`; `MaxOperations` is removed. Fuel is
     charged per node (`evaluateExpression`) and per call
     (`callFunctionInternal`); size surcharges are threaded through a `*Meter`
     passed to builtins (HOFs charge `len(input)`, `flatMap` guards its output),
     and pure-builtin results are charged/guarded centrally via
     `accountForResult`. `range` became a builtin so it guards + charges before
     allocating. Because the Go runner reads limits from JSON with
     case-insensitive field matching, the new `maxFuel` / `maxValueSize` spec
     fields map onto the struct with no runner change. All three limit suites
     (fuel, memory, safety) are green and the op-bomb is blocked.
   - **Python, Rust.** Still pending — same mirroring work.
4. **Add the wall-clock deadline** as a host-only backstop in each impl
   (not spec-tested).
5. **Cleanup.** Update docs (`docs/language.md`, per-impl READMEs) and the host
   API docs in the top-level `README.md` to the fuel model.

---

## 7. Open questions

- Exact fuel numbers for the anchor cases (finalize the §4 table).
- Whether `sort` should charge `n·log n` (accurate) or `n` (simpler floor);
  accurate is safer against sort-based amplification.
- Regex cost: charge by input length only, or attempt a backtracking-aware bound?
  A hard input-length cap plus the wall-clock backstop is likely sufficient.
- Default posture: opt-in vs safe-by-default ceilings (§3.5).
- API shape for reporting consumed fuel in each language (return value vs
  out-param vs stats object) — must be ergonomic in all four.
```
