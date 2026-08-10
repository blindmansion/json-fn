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

  **Done 2026-08-10.** Queue clear; gate, schema validation, and format
  checks green. Outcomes beyond the plan's letter:

  - Nine of the thirteen queue cases rewrote to record shapes (unrewritten
    bodies plus `$captures` value entries; `curry.json` #11/#12 also pin
    that the by-name module call `curryApply` is *not* captured). The other
    four were already record-correct — `let-regressions.json` #3's open-body
    entry and #7's by-name module call, and the two `scoping.json` shadowing
    cases whose bodies have no free variables — and took wording only
    (substitution vocabulary out, empty-record-omission comments in).
  - Zero deletes: the corpus has no raw-marking/rehydration case and none
    asserting captured values in expression position. A `$return`-keyed
    sweep confirmed the flagged 13 are the complete set of expected
    function values (nothing hides from the `$params` heuristic as a
    zero-parameter value).
  - The audit heuristic was re-pointed at 2c's testable claim: instead of
    flagging every expected function value, it flags one whose body (node
    minus `$captures`/`$runtimeContract`) is not byte-identical, under
    canonical key-sorted encoding, to a subtree of the case's source
    material. The category clears with no allowlist entries, the gate run
    machine-checks the rewrites' byte-identity, and reintroduced substituted
    output would flag again — the guard survives.
  - Checker sweep caught the v1 record-payload assertions outside the
    queue: `check/locals/captures.json` #4 flipped from "non-function
    capture value is malformed" to a legal value entry (the record holds
    values, not only function bodies), and
    `check/functions/body-structure.json`'s malformed-`$captures` message
    drops "of function bodies", matching the rendering the null/array/scalar
    cases already pin. The record-entry cases in `check/locals/captures.json`
    #0, `check/locals/inline-calls.json`, and `check/locals/guards-and-lazy.json`
    stand — records in checker input keep v1's posture (validated and
    resolvable, though invalid in authored source), and their entries are
    valid open-body shapes.
  - Riding along: `check/locals/captures.json`'s Stage B `$sig` flag
    resolved (the deferred mechanical rewrite — `$returns` annotations,
    diagnostic paths onto `$returns`), removing the file's `sig-in-body`
    allowlist entry.
  - `eval/escaping-closures.json` (behavioral call-through expectations,
    untouched by the format break) got wording-only updates from
    re-attachment vocabulary to open-body record entries.
- **2e — boolean conditions** (queues: `truthiness-suite`,
  `nonbool-literal-condition`, `nonbool-literal-operand`). Delete
  `check/narrowing/truthiness.json` whole; rewrite the conditionals eval
  suite, `check/expressions/branches.json`'s value-returning `$and`/`$or`
  typing cases, and the guard/branch check suites to boolean conditions
  and boolean results; sweep `$if`/`$cond`/`$and`/`$or` positions the
  literal heuristic cannot see (non-boolean-typed `$var`/`$call`
  conditions) during the same file-by-file pass.

  **Done 2026-08-10.** Queues clear; gate, schema validation, and format
  checks green. Outcomes beyond the plan's letter:

  - `truthiness.json` deleted whole, but five of its cases survive the
    form change in substance and re-homed to a new
    `check/narrowing/boolean-subject.json` (narrowing.md form 1): the
    boolean `true`/`false` pins, the field-path condition (retyped to a
    boolean field), and the boolean-discriminant then/else pair — Stage
    D's exact-boolean-narrowing adds, covered early. The `T | null`,
    falsy-slice, always-truthy-discriminant, and inferred-type cases died
    with the form.
  - The conditionals eval suite's twelve `$and`/`$or` cases rewrote in
    place, pinning several Stage D adds early: the arity rejections
    (empty and singleton, both forms — `$and must be an array of at least
    two expressions`), the non-boolean-operand error identity, and the
    short-circuit-before-validation case (`$and: [false, "never
    validated"]` → `false`). The pass fixes the operand rendering family
    the docs left at identity-component level:
    `$and operand 2 must be a boolean; got string` — positions 1-based
    (matching "parameter position 1"), kinds the JSON value kinds. The
    `$if`/`$cond`-condition and predicate-callback renderings are still
    unpinned; Stage D's per-position error adds owe them.
  - `branches.json`'s value-returning typing cases became the
    checker-surface pins: per-operand static rejection (diagnostics with
    `expected: {type: boolean}`), boolean result synthesis (literal
    operand types are *not* folded to a literal result, matching the
    `$if` posture of widening literal branch results), the nullable-`$or`
    defaulting idiom as the loud static error D4 wants, and the
    admitted-`any` backstop case (another Stage D add covered early). The
    empty-`$and`/`$or` typing cases deleted — the arity constraint is
    structural and the eval rejections pin it. Two conditions the literal
    heuristic could not see rewrote: the `string | null` truthiness
    thread (#3, now a `neq` guard) and the integer `$cond` guard (#10,
    now a boolean param).
  - The corpus sweep (bulk-reviewed by subagent) caught four sites beyond
    the queues: `builtins/logic/not.json`'s truthiness-coercion cases
    (now boolean-only rejections pinning `argument must be a boolean`,
    the builtins-suite rendering family beside `and`/`or`'s existing
    `arguments must be booleans`); `check/locals/guards-and-lazy.json`'s
    function-typed shadow condition (#4 now also pins the
    condition-position diagnostic); `check/narrowing/guards.json`'s
    no-fact fallback (re-derived to the boolean-subject fallback — a
    `length(xs) > 0` local observed against a const-`true` return); and
    the parse suite's dead-idiom examples (`cached || fallback checked as
    Count` and `cached || compute(x)` renamed to boolean readings,
    `handle` #6's description narrowed to the parse claim, and
    control-flow #2's object-literal condition rewritten to
    `state == { ready: true }` — expected JSON verified byte-identical
    against the v1 parser, which stays authoritative since 2e changes no
    grammar). Everything else with a non-literal condition verified
    boolean-typed.
  - The 2e audit heuristics were re-pointed at the live claim, the 2c
    precedent: literal non-booleans past a deciding operand (or behind a
    literal-`true` `$cond` arm) are dead — neither evaluated nor
    validated — and cases that pin the boolean-position rejection (an
    eval `error` naming it, or a checker diagnostic expecting
    `{type: boolean}`) keep their reached literal as the teaching. Both
    categories clear with **no allowlist entries**, and a reintroduced
    value-returning expectation would flag again.
  - `check/programs/chess.json`'s truthiness cases (#13 named-guard
    `$cond`, #14 bare-`$let` fallback on `integer | null`) are
    deliberately untouched — the Programs pass owns the file's single
    rewrite.
- **Programs**: `check/programs/chess.json` is rewritten once here, after
  the four sweeps, since it intersects every category.

  **Done 2026-08-10.** Gate, schema validation, and format checks green;
  no new allowlist entries. The file's rewrite resolved the four deferred
  cases; everything else verified clean against the sweeps (conditions
  boolean-typed, reads on required fields, no expected function values):

  - #12 (`pieceMoves`) rewrote to the strict-`$let` migration idiom
    writing-jfn.md documents: the `upper(piece)`/`lower(piece)` bindings
    move into the guarded `$else` arm, where the guard's fact is in scope
    for their initializers. The v1 shape — bindings above the guard,
    counting on the null branch never reading them — errors under strict
    evaluation whenever `piece` is null.
  - #21 (`firstGlyphLocal`) keeps the path-fact-at-use-site teaching
    (narrowing.md's transitive-reference sentence) in a strict-safe body:
    the binding is now a plain copy of `move.from` — a required, merely
    nullable read that cannot error eagerly — re-synthesized as `Piece` at
    its guarded use site. The checker-blessed-but-crashing v1 body is
    documented in the case comment, not pinned as a fragment; the sharp
    edge itself is recorded in [`status.md`](status.md).
  - #14 (`localTruthy` → `localDefault`) rewrote from the bare-`$let`
    truthiness fallback to the explicit `neq(h, null)` conditional — 2b/2e's
    landed defaulting idiom — exercising the bare local as a narrowing
    subject even though its initializer is a call result.
  - #13 (`slideDir`) kept byte-identical with a justifying comment: its
    conditions were already boolean locals, and named-guard alias
    composition (`not(ok)` → `ok` → `not(empty)` → `isNull(target)`) plus
    `$cond`'s negation accumulation give exactly the claimed else-arm
    narrowing.
  - #16 (`divergent`) stands: its eagerly erroring binding is a negative
    checker case pinning per-fact-set re-synthesis and deduplication, not
    an authoring model.

Exit gate: `--gate all` reports the review categories clear (with any
deliberate survivors allowlisted and justified in the allowlist entry).
**Met 2026-08-10** with the Programs pass above — Stage C is complete.

## Stage D — additive coverage

New hand-authored cases from the chunk plans' "add" lists, grouped by
suite. Written after Stage C so they land in migrated files.

- `check/narrowing/`: `$else`-arm typing (`T | typeof(else)` collapse,
  `?? null` as nullable lookup); `hasKey` narrowing; the optional-field
  bare-read error; exact boolean narrowing (`boolean` ⇒ `true`/`false`,
  the boolean discriminant, the named-guard fallback) plus the
  admitted-`any` runtime-error case.

  **Done 2026-08-10.** Gate, schema validation, and format checks green.
  Outcomes beyond the plan's letter:

  - The exact-boolean set needed no new cases: verified covered by Stage
    C's early adds (`boolean-subject.json`, `guards.json`'s no-fact
    fallback, `branches.json`'s admitted-`any` operand).
  - `hasKey` narrowing landed as a new `check/narrowing/key-presence.json`
    (six cases): then-branch presence for bare-variable and field-path
    subjects, else-branch field removal on a closed object (observed via
    closed-target assignability), fact flow through a named guard, and
    the two no-fact negatives (non-literal key, non-path subject), each
    observed as the bare-read error surviving the guard. The open-object/
    map else-branch no-fact claim has no clean observable (an open object
    minus the field still fails a closed target), so it has no case.
  - `$else`-arm typing and the bare-read error landed beside the existing
    `$get` typing coverage in `check/expressions/objects-and-arrays.json`
    rather than the narrowing suite — that file already owns read typing.
    Exact `expected.type` pins: `T | typeof(else)` with the literal arm
    widening to its primitive before the join (`integer | string`, not
    `integer | "missing"` — the pinned `$if` branch-join posture carried
    to the arm), the subsumed-arm collapse, and `?? null` as `T | null`.
  - Two stale cases caught and rewritten in place: the optional-field
    pair in `objects-and-arrays.json` still pinned bare optional-field
    reads projecting `T | null`, contradicting the landed checking-reads
    rule. They now pin the bare-read error — message rendering
    `` may be absent; add `?? default` or guard with `hasKey` `` (the
    substring leaves room for the field name), path on the read's `$get`,
    matching the unknown-key precedent — and the `$else`-arm fit of the
    same read.
- `check/` (functions/expressions/contracts): per-slot typing and the
  missing-annotation error; interface-derivation cases (contract-entry
  satisfaction, `$fnType` value compatibility, task-entry mapping);
  condition-type checker rule (`boolean` and `boolean | null` rejection).

  **Done 2026-08-10.** Gate, schema validation, and format checks green.
  Outcomes beyond the plan's letter:

  - This chunk also resolved the deferred Stage B 2d flags, which no
    Stage C sweep owned: `check/modules/references.json`'s four `$sig`
    cases took the mechanical rewrite (dangling-ref diagnostics now
    path onto `$params[i].$type`/`$returns`), and
    `check/functions/signatures.json`'s five flagged cases triaged as
    Stage B anticipated — the alignment-error class is unexpressible, so
    they became descriptor-validation, missing-annotation, and
    lowered-read cases. Three allowlist entries removed; only
    `fields-descriptors eval/parameter-defaults.json` remains, owned by
    the eval pass.
  - The descriptor-validation rendering was re-pinned across `check/`:
    the "A defaulted parameter must contain exactly" identity described
    a grammar where a descriptor required `$default`, and
    `{"$param": name, "$type": schema}` is now valid. The new identity —
    `$params[i]: A parameter descriptor must carry $optional, $default,
    or $type` — is pinned in the five check files that assert it
    (`signatures`, `contracts/entries`, both `contextual-lambdas`,
    `expressions/calls`). `eval/parameter-defaults.json` still pins the
    old family; the eval pass owes the same re-pin there.
  - Missing-annotation adds pin the full-annotation definition with the
    existing "must declare a signature" identity: a named function
    missing only `$returns`, and one with a single untyped slot, are
    each the error (the completely-bare cases were already in
    `declarations.json`/`recursion.json`). Rounding out the per-slot
    rules: the defaulted-local-type case (`$default` slot binds bare
    `T`, beside the existing optional-binds-`T | null` case) and
    `badDefaults` rewritten to `$default`-checked-against-`$type` even
    when no call omits the slot. The lowered-pattern case pins the
    alignment dissolution directly: a projection of a field the slot
    schema leaves optional is the ordinary bare-read error at the
    binding's `$get`.
  - Interface derivation landed as a new
    `check/functions/interface-derivation.json` (six cases): annotated
    lambda satisfaction, the mismatch pinning the **derived** shape as
    the diagnostic's `actual` `$fnType` (counts from `$params`, schemas
    from `$type` — the derivation output is asserted literally),
    `$optional`/`$default` deriving to the same optional position, rest
    element from the array-as-written `items`, a `$fn` reference
    deriving from the named function's annotations, and the pattern
    slot contributing one required position. `contracts/entries.json`
    gained the satisfaction consumers: an annotated entry clean through
    the derivation with the task mapping (`$taskType` completion vs
    `{"task": A}`), the completion mismatch pinned at `$returns`, the
    slot-type mismatch pinned at `$params[0].$type`, and the lowered
    pattern slot satisfying an object-schema entry slot.
  - Condition-type adds in `branches.json`: a `string` `$if` condition
    and a `boolean | null` one (assignability is exact — the nullable
    boolean is the loud error the defaulting migration teaches), the
    `$cond` arm condition at its own `$cond[i][0]` path, and the
    admitted-`any` `$if` condition beside the existing `$and` operand
    case. All pin `expected: {type: boolean}` at the condition path,
    matching the identity `guards-and-lazy.json` already carries.
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

  **Done 2026-08-10.** Gate, schema validation, and format checks green.
  Outcomes beyond the plan's letter:

  - Two suite-format extensions, because two adds were inexpressible: the
    eval schema gained `observations.logs` (the exact ordered logger-call
    sequence, mirroring the builtin suite) so `tap`-order vectors have an
    observable, and the `functions` map widened from function bodies to
    module entries generally, so value entries — and with them the
    entry-closure rule — are expressible (the case body is the selected
    entry).
  - The order/cycle/TDZ adds landed as a new `eval/binding-order.json`
    (ten cases): error selection between independent failures (source
    order) and through a dependency edge (the dependency's error wins),
    `tap` order under reordering and under the source-order tie-break, the
    unreferenced binding's `tap` firing, the call-position/value-position
    sibling-function contrast pair, transitivity through the exempted call
    pinned as a direct self-cycle (`a -> a`), and the dynamic-reference
    error beside its always-safe `$in` counterpart. Settled while writing:
    the rendering `Dynamic reference to binding "b" before it is
    evaluated`. The erroring-unreferenced-binding case needed no add — the
    Stage C 2a sweep had already rewritten `let-regressions.json` #0 to
    it.
  - Module entries landed as a new `eval/module-entries.json` (six cases):
    the closure evaluating before the entry, an outside-closure failing
    entry staying inert (the contrast with `$let` strictness), a
    reference from an untaken branch still evaluating, the closure
    continuing through a called module function, the entry-cycle identity,
    and the module-value-entry-captured-by-value record pin.
  - Reads: `property-access.json` gained the present-`null` bare read, the
    `$else` arm not firing on present `null`, arm laziness on a hit, the
    array-miss and negative-index arm selections, and the fold-site
    regression (the miss identity surviving a `map` callback). In-range
    reads and misses were verified already covered per runtime container
    kind; map/tuple/closed-object/optional-field are checker
    distinctions. That audit surfaced the one 2b add no chunk had owned —
    the tuple literal-index bound — now a checker case in
    `check/expressions/objects-and-arrays.json` beside the closed-object
    unknown-key precedent.
  - Lowering runtime cases: the non-object-argument and
    required-field-miss identities were verified already pinned
    (`destructured-params.json`, from the Stage C 2b sweep); the file
    gained present-`null` suppressing a field default, an absent field's
    erroring default failing the call with the binding never read
    (bind-time, not first-read), and mutually referencing field defaults
    stalling as a static cycle even with both fields supplied.
  - The owed `eval/parameter-defaults.json` work: the old descriptor
    family re-pinned at its three sites plus the top-level-body case that
    had pinned a generic invalid-expression error; two sibling renderings
    settled while writing (closedness — `A parameter descriptor allows
    only $param, $optional, $default, and $type` — and `A rest parameter
    descriptor admits only $type`). The five flagged cases triaged: the
    pattern-vs-positional duplicate rewrote to its lowered meaning — the
    projection is an ordinary `$let` binding shadowing the parameter, a
    positive case — and the four descriptor-form cases deleted, with the
    parameter-list uniqueness rule moving to `parse/destructured-params.json`
    as three parse-error cases (field vs positional, across patterns, vs
    rest). The `fields-descriptors` allowlist entry is removed and the
    category is clear corpus-wide.
  - Boolean positions: `conditionals.json` gained the `$if` condition
    errors (`string`, `null` — the defaulting migration's loud case), the
    reached `$cond` arm-condition error naming `arm 2`, the
    behind-an-earlier-`true` neither-evaluated-nor-validated case, and
    `$or`'s past-the-deciding-operand twin of the existing `$and` case;
    `higher-order.json` gained the predicate-callback result error
    (settled rendering: `filter callback result must be a boolean; got
    number`) and callback validation attaching to evaluation (`find`
    stopping at the first `true`). The `$and`/`$or` operand renderings,
    arity rejections, and logic-builtin argument errors were already
    pinned.
  - Records and resolution order landed as a new
    `eval/capture-records.json` (five cases): escape idempotence through a
    pass-through function, value-vs-open-body entry selection (a member
    both called and taken as a value captures as an evaluated value
    carrying its own record), the applied value's record beating a
    same-named module function, group-internal by-name application
    resolving a sibling through the containing record over a module
    function, and the record beating a builtin. `name-resolution.json`
    gained the module-function-shadows-builtin tier case, and
    `effects-handle.json` the multi-shot resume: one continuation resumed
    twice, both applications reading the same captured value.
  - New allowlist entries, each justified in the audit script: the two
    present-`null` files under `null-on-miss` (a present `null` is a hit —
    the expectation is the rule itself) and the three new/extended files
    whose cycle-and-laziness wording states current rules under
    `lazy-forcing-wording`.
- `cost/`: `$let` region folding and the narrowed default-force event;
  path-unfolding region constants; capture-record materialization (the D2
  named vector: per-iteration closure creation charges per iteration;
  hydrated application charges re-entry 1); the annotated-vs-bare
  fuel-identity vector; the boolean short-circuit fuel-unchanged vector.

  **Done 2026-08-10**, closing Stage D. Gate, schema validation, and format
  checks green; no new allowlist entries (the comments state the current
  rules without tripping the wording heuristics). Every vector derivation
  is spelled out in its case comment, hand-derived from
  `docs/runtime/execution-limits.md` and the language-side cost paragraphs.
  Seven static cases and twelve fuel cases, extending the two existing
  files rather than opening new ones (the suite is organized by vector
  kind, not topic):

  - `$let` folding: the no-boundary case pins a single body region despite
    the `$let` (the existing folding case has builtin boundaries inside).
  - Default force: the static case pins the `$default` expression as its
    own region behind the parameter-default boundary
    (`/$params/0/$default`); the fuel triple pins supplied (region never
    entered, total matches the undefaulted square), omitted-and-read
    (entered once at the first read; the second read adds nothing), and
    omitted-never-read (never entered — whether a default is read is
    value-determined). The bind-time contrast vector runs the lowered
    field default: the absent field enters the `$else` arm region when the
    strict binding evaluates, with `$in` never reading it, and never fires
    default force — the attachment-narrowing observable.
  - Reads: the path-unfolding static case (three `$get` nodes + the
    target, constant 4), the `$else`-arm static case (arm its own region,
    target and key in the containing region), and the hit/miss fuel pair
    (hit fires no event; miss enters the arm by arm selection).
  - Capture records (D2): the static case pins one count per record entry
    in the region containing the function literal (two entries → literal
    1 + 2, creation fires no event); the fuel trio pins local
    creation-and-application (entry charged in-region, ordinary
    invocation, no re-entry), hydrated application (a `$captures`-carrying
    function value arriving in `args` charges re-entry 1; its record's
    cost is not recharged), and the named per-iteration vector (a closure
    created inside a `map` callback charges its entry once per element,
    because each element re-enters the callback's body region).
  - Annotation invariance: the static case pins `$type`/`$returns`
    payloads contributing zero, and the fuel case runs the annotated
    square to the bare square's exact total of 5.
  - Short-circuit charging: the static case pins the further `$and`
    operand as its own region (`/$return/$and/1`); the fuel pair pins the
    deciding-operand stop (second operand neither evaluated nor charged;
    validation is region work, not an event) against the
    continue-by-arm-selection total.

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

  **Done 2026-08-10.** The rule text needed no assembly — the fold-back
  conditions had already landed with the doc rewrites
  (`function-literals-and-local-bindings.md` for the pattern fold,
  `closures.md` for the record rendering) — so the stage reduced to
  vectors and cases.

  - **Hash tooling decision**: the value encoding is unchanged by the
    record shape (function values are ordinary values to the encoder), so
    the vectors are computed by a new one-shot generator,
    `scripts/generate-hash-function-values.ts`, importing
    `canonicalJsonText`/`valueHash` from `src/hashing` and writing
    `hash/function-values.json`. One vector was verified independently
    against the domain-framing rule (`UTF8(D) || 0x0a || P` through
    SHA-256).
  - **`hash/function-values.json`** (new, 9 vectors): empty-record
    omission (the value encodes identically to its source body); the
    curried-add source body and the value it evaluates to, paired so the
    byte-identical `$params`/`$return` subtrees are visible across the two
    canonical texts; a captured call-shaped value as inert record data; a
    nested closure whose record entry is itself record-carrying; the
    self-recursive escape (open-body self entry beside a captured value);
    a mutual group (two open-body entries plus the group's one captured
    value); a `$default` expression reading a record entry; typed slots
    and `$returns` participating in the value's bytes.
  - **`parse/destructured-params.json`**: the annotated pattern slot in
    expression form (annotation as slot `$type`, the three field marks in
    one pattern); rejections for `?`-with-`=` on a field, whole-pattern
    `?`, whole-pattern default; and the reserved `__p<digits>` scheme
    rejected as binder, reference, and `where`-binding name — the
    reservation that makes fold-back unambiguous.
  - **`parse/functions.json`**: partially annotated parameter lists and a
    return annotation over bare params (printer totality for partial
    printing); `?`-with-`=` on a positional slot rejected; the record
    audit rendering parsing back to a body-top eager `$let` of literal
    values (faithful, but not the canonical value shape); an
    expression-shaped record entry parsing back as `$raw`-quoted data.

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
