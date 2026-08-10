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
- **2b — strict reads** (queue: `null-on-miss`, 11 findings, plus the
  computed-key cases). Each null-on-miss case either deletes or rewrites
  to the error identity / an explicit `$else` arm, whichever the case was
  teaching; computed-key cases move to the single-key rule (an evaluated
  array key errors). The migration experience here feeds the
  null-defaulting revisit criterion in [`status.md`](status.md).
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
