# Plan: conformance assembly (Stage 2 chunk 2g)

Status: **chunk plan**, 2026-08-09. Owns [`plan.md`](plan.md) Stage 2 chunk
2g. The spec text for 2a–2f has landed in `spec-v2/docs/`; this chunk
migrates `spec-v2/cases/` to it and pins the printer/normalizer round-trip
rules and hash vectors once, for the whole stage — the step that makes
Stage 2 a single format break. The delete/rewrite/add lists below are
assembled from the "2g inherits" sections of
[`strict-let.md`](strict-let.md), [`strict-reads-2b.md`](strict-reads-2b.md),
[`capture-closures-2c.md`](capture-closures-2c.md),
[`param-surface-2d.md`](param-surface-2d.md), and
[`boolean-conditions-2e.md`](boolean-conditions-2e.md), sized against a
structural audit of the corpus as copied from v1.

Working posture:

- The corpus is a **product** of the landed spec text. Expectations are
  hand-derived from `spec-v2/docs/`; there is no v2 implementation to
  regenerate against, and none is waited for.
- The audit script `typescript/scripts/audit-spec-v2-cases.ts`
  (`bun run audit:spec-v2-cases` from `typescript/`) is both the **work
  queue** and the **progress gate**: each category below is a structural
  query over the case JSON, each migration stage drives its categories to
  zero, and `--gate <ids>` turns that into an exit code. Deliberate
  post-migration negative cases (e.g. "reports `$sig` as an unknown field")
  are recorded in the script's `ALLOWLIST` so the gate stays meaningful.
- Every pass ends with `bun run validate:spec-cases spec-v2` and
  `bun run format:spec-cases` green. The check-suite schema
  (`spec-v2/cases/check.schema.json`) is updated in the same pass as the
  cases it constrains.
- The v1 corpus (`spec/cases/`) is untouched throughout.

## Baseline audit (2026-08-09, corpus as copied from v1)

| category | chunk | kind | findings | files |
| --- | --- | --- | --- | --- |
| `sig-in-body` | 2d | mechanical | 309 | 37 |
| `fields-descriptors` | 2d | mechanical | 58 | 8 |
| `allow-untyped-functions` | 2d | mechanical | 4 | 3 |
| `array-path-get` | 2b | mechanical | 20 | 5 |
| `truthiness-suite` | 2e | delete | 1 | 1 |
| `nonbool-literal-condition` | 2e | review | 2 | 2 |
| `nonbool-literal-operand` | 2e | review | 16 | 3 |
| `null-on-miss` | 2b | review | 11 | 2 |
| `substituted-closure-expectation` | 2c | review | 13 | 5 |
| `lazy-forcing-wording` | 2a | review | 16 | 12 |

Two shape facts make the mechanical tier safe to script: `$sig` is
perfectly uniform (305 `required/optional/returns` nodes plus 4 with
`rest`; nothing else), and `$fields` entries come in six shapes (bare
string; `$field`+`$optional`; `$field`+`$default`; bare `$field`; and two
deliberately malformed negative-case entries). The `$get`/`$from` spelling
itself survives 2b — 167 nodes keep their syntax; only the 20 array-path
nodes and the miss expectations change.

The review categories are heuristics, not proofs: `nonbool-literal-*`
catches only *literal* non-boolean positions (a non-boolean `$var` or
`$call` needs type reasoning), and `lazy-forcing-wording` over-flags
(e.g. type-level recursion cycles in `check/modules/recursive-types.json`
are untouched by 2a). They are triage queues; every flagged case resolves
to delete, rewrite, or keep-with-justification.

## Stage A — tooling baseline

Done with this plan: the audit script is landed and wired as
`audit:spec-v2-cases`, and the baseline above is recorded. No case files
change.

## Stage B — mechanical bulk passes

Scripted structural transforms with no semantic judgment; behavior
expectations that were correct before each pass remain correct after it.
Ordered so that everything later reads in the final Stage 2 vocabulary —
the `$sig` pass goes first because nearly every check case embeds one.

1. **Delete `allowUntypedFunctions`** (4 findings): the `options` schema
   field in `check.schema.json`, the option cases in
   `check/locals/recursion.json` and `check/modules/declarations.json`,
   and — verify, likely already done with the 2d spec text — the concept's
   remnants in `spec-v2/docs/conformance/checking.md`. Resolved in
   [`status.md`](status.md): the missing-annotation error is single-policy.
2. **`$sig` inlining** (309 nodes, 37 files). Positional zip:
   `$sig.required[i]` becomes `$type` on the i-th slot (a bare string slot
   becomes `{ "$param": name, "$type": schema }`; a `true` schema leaves
   the slot bare), `$sig.optional[i]` attaches to the corresponding
   `$optional`/`$default` descriptor, `$sig.rest: S` becomes
   `{ "$param": "...name", "$type": { "type": "array", "items": S } }`
   (v1 stored the element schema; the new `$type` stores the array type as
   written), and `$sig.returns` becomes the body's `$returns` (omitted when
   `true`). Untouched: `$fnType` expected-type shapes — the
   `required/optional/returns` interface description survives 2d. In
   `parse/` suites only the expected canonical JSON transforms; shorthand
   input keeps its typed-signature spelling. The script must **flag, not
   rewrite**, any case whose `expected.diagnostics` mention `$sig` or
   alignment — those are Stage C hand work (the alignment-error class is
   unexpressible after 2d and those cases delete or become
   missing-annotation/derivation cases).
3. **`$fields` lowering** (58 nodes, 8 files). Per the lowering pinned in
   `spec-v2/docs/language/json/functions.md`: the pattern slot becomes the
   reserved `__p<i>` name and a body-top `$let` of projections — bare
   field → `{ "$get": f, "$from": {"$var": "__p<i>"} }`; `$optional` →
   the same with `"$else": null`; `$default: e` → `"$else": e`. The two
   malformed negative-case entries (`extra` key, `$param` key) are flagged
   to the Stage C queue — their diagnostics assert descriptor-form
   validation that no longer exists.
4. **Array-path `$get` unfolding** (20 nodes, 5 files): a path array
   unfolds to a nested single-key `$get` chain, innermost segment first.
   Cases *asserting* array-path behavior (rather than merely using it)
   delete instead — 2b removes the form; the audit pointers make the
   distinction reviewable one by one.

Exit gate:

```
bun run audit:spec-v2-cases -- --gate sig-in-body,fields-descriptors,allow-untyped-functions,array-path-get
```

plus schema validation and format checks green. The transform scripts are
one-shot (Stage B artifacts, not maintained tooling); each emits its
flagged-for-hand-review list before writing anything.

**Done 2026-08-09** via `typescript/scripts/migrate-spec-v2-stage-b.ts`
(one-shot; kept for the record) plus hand edits for pass 1. Gate, schema
validation, and format checks green; the `checking.md` remnant check found
the docs already clean. Outcomes beyond the plan's letter, all listed in the
script's report:

- **Flags (23 cases, left byte-identical, allowlisted per file for Stage C).**
  Besides the anticipated alignment set (`check/functions/signatures.json`
  #3–#5/#7–#8) and the two malformed `$fields` entries, the flag rules caught:
  diagnostics whose *paths* point into `$sig` (`check/locals/captures.json`
  #5, `check/modules/references.json` #0/#1/#4/#5 — mechanical path rewrites
  to `$params[i].$type`/`$returns`, deferred as flagged); eval errors
  asserting pattern-specific identities that 2b/2d replace
  (`eval/destructured-params.json` #3/#5–#10,
  `eval/strict-parameter-runtime.json` #8 — miss/non-object/missing-argument
  identity changes); and pattern validation the lowering makes inexpressible
  (`eval/parameter-defaults.json` #21–#25 — duplicate-binding and
  descriptor-form cases; duplicates across a pattern and a positional slot
  become ordinary `$let` shadowing, so those likely move to parse suites or
  delete).
- **`true` schemas stay explicit** (`$type: true` / `$returns: true`, 12
  case sites) instead of the planned drop-when-`true`: a `$sig`-carrying body
  was "declared" in v1, and dropping them would demote named functions and
  concrete lambdas to partially annotated, changing checker expectations —
  Stage B's correctness-preservation premise wins over the cosmetic rule. No
  parse case is affected (typed shorthand never produced `true` schemas).
  Stage C may hand-tighten these to real types where it touches the files.
- **Array-path deletes (5)**: `eval/property-access.json` "path access walks
  nested structure", "path with array index", "missing path segment returns
  null", "dot notation: missing intermediate returns null" (path-walk miss
  short-circuit is gone with the form; the single-key null-on-miss queue
  covers the rest, shrinking it 11 → 9), and "folded paths validate each
  segment against its current target" (unfolded, it duplicates "object access
  rejects a numeric key"). The `parse/property-access.json` "collapses"
  description is reworded to the nested-chain wording.

## Stage C — semantic triage, per chunk

Hand work over the review-category queues, in the stage's dependency order.
Each flagged case resolves explicitly; expectations are re-derived from the
landed spec text, and error cases pin the error identities those texts fixed.

- **2a — strict `$let`** (queue: `lazy-forcing-wording`, 16 findings).
  Delete unforced-error-suppression, demand-order, and forcing-based cycle
  cases (`eval/let-regressions.json`, `eval/safety-limits.json`,
  `check/locals/guards-and-lazy.json`); rewrite binding-cycle errors to the
  schedule-stall identity ([`strict-let.md`](strict-let.md) rule 3);
  explicitly keep the flagged non-2a cases (type-level recursion,
  `$default` laziness — the one surviving lazy construct).

  **Done 2026-08-10.** Queue clear; gate, schema validation, and format
  checks green. Outcomes beyond the plan's letter:

  - The unforced-error-suppression case (`eval/let-regressions.json` #0) was
    rewritten in place to the strict-failure expectation rather than
    deleted, covering Stage D's "erroring unreferenced binding" add early.
  - The `eval/safety-limits.json` cycle cases keep their error strings —
    the v1 renderings coincide with the rule-3 identity, including the
    stalled-prefix case (`x, a, b, c` reports `b -> c -> b`) — so they were
    kept with schedule-stall comments rather than deleted. The checker's
    static cycle report (`check/locals/recursion.json`) now pins the same
    evaluator rendering ("Circular variable dependency detected: …"),
    replacing v1's "Circular local type dependency".
  - `check/locals/guards-and-lazy.json` #1 was kept, not deleted: the
    landed checker text retains use-site checking of value bindings
    (`expressions.md` "checked wherever it is referenced", `narrowing.md`
    "facts at the point where that binding is used"), so its expectations
    stay and only the creation/forcing vocabulary was rewritten.
  - The audit regex does not match "forcing", so two stale cases outside
    the queue were caught and re-derived by hand: `cost/consumed-fuel.json`'s
    binding-force vector (same total, 9 — the binding region folds into the
    body region) and `check/programs/chess.json` #12. `cost/static-regions.json`
    #3 re-derived to the folding rule (body 3 + binding 2 → one region of 5).
  - Chess (#12, #21) got wording-only fixes to the use-site vocabulary; the
    full rewrite stays with the Programs pass. Note for that pass and
    [`status.md`](status.md): use-site checking means a checked program can
    still fail at runtime on eager binding evaluation — chess #21
    (`upper(move.from)` bound outside the null guard) is now exactly the
    authoring-pattern break `strict-let.md` documents, blessed by the
    checker but erroring under strict evaluation whenever `from` is null.
  - Allowlisted survivors, justified in the audit script:
    `check/locals/recursion.json` and `eval/safety-limits.json` (cycle
    wording is accurate — cycles survive as schedule stalls),
    `check/modules/recursive-types.json` (type-level recursion),
    `eval/parameter-defaults.json` (`$default` laziness, including the
    default-spanning cycle case #6 — the forcing-cycle identity for the one
    surviving lazy construct carries over; the v2 docs pin field-default
    cycles but are silent on positional-default cycles, a gap for
    [`status.md`](status.md)).
- **2b — strict reads** (queue: `null-on-miss`, 11 findings, plus the
  computed-key cases). Each null-on-miss case either deletes or rewrites
  to the error identity / an explicit `$else` arm, whichever the case was
  teaching; computed-key cases move to the single-key rule (an evaluated
  array key errors). The migration experience here feeds the
  null-defaulting revisit criterion in [`status.md`](status.md).

  **Done 2026-08-10.** Queue clear (9 findings after Stage B's array-path
  deletes); gate, schema validation, and format checks green. Outcomes
  beyond the plan's letter:

  - No computed-key case existed to rewrite: every dynamic `$get` key in
    the corpus evaluates to a string or an integer. The stale key-validity
    identities were the two fractional-index cases in
    `eval/property-access.json`, which now pin the single-key rule's
    rendering — "evaluated $get key must be a string or an integer",
    uniform across target kinds — replacing the per-container
    "indices must be integers" wording (that wording survives for valid
    keys of the wrong kind for the target, e.g. a string key on an array).
  - The corpus now pins the miss renderings the landed docs fix only at
    identity-component level: `Missing key "z": the target is an object
    with keys "a"` (empty containers render "an empty object"),
    `Index 99 out of range: the target is an array of length 3` /
    `a string of length 2`, with negative indices pinning the same
    rendering.
  - Seven queue cases rewrote to the bare-miss error — including both
    inherited-property cases (`eval/property-access.json` #49,
    `eval/special-object-keys.json` #6), which keep their own-key teaching
    by erroring where a prototype-chain read would produce a value — and
    two to the `$else` arm (the duplicate dot-notation missing-key case
    and the `$var` string miss), covering the absence-as-a-case side.
  - The Stage B flags in `eval/destructured-params.json` (#3, #5–#10) and
    `eval/strict-parameter-runtime.json` (#8) resolved here, since their
    replacement identities are exactly this chunk's: the remaining
    `$fields` bodies lowered by hand, a required-field miss is the
    object-miss error naming the key, non-object pattern arguments error
    at the field projection with the ordinary access identities, and the
    pattern-specific "Missing object-pattern argument" becomes the plain
    missing-required-argument identity. Both allowlist entries removed;
    `eval/parameter-defaults.json` #21–#25 stay flagged (pattern-form
    validation is 2d triage, not access identity).
  - Caught outside the queue by a checker sweep:
    `check/expressions/objects-and-arrays.json`'s union-arm projection
    ("absent arms contributing null") re-derived to the `$else: null`
    nullable lookup, typing `integer | null` per the checker rule. The
    narrowing suites' reads are all guarded or on required fields and
    stand unchanged.
  - Decision 2's datapoint, recorded in [`status.md`](status.md): zero
    `if isNull(…)` rewrites — every miss case resolved to an error
    identity or a local `$else` arm. Stage D still owes the systematic
    adds (per-container misses, `$else` laziness and present-`null`
    preservation, the invalid-key error for an evaluated array key,
    `hasKey` narrowing, the optional-field bare-read checker error, the
    tuple bound, the fold-site regression, cost vectors).
- **2c — capture closures** (queue: `substituted-closure-expectation`, 13
  findings in `eval/curry.json`, `eval/scoping.json`,
  `eval/let-regressions.json`, `eval/comments.json`,
  `eval/property-access.json`). Expected function values rewrite from
  substituted bodies to byte-identical bodies plus `$captures` records;
  cases predicated on substitution (raw-marking/rehydration) delete.
- **2e — boolean conditions** (queues: `truthiness-suite`,
  `nonbool-literal-condition`, `nonbool-literal-operand`). Delete
  `check/narrowing/truthiness.json` whole; rewrite the conditionals eval
  suite, `check/expressions/branches.json`'s value-returning `$and`/`$or`
  typing cases, and the guard/branch check suites to boolean conditions
  and boolean results; sweep `$if`/`$cond`/`$and`/`$or` positions the
  literal heuristic cannot see (non-boolean-typed `$var`/`$call`
  conditions) during the same file-by-file pass.
- **Programs**: `check/programs/chess.json` is rewritten once here, after
  the four sweeps, since it intersects every category.

Exit gate: `--gate all` reports the review categories clear (with any
deliberate survivors allowlisted and justified in the allowlist entry).

## Stage D — additive coverage

New hand-authored cases from the chunk plans' "add" lists, grouped by
suite. Written after Stage C so they land in migrated files.

- `check/narrowing/`: `$else`-arm typing (`T | typeof(else)` collapse,
  `?? null` as nullable lookup); `hasKey` narrowing; the optional-field
  bare-read error; exact boolean narrowing (`boolean` ⇒ `true`/`false`,
  the boolean discriminant, the named-guard fallback) plus the
  admitted-`any` runtime-error case.
- `check/` (functions/expressions/contracts): per-slot typing and the
  missing-annotation error; interface-derivation cases (contract-entry
  satisfaction, `$fnType` value compatibility, task-entry mapping);
  condition-type checker rule (`boolean` and `boolean | null` rejection).
- `eval/`: dependency-order vectors (error selection, `tap` order); strict
  failure of an erroring unreferenced binding; value-position vs
  call-position sibling-function cycles; the dynamic-reference TDZ error;
  module entry-closure cases; per-container in-range reads and misses;
  `$else`-arm laziness, absence-only firing, and present-`null`
  preservation; lowering-shape runtime cases (non-object pattern argument,
  required-field miss naming the key, field-default static cycle); the
  non-boolean error per position in 2e's inventory, including a
  predicate-callback result; short-circuit-before-validation; escape
  idempotence; resolution-order cases (record tier vs module entry vs
  builtin; group-internal by-name application; value-vs-open-body entry
  selection); multi-shot resume sharing one record.
- `cost/`: `$let` region folding and the narrowed default-force event;
  path-unfolding region constants; capture-record materialization (the D2
  named vector: per-iteration closure creation charges per iteration;
  hydrated application charges re-entry 1); the annotated-vs-bare
  fuel-identity vector; the boolean short-circuit fuel-unchanged vector.

## Stage E — vectors and round-trip pinning

The step that seals the format break; done once, after the corpus is
otherwise stable.

- **Hash vectors** (`hash/` suite): 2c rule 7's list — simple value
  capture; nested closure (record entry that is itself a record-carrying
  function value); self-recursive escape (open-body self entry); mutual
  group; captured value beside a `$default` — plus 2d's typed-slot and
  `$returns` shapes, and the body byte-identity property (a function
  value's body subtree encodes byte-identical to normalized source).
  `scripts/generate-hash-cases.ts` is bound to the v1 implementation;
  either extend a standalone canonical-encoding script against
  `spec-v2/docs/runtime/hashing.md` (the encoding is mechanical and does
  not need an interpreter) or hand-pin — decide at the point of work.
- **Printer/normalizer round-trip rules**: the fold-back conditions from
  2c ($captures as local-binding form) and 2d (pattern-slot fold-back,
  inline-type printing), stated once for the whole stage, with `parse/`
  round-trip cases exercising them.

## Stage F — audit and close-out

- The `examples/` corpus audit rides here (all three chunk plans point at
  it): expect near-zero 2b breakage, invisible 2d migration modulo the two
  documented deltas, and 2e breakage concentrated in `||` defaulting and
  bare `if x` null checks. The outcome feeds the two revisit criteria
  recorded in [`status.md`](status.md) — the null-defaulting surface and
  the field-default re-projection fallback.
- Final `--gate all` run clear; `validate:spec-cases` and
  `format:spec-cases` green; the audit script survives as a cheap
  regression guard (its mechanical categories double as "no stale v1
  shapes reintroduced" checks) until the v2 implementation's test suite
  takes over.
- [`plan.md`](plan.md) Stage 2 marks complete; [`status.md`](status.md)
  picks up anything the migration surfaced (the two revisit criteria, plus
  whatever Stage C triage exposes).
